#!/usr/bin/env node
/**
 * Unity Editor MCP adapter (dependency-free).
 *
 * Bridges Claude Code (MCP stdio) to the `com.unity.editor-mcp` Unity plugin over TCP.
 *
 * Why this exists:
 *   The upstream npm package `unity-editor-mcp@1.3.1` predates the installed
 *   Unity plugin (v0.15.5) which (a) listens on a random loopback port when 6400
 *   is taken and (b) REQUIRES an authToken on every command. The old npm server
 *   does neither, so every command fails with AUTH_FAILED.
 *
 * This adapter instead discovers the live Unity instance from the plugin's
 * instance registry (`~/.unity-editor-mcp/instances/<pid>.json`), reads the
 * port + authToken from it, and forwards commands with proper framing.
 *
 * Environment overrides (all optional):
 *   UNITY_MCP_PROJECT_PATH  - Unity project root to match against registry
 *                             (defaults to process.cwd())
 *   UNITY_MCP_PORT          - force a port (skip registry discovery)
 *   UNITY_MCP_AUTH_TOKEN    - force an auth token (skip registry discovery)
 *
 * Protocol: MCP over stdio = newline-delimited JSON-RPC 2.0 on stdout.
 * All diagnostics go to stderr to keep stdout a clean protocol channel.
 */

import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';

const PROJECT_ROOT = process.env.UNITY_MCP_PROJECT_PATH || process.cwd();
const REGISTRY_DIR = path.join(os.homedir(), '.unity-editor-mcp', 'instances');
const DEFAULT_TIMEOUT_MS = 30000;
const REGISTRY_REFRESH_MS = 5000;

let commandSeq = 0;
let cachedUnity = null;
let lastRegistryCheck = 0;

/* ------------------------------------------------------------------ */
/* Logging - stderr only                                               */
/* ------------------------------------------------------------------ */

function log(...args) {
  console.error('[unity-mcp-adapter]', ...args);
}

/* ------------------------------------------------------------------ */
/* Unity instance discovery via the plugin's registry                  */
/* ------------------------------------------------------------------ */

function normPath(p) {
  if (!p) return null;
  return path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();
}

function discoverUnity() {
  // Explicit overrides bypass the registry entirely.
  const forcedPort = Number.parseInt(process.env.UNITY_MCP_PORT || '', 10);
  if (forcedPort && process.env.UNITY_MCP_AUTH_TOKEN) {
    return {
      port: forcedPort,
      authToken: process.env.UNITY_MCP_AUTH_TOKEN,
      source: 'env',
    };
  }

  if (!fs.existsSync(REGISTRY_DIR)) return null;

  const target = normPath(PROJECT_ROOT);
  let best = null;
  for (const file of fs.readdirSync(REGISTRY_DIR)) {
    if (!file.endsWith('.json')) continue;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(REGISTRY_DIR, file), 'utf8'));
    } catch {
      continue;
    }
    if (!data || typeof data.port !== 'number' || !data.authToken) continue;
    if (target && normPath(data.projectPath) !== target) continue;
    // Prefer the most recently seen instance (multiple Unity windows may exist).
    if (!best || (data.lastSeen || '') > (best.lastSeen || '')) best = data;
  }
  return best;
}

function getUnity(forceRefresh = false) {
  const now = Date.now();
  if (
    forceRefresh ||
    !cachedUnity ||
    now - lastRegistryCheck > REGISTRY_REFRESH_MS
  ) {
    cachedUnity = discoverUnity();
    lastRegistryCheck = now;
  }
  return cachedUnity;
}

/* ------------------------------------------------------------------ */
/* TCP command transport to the Unity plugin                           */
/* ------------------------------------------------------------------ */

