# Daemon per-project Unity routing

## Problem

`unity-editor-mcp` runs one shared daemon per machine. Every Claude session starts a stdio shim that proxies tool calls to that daemon. The shim forwards only tool name and arguments; the daemon owns a single `UnityConnection` whose target is resolved from the daemon's own env and cwd (the mcp-server repo). With two Unity Editors open the daemon cannot infer which project a caller belongs to, and every tool except `list_unity_instances` fails with "Multiple Unity Editor MCP instances are running and no target project could be inferred".

## Goal

Each shim tells the daemon which Unity project it serves; the daemon keeps one `UnityConnection` per target and binds every MCP session to the right one. Existing single-Editor behaviour and existing tests keep working unchanged.

## Design

### Shim (`src/core/server.js`, `src/core/daemonClient.js`)
- At `startStdioDaemonProxy` start, resolve the shim's target once:
  - `projectPath = config.unity.discovery.projectPath || findUnityProjectRoot(process.cwd())`
  - `instanceId = config.unity.discovery.instanceId`, `workspaceId = config.unity.discovery.workspaceId` (pass-through of env/CLI settings).
- `createDaemonMcpClient(options)` accepts `options.target = { projectPath, instanceId, workspaceId }` and sets HTTP headers on the `StreamableHTTPClientTransport` (`requestInit.headers`): `x-unity-mcp-project-path`, `x-unity-mcp-instance-id`, `x-unity-mcp-workspace-id`. Only non-empty values are sent. Header values are the raw strings (paths are ASCII on this machine; encode with `encodeURIComponent` and decode on the daemon to be safe with non-ASCII paths).

### Daemon (`src/core/daemonServer.js`)
- New `readTargetFromHeaders(req)` → `{ projectPath, instanceId, workspaceId }` (decoded, empty strings dropped) or `null` if none present.
- `targetKey(target)` → `instanceId || workspaceId || normalized projectPath || '__default__'`.
- A `connections: Map<key, UnityConnection>` pool. `getConnection(target)`:
  - `'__default__'` returns `options.unityConnection || new UnityConnection()` (today's behaviour, created once).
  - otherwise creates via `options.unityConnectionFactory?.(target)` if provided (tests), else `new UnityConnection({ config: withDiscoveryTarget(config, target) })` where `withDiscoveryTarget` deep-copies `config.unity.discovery` with the target's `projectPath`/`instanceId`/`workspaceId` overriding. Connect is attempted immediately, errors logged (same pattern as the existing initial connect).
- `createMcpSession(options, target)`: `handlers = createHandlers(connection)` for that session's connection, then the existing server/transport setup. `handleMcpRequest` reads the target from the initialize request's headers and passes it in. Non-initialize requests are routed by `mcp-session-id` as today.
- Health/registry: `selectedUnity` keeps reporting the default connection's endpoint (unchanged shape). Add `targets: [{ key, projectPath, instanceId, workspaceId, connected, endpoint }]` to `/health` and to the registry file.
- `close()` disconnects every pooled connection.

### Out of scope
- Evicting idle per-project connections (auto-reconnect already handles a closed Editor).
- Changing the direct (non-daemon) stdio server.

## Testing
- `tests/unit/core/daemonServer.test.js`: two clients initializing with different `x-unity-mcp-project-path` headers get distinct connections from `unityConnectionFactory`; a client with no header gets the default `unityConnection`; `/health` lists both targets.
- `tests/unit/core/daemonClient.test.js`: `createDaemonMcpClient({ target })` sends the three headers (assert on the daemon side by capturing `req.headers` in a stub HTTP server, or by using `startDaemonServer` with a factory that records the target).
- `npm test` passes.
- Live: restart the daemon, with both Editors open run `get_editor_state` from a sand-bucket session and confirm it reports the sand-bucket project.