function sendCommand(type, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const unity = getUnity();
    if (!unity) {
      reject(
        new Error(
          'No running Unity instance found in the MCP registry ' +
            `("${REGISTRY_DIR}"). Open the project in Unity with the ` +
            'com.unity.editor-mcp package installed and its TCP listener running.'
        )
      );
      return;
    }

    const sock = new net.Socket();
    let buffer = Buffer.alloc(0);
    let settled = false;
    const id = 'mcp' + (++commandSeq);

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      fn(value);
    };

    const timer = setTimeout(
      () =>
        settle(
          reject,
          new Error(`Unity command '${type}' timed out after ${timeoutMs}ms`)
        ),
      timeoutMs
    );

    sock.setNoDelay(true);
    sock.connect(unity.port, '127.0.0.1', () => {
      const body = Buffer.from(
        JSON.stringify({ id, type, params, authToken: unity.authToken }),
        'utf8'
      );
      const header = Buffer.alloc(4);
      header.writeInt32BE(body.length, 0);
      sock.write(Buffer.concat([header, body]));
    });

    sock.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const len = buffer.readInt32BE(0);
        if (len < 0 || len > 4 * 1024 * 1024) {
          // Bad frame header - skip a byte and try to resync.
          buffer = buffer.slice(4);
          continue;
        }
        if (buffer.length < 4 + len) return; // wait for the rest of the frame
        const frame = buffer.slice(4, 4 + len).toString('utf8');
        buffer = buffer.slice(4 + len);

        let resp;
        try {
          resp = JSON.parse(frame);
        } catch {
          continue;
        }
        if (resp && resp.id !== undefined && String(resp.id) !== id) continue;
        if (resp && (resp.status === 'success' || resp.success === true)) {
          settle(resolve, resp.result || resp.data || {});
        } else {
          settle(
            reject,
            new Error(
              (resp && resp.error) || 'Unity command failed' +
                (resp && resp.code ? ` [${resp.code}]` : '')
            )
          );
        }
        return;
      }
    });

    sock.on('error', (err) => settle(reject, new Error(`TCP error: ${err.message}`)));
    sock.on('close', () =>
      settle(reject, new Error('Unity connection closed before response'))
    );
  });
}

/* ------------------------------------------------------------------ */
/* Tool registry - mirrors the plugin's CommandHandlers                */
/* ------------------------------------------------------------------ */

const VEC = {
  type: 'object',
  description: '{x, y, z}',
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
    z: { type: 'number' },
  },
};

function tool(name, description, properties = {}) {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties,
      additionalProperties: true,
    },
  };
}

// One item for batch_create_gameobjects — mirrors create_gameobject's params.
const GAME_OBJECT_ITEM = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    primitiveType: { type: 'string' },
    position: VEC,
    rotation: VEC,
    scale: VEC,
    parentPath: { type: 'string' },
    tag: { type: 'string' },
    layer: { type: 'integer' },
  },
};

// One item for batch_instantiate_prefab — mirrors instantiate_prefab's params.
const PREFAB_INSTANCE_ITEM = {
  type: 'object',
  properties: {
    prefabPath: { type: 'string' },
    position: VEC,
    rotation: VEC,
    parent: { type: 'string' },
    name: { type: 'string' },
  },
};

const TOOLS = [
  tool('ping', 'Test the connection to Unity. Returns pong + project info.'),

  tool(
    'get_project_info',
    'Get Unity project metadata: name, path, version, active scene, status.'
  ),

  tool(
    'get_hierarchy',
    'Get the active scene hierarchy. ' +
      'Params: includeInactive (bool, default true), maxDepth (int, default -1 = unlimited), includeComponents (bool, default false).',
    {
      includeInactive: { type: 'boolean' },
      maxDepth: { type: 'integer' },
      includeComponents: { type: 'boolean' },
    }
  ),

  tool(
    'create_gameobject',
    'Create a GameObject. Params: name, primitiveType (Cube|Sphere|Capsule|Cylinder|Plane|Quad|Empty), position {x,y,z}, rotation {x,y,z} (euler), scale {x,y,z}, parentPath (hierarchy path), tag, layer.',
    {
      name: { type: 'string' },
      primitiveType: { type: 'string' },
      position: VEC,
      rotation: VEC,
      scale: VEC,
      parentPath: { type: 'string' },
      tag: { type: 'string' },
      layer: { type: 'integer' },
    }
  ),

  tool(
    'batch_create_gameobjects',
    'Create multiple GameObjects in one call. ' +
      'Params: items = array of object specs, each accepts: name, primitiveType (Cube|Sphere|Capsule|Cylinder|Plane|Quad|Empty; omit for empty GO), position {x,y,z}, rotation {x,y,z} (euler), scale {x,y,z}, parentPath (hierarchy path), tag, layer (0-31). ' +
      'All per-item fields are optional; omitted transform fields default to position 0,0,0 / rotation 0 / scale 1. ' +
      'Returns { summary: {total, succeeded, failed}, results: [{index, status, result|error}] } — per-item success/failure, partial failures do not abort the batch. ' +
      'Example: { items: [{ name: "Rock1", primitiveType: "Cube", position: {x:0, y:0, z:0} }, { name: "Rock2", position: {x:5, y:0, z:0} }] }.',
    { items: { type: 'array', items: GAME_OBJECT_ITEM } }
  ),

  tool(
    'find_gameobject',
    'Find GameObjects by name, tag, or layer. Params: name, tag, layer, exactMatch (bool, default true).',
    {
      name: { type: 'string' },
      tag: { type: 'string' },
      layer: { type: 'integer' },
      exactMatch: { type: 'boolean' },
    }
  ),

  tool(
    'modify_gameobject',
    "Modify an existing GameObject by hierarchy path. Params: path (e.g. '/Cube'), name, position, rotation, scale, active, tag, layer, parentPath.",
    {
      path: { type: 'string' },
      name: { type: 'string' },
      position: VEC,
      rotation: VEC,
      scale: VEC,
      active: { type: 'boolean' },
      tag: { type: 'string' },
      layer: { type: 'integer' },
      parentPath: { type: 'string' },
    }
  ),

  tool(
    'delete_gameobject',
    'Delete GameObjects. Params: path (single hierarchy path) or paths (array).',
    {
      path: { type: 'string' },
      paths: { type: 'array', items: { type: 'string' } },
    }
  ),

  tool(
    'get_gameobject_details',
    'Deep-inspect a GameObject. Params: path, includeComponents (bool).',
    {
      path: { type: 'string' },
      includeComponents: { type: 'boolean' },
    }
  ),

  tool('analyze_scene_contents', 'Scene statistics and analysis.'),

  tool(
    'get_component_values',
    'Inspect a component property. Params: gameObjectName, componentType, componentIndex, includePrivateFields (bool).',
    {
      gameObjectName: { type: 'string' },
      componentType: { type: 'string' },
      componentIndex: { type: 'integer' },
      includePrivateFields: { type: 'boolean' },
    }
  ),

  tool(
    'find_by_component',
    'Find objects by component type. Params: componentType, includeInactive (bool), searchScope (scene|project), matchExactType (bool).',
    {
      componentType: { type: 'string' },
      includeInactive: { type: 'boolean' },
      searchScope: { type: 'string' },
      matchExactType: { type: 'boolean' },
    }
  ),

  tool(
    'get_object_references',
    'Analyze object relationships. Params: gameObjectName, includeAssetReferences (bool), includeHierarchyReferences (bool), searchInPrefabs (bool).',
    {
      gameObjectName: { type: 'string' },
      includeAssetReferences: { type: 'boolean' },
      includeHierarchyReferences: { type: 'boolean' },
      searchInPrefabs: { type: 'boolean' },
    }
  ),

  tool(
    'create_scene',
    'Create a new scene. Params: name.',
    { name: { type: 'string' } }
  ),

  tool(
    'load_scene',
    'Load a scene. Params: path (scene asset path like "Assets/Scenes/Game.unity"), mode (single|additive).',
    {
      path: { type: 'string' },
      mode: { type: 'string', enum: ['single', 'additive'] },
    }
  ),

  tool('save_scene', 'Save the current scene.'),

  tool('list_scenes', 'List all scenes in the project.'),

  tool('get_scene_info', 'Get the active scene details.'),

  tool('play_game', 'Start Unity Play mode.'),
  tool('pause_game', 'Pause (or resume) Play mode.'),
  tool('stop_game', 'Stop Play mode and return to Edit mode.'),
  tool('get_editor_state', 'Get the editor state (edit/play mode, scene info).'),

  tool(
    'find_ui_elements',
    'Find UI elements by element type, name pattern, or tag. Params: elementType, namePattern, tagFilter, includeInactive (bool, default true), includeChildren (bool).',
    {
      elementType: { type: 'string' },
      namePattern: { type: 'string' },
      tagFilter: { type: 'string' },
      includeInactive: { type: 'boolean' },
      includeChildren: { type: 'boolean' },
    }
  ),

  tool(
    'click_ui_element',
    'Click a UI button / interactive element. Params: elementPath, clickType (left|right|middle), holdDuration (float).',
    {
      elementPath: { type: 'string' },
      clickType: { type: 'string' },
      holdDuration: { type: 'number' },
    }
  ),

  tool(
    'get_ui_element_state',
    'Get UI element properties and state. Params: elementPath, includeChildren (bool), includeInteractableInfo (bool), includeInactive (bool).',
    {
      elementPath: { type: 'string' },
      includeChildren: { type: 'boolean' },
      includeInteractableInfo: { type: 'boolean' },
      includeInactive: { type: 'boolean' },
    }
  ),

  tool(
    'set_ui_element_value',
    'Set values for input fields and sliders. Params: elementPath, value, triggerEvents (bool, default true).',
    { elementPath: { type: 'string' }, value: {}, triggerEvents: { type: 'boolean' } }
  ),

  tool(
    'simulate_ui_input',
    'Simulate keyboard and mouse input on UI. Params: inputSequence (array of input strings), waitBetween (float ms), validateState (bool, default true).',
    {
      inputSequence: { type: 'array', items: { type: 'string' } },
      waitBetween: { type: 'number' },
      validateState: { type: 'boolean' },
    }
  ),

  tool(
    'create_prefab',
    'Create a prefab from a GameObject. Params: path, prefabPath.',
    { path: { type: 'string' }, prefabPath: { type: 'string' } }
  ),

  tool('modify_prefab', 'Modify an existing prefab property.'),
  tool(
    'instantiate_prefab',
    'Instantiate a prefab in the scene. Params: prefabPath (asset path), position {x,y,z}, rotation {x,y,z} (euler), parent (hierarchy path), name.',
    {
      prefabPath: { type: 'string' },
      position: VEC,
      rotation: VEC,
      parent: { type: 'string' },
      name: { type: 'string' },
    }
  ),
  tool(
    'batch_instantiate_prefab',
    'Instantiate a prefab multiple times in one call. ' +
      'Params: prefabPath (asset path, shared across all items; a per-item prefabPath overrides it), items = array of instance specs, each accepts: position {x,y,z} (default 0,0,0), rotation {x,y,z} euler (default 0), parent (hierarchy path), name (default = prefab name). ' +
      'All per-item fields are optional except that position/rotation/name may be omitted to use defaults. ' +
      'Returns { summary: {total, succeeded, failed}, results: [{index, status, result|error}] } — per-item success/failure, partial failures do not abort the batch. ' +
      'Example: { prefabPath: "Assets/Prefabs/Rock.prefab", items: [{ position: {x:0, y:0, z:0}, name: "Rock1" }, { position: {x:5, y:0, z:0} }] }.',
    {
      prefabPath: { type: 'string' },
      items: { type: 'array', items: PREFAB_INSTANCE_ITEM },
    }
  ),
  tool('create_material', 'Create a new material with a shader.'),
  tool('modify_material', 'Modify material properties and textures.'),
  tool('open_prefab', 'Open a prefab in prefab mode.'),
  tool('exit_prefab_mode', 'Exit prefab mode.'),
  tool('save_prefab', 'Save the currently open prefab.'),

  tool(
    'create_script',
    'Create a C# script. Params: scriptName, scriptType (default MonoBehaviour), namespace, path (folder, default Assets/Scripts/), scriptContent (optional).',
    {
      scriptName: { type: 'string' },
      scriptType: { type: 'string' },
      namespace: { type: 'string' },
      path: { type: 'string' },
      scriptContent: { type: 'string' },
    }
  ),

  tool(
    'read_script',
    'Read a C# script. Params: scriptPath, scriptName, searchPath (default Assets/).',
    { scriptPath: { type: 'string' }, scriptName: { type: 'string' }, searchPath: { type: 'string' } }
  ),
  tool(
    'update_script',
    'Update a C# script. Params: scriptPath, scriptContent, scriptName, searchPath, updateMode, createBackup (bool).',
    {
      scriptPath: { type: 'string' },
      scriptContent: { type: 'string' },
      scriptName: { type: 'string' },
      searchPath: { type: 'string' },
      updateMode: { type: 'string' },
      createBackup: { type: 'boolean' },
    }
  ),
  tool(
    'delete_script',
    'Delete a C# script. Params: scriptPath, scriptName, searchPath (default Assets/).',
    { scriptPath: { type: 'string' }, scriptName: { type: 'string' }, searchPath: { type: 'string' } }
  ),
  tool(
    'list_scripts',
    'List C# scripts in the project. Params: searchPath (default Assets/), pattern, scriptType, includeMetadata (bool).',
    { searchPath: { type: 'string' }, pattern: { type: 'string' }, scriptType: { type: 'string' }, includeMetadata: { type: 'boolean' } }
  ),
  tool(
    'validate_script',
    'Validate a C# script. Params: scriptPath, scriptName, checkSyntax (bool), checkUnityCompatibility (bool), suggestImprovements (bool).',
    {
      scriptPath: { type: 'string' },
      scriptName: { type: 'string' },
      checkSyntax: { type: 'boolean' },
      checkUnityCompatibility: { type: 'boolean' },
      suggestImprovements: { type: 'boolean' },
    }
  ),

  tool(
    'execute_menu_item',
    'Execute a Unity editor menu item. Params: menuPath, action (execute|check|list, default execute), alias, safetyCheck (bool).',
    { menuPath: { type: 'string' }, action: { type: 'string' }, alias: { type: 'string' }, safetyCheck: { type: 'boolean' } }
  ),
  tool('clear_console', 'Clear the Unity console.'),
  tool('enhanced_read_logs', 'Read Unity console logs with filtering.'),
  tool('capture_screenshot', 'Capture a screenshot of the Game view.'),
  tool('analyze_screenshot', 'Analyze the last captured screenshot.'),

  tool(
    'add_component',
    'Add a component to a GameObject. Params: gameObjectPath, componentType, properties (optional object of property:value).',
    {
      gameObjectPath: { type: 'string' },
      componentType: { type: 'string' },
      properties: { type: 'object' },
    }
  ),

  tool(
    'remove_component',
    'Remove a component from a GameObject. Params: gameObjectPath, componentType, componentIndex (optional).',
    {
      gameObjectPath: { type: 'string' },
      componentType: { type: 'string' },
      componentIndex: { type: 'integer' },
    }
  ),

  tool(
    'modify_component',
    'Modify a component property. Params: gameObjectPath, componentType, componentIndex, properties (object of property:value).',
    {
      gameObjectPath: { type: 'string' },
      componentType: { type: 'string' },
      componentIndex: { type: 'integer' },
      properties: { type: 'object' },
    }
  ),

  tool(
    'list_components',
    'List components on a GameObject. Params: gameObjectPath, includeProperties (bool).',
    { gameObjectPath: { type: 'string' }, includeProperties: { type: 'boolean' } }
  ),

  tool('start_compilation_monitoring', 'Start watching for script compilation.'),
  tool('stop_compilation_monitoring', 'Stop watching for script compilation.'),
  tool('get_compilation_state', 'Get current script compilation state.'),

  tool(
    'manage_tags',
    'Manage tags. Params: action (get|add|remove), tagName.',
    { action: { type: 'string' }, tagName: { type: 'string' } }
  ),

  tool(
    'manage_layers',
    'Manage layers. Params: action (get|add|remove|get_by_name|get_by_index), layerName, layerIndex.',
    { action: { type: 'string' }, layerName: { type: 'string' }, layerIndex: { type: 'integer' } }
  ),

  tool(
    'manage_selection',
    'Manage editor selection. Params: action (get|set|clear|get_details), objectPaths (array of hierarchy paths, required for set), includeDetails (bool, for get).',
    {
      action: { type: 'string' },
      objectPaths: { type: 'array', items: { type: 'string' } },
      includeDetails: { type: 'boolean' },
    }
  ),

  tool(
    'manage_windows',
    'Manage editor windows. Params: action (get|focus|get_state), windowType, includeHidden (bool, for get).',
    { action: { type: 'string' }, windowType: { type: 'string' }, includeHidden: { type: 'boolean' } }
  ),

  tool(
    'manage_tools',
    'Manage editor tools. Params: action (get|activate|deactivate|refresh), toolName, category (for get).',
    { action: { type: 'string' }, toolName: { type: 'string' }, category: { type: 'string' } }
  ),

  tool(
    'manage_asset_import_settings',
    'Manage asset import settings. Params: action (get|modify|apply_preset|reimport), assetPath, settings (object, for modify), preset (for apply_preset).',
    { action: { type: 'string' }, assetPath: { type: 'string' }, settings: { type: 'object' }, preset: { type: 'string' } }
  ),

  tool(
    'manage_asset_database',
    'Manage the asset database. Params: action (find_assets|get_asset_info|create_folder|delete_asset|move_asset|copy_asset|refresh|save), assetPath, filter, searchInFolders (array), folderPath, fromPath, toPath.',
    {
      action: { type: 'string' },
      assetPath: { type: 'string' },
      filter: { type: 'string' },
      searchInFolders: { type: 'array', items: { type: 'string' } },
      folderPath: { type: 'string' },
      fromPath: { type: 'string' },
      toPath: { type: 'string' },
    }
  ),

  tool(
    'analyze_asset_dependencies',
    'Analyze asset dependencies. Params: action (get_dependencies|get_dependents|analyze_circular|find_unused|analyze_size_impact|validate_references), assetPath, recursive (bool), includeBuiltIn (bool).',
    {
      action: { type: 'string' },
      assetPath: { type: 'string' },
      recursive: { type: 'boolean' },
      includeBuiltIn: { type: 'boolean' },
    }
  ),

  tool('list_tests', 'List tests in the project.'),
  tool('run_tests', 'Run tests. Params: filter, testMode.'),
  tool('get_test_results', 'Get the results of the last test run.'),
  tool('cancel_tests', 'Cancel a running test run.'),

  tool(
    'read_logs',
    'Read Unity console logs. Params: count, level (log|warning|error).',
    { count: { type: 'integer' }, level: { type: 'string' } }
  ),

  tool('clear_logs', 'Clear Unity console logs.'),
  tool('refresh_assets', 'Trigger Unity asset refresh / reimport.'),
];

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

/* ------------------------------------------------------------------ */
/* MCP (JSON-RPC over stdio) server                                    */
/* ------------------------------------------------------------------ */

function sendMessage(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function isErrorCode(code) {
  return code >= -32099 && code <= -32000;
}

// Batch tools fan out to their single-item counterparts and aggregate results.
// Each item is executed sequentially (the Unity plugin serializes commands on
// its main thread anyway), so per-item errors don't abort the batch.
const BATCH_DEFS = {
  batch_create_gameobjects: {
    unit: 'create_gameobject',
    buildItem: (item) => item,
  },
  batch_instantiate_prefab: {
    unit: 'instantiate_prefab',
    // prefabPath is shared at the batch level; merge into each item.
    buildItem: (item, args) =>
      item.prefabPath ? item : { ...item, prefabPath: args.prefabPath },
  },
};

async function callBatchTool(name, args) {
  const def = BATCH_DEFS[name];
  const items = args.items;
  if (!Array.isArray(items) || items.length === 0) {
    return {
      content: [{ type: 'text', text: 'Error: items must be a non-empty array' }],
      isError: true,
    };
  }

  const results = [];
  let ok = 0;
  let failed = 0;
  for (let i = 0; i < items.length; i++) {
    const raw = items[i] && typeof items[i] === 'object' ? items[i] : {};
    let result;
    try {
      result = await sendCommand(def.unit, def.buildItem(raw, args));
    } catch (err) {
      results.push({ index: i, status: 'error', error: err.message });
      failed++;
      continue;
    }
    // The plugin wraps handler errors ({ error: ... }) in a transport-level
    // success envelope, so surface those as per-item failures.
    if (result && typeof result.error === 'string') {
      results.push({ index: i, status: 'error', error: result.error });
      failed++;
    } else {
      results.push({ index: i, status: 'success', result });
      ok++;
    }
  }

  const summary = { total: items.length, succeeded: ok, failed };
  const text = JSON.stringify({ summary, results }, null, 2);
  log(`ok: ${name} (${ok}/${items.length})`);
  return {
    content: [{ type: 'text', text }],
    // Only a hard error if every item failed; partial failure is informative.
    isError: failed > 0 && ok === 0,
  };
}

async function callTool(params) {
  const name = params && params.name;
  const args = (params && params.arguments) || {};

  if (BATCH_DEFS[name]) {
    return await callBatchTool(name, args);
  }

  const t = TOOL_MAP.get(name);
  if (!t) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  const started = Date.now();
  try {
    const result = await sendCommand(name, args);
    const text = JSON.stringify(result, null, 2);
    log(`ok: ${name} (${Date.now() - started}ms)`);
    return {
      content: [{ type: 'text', text }],
      isError: false,
    };
  } catch (err) {
    log(`error: ${name} - ${err.message}`);
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,
    };
  }
}

async function handleRequest(req) {
  switch (req.method) {
    case 'initialize':
      return {
        protocolVersion: (req.params && req.params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'unity-mcp-adapter', version: '0.1.0' },
      };

    case 'ping':
      return {};

    case 'tools/list':
      return { tools: TOOLS };

    case 'tools/call':
      return await callTool(req.params);

    default:
      throw new Error(`Method not found: ${req.method}`);
  }
}

async function run() {
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  const unity = getUnity();
  log(
    'started. project=' + PROJECT_ROOT +
      (unity
        ? ` | Unity instance: port=${unity.port} scene=${unity.activeScene || '?'}`
        : ' | no Unity instance found yet (will keep watching registry)')
  );

  for await (const line of rl) {
    if (!line.trim()) continue;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }

    // Notifications carry no id - respond to nothing.
    if (msg.id === undefined || msg.id === null) {
      if (msg.method === 'notifications/initialized') {
        // Optionally force-refresh the registry now that the client is ready.
        getUnity(true);
      }
      continue;
    }

    let result;
    let error = null;
    try {
      result = await handleRequest(msg);
    } catch (err) {
      error = { code: -32601, message: err.message || String(err) };
    }

    if (error) {
      sendMessage({ jsonrpc: '2.0', id: msg.id, error });
    } else {
      sendMessage({ jsonrpc: '2.0', id: msg.id, result });
    }
  }
}

run().catch((err) => {
  log('fatal:', err);
  process.exit(1);
});
