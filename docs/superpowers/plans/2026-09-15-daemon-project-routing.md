# Daemon per-project Unity routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route each MCP session in the shared daemon to the Unity Editor of the project the calling shim runs in.

**Architecture:** The stdio shim resolves its Unity project from its cwd and sends it as HTTP headers on every daemon request. The daemon keeps a pool of `UnityConnection`s keyed by target and builds per-session handler maps bound to the session's connection. No header → today's single default connection.

**Tech Stack:** Node 22 ESM, `@modelcontextprotocol/sdk` Streamable HTTP, `node --test`.

**Spec:** `docs/superpowers/specs/2026-09-15-daemon-project-routing-design.md`

**Commit rules:** no `feat:`-style prefixes, no Co-Authored-By lines.

---

### Task 1: Daemon-side connection pool and header-bound sessions

**Files:**
- Modify: `mcp-server/src/core/daemonServer.js`
- Test: `mcp-server/tests/unit/core/daemonServer.test.js`

- [ ] **Step 1: Write failing tests** (append to the existing `describe('daemon server')`)

```js
  it('binds each MCP session to the Unity target named in its headers', async () => {
    const registryDir = await makeTempDir();
    const seen = [];
    const makeStub = (label) => ({
      isConnected: () => true,
      connect: async () => {},
      disconnect: () => {},
      getConnectionInfo: () => ({ connected: true, endpoint: { port: 1, projectPath: label } }),
      sendCommand: async () => ({ message: 'pong', label })
    });
    const defaultConnection = makeStub('default');
    const daemon = await startDaemonServer({
      host: '127.0.0.1',
      port: 0,
      registryDir,
      connectToUnity: false,
      unityConnection: defaultConnection,
      unityConnectionFactory: (target) => { seen.push(target); return makeStub(target.projectPath); }
    });
    servers.push(daemon);

    async function clientFor(headers) {
      const client = new Client({ name: 't', version: '1' }, { capabilities: {} });
      const transport = new StreamableHTTPClientTransport(new URL(daemon.url), { requestInit: { headers } });
      await client.connect(transport);
      return client;
    }

    const a = await clientFor({ 'x-unity-mcp-project-path': encodeURIComponent('/tmp/proj-a') });
    const b = await clientFor({ 'x-unity-mcp-project-path': encodeURIComponent('/tmp/proj-b') });
    const none = await clientFor({});

    const ra = await a.callTool({ name: 'ping', arguments: {} });
    const rb = await b.callTool({ name: 'ping', arguments: {} });
    const rn = await none.callTool({ name: 'ping', arguments: {} });

    assert.deepEqual(seen.map((t) => t.projectPath), ['/tmp/proj-a', '/tmp/proj-b']);
    assert.match(JSON.stringify(ra), /proj-a/);
    assert.match(JSON.stringify(rb), /proj-b/);
    assert.match(JSON.stringify(rn), /default/);

    const health = await (await fetch(daemon.healthUrl)).json();
    assert.deepEqual(health.targets.map((t) => t.projectPath).sort(), ['/tmp/proj-a', '/tmp/proj-b']);
  });

  it('reuses one connection per target across sessions', async () => {
    const registryDir = await makeTempDir();
    let created = 0;
    const daemon = await startDaemonServer({
      host: '127.0.0.1', port: 0, registryDir, connectToUnity: false,
      unityConnection: { isConnected: () => true, connect: async () => {}, disconnect: () => {}, getConnectionInfo: () => ({}), sendCommand: async () => ({}) },
      unityConnectionFactory: () => { created++; return { isConnected: () => true, connect: async () => {}, disconnect: () => {}, getConnectionInfo: () => ({}), sendCommand: async () => ({ message: 'pong' }) }; }
    });
    servers.push(daemon);
    for (let i = 0; i < 2; i++) {
      const client = new Client({ name: 't', version: '1' }, { capabilities: {} });
      await client.connect(new StreamableHTTPClientTransport(new URL(daemon.url), { requestInit: { headers: { 'x-unity-mcp-project-path': encodeURIComponent('/tmp/same') } } }));
      await client.callTool({ name: 'ping', arguments: {} });
    }
    assert.equal(created, 1);
  });
```

Check how the existing "serves MCP tools over Streamable HTTP" test builds its `ping` call and stub connection, and mirror its stub shape exactly (the `PingToolHandler` may call `getConnectionInfo()` or read `endpoint`). Adjust the stubs above to whatever the ping handler actually needs so the response embeds the label (if `ping` doesn't echo `sendCommand` output, switch the assertion to a tool that does, e.g. call `sendCommand` result passthrough via `get_editor_state`).

- [ ] **Step 2: Run to verify failure**

Run: `cd mcp-server && node --test tests/unit/core/daemonServer.test.js`
Expected: the two new tests fail (`health.targets` undefined / factory never called).

- [ ] **Step 3: Implement in `daemonServer.js`**

Add near the top:

```js
import { createHandlers } from '../handlers/index.js';   // already imported
import path from 'path';

const TARGET_HEADERS = {
  projectPath: 'x-unity-mcp-project-path',
  instanceId: 'x-unity-mcp-instance-id',
  workspaceId: 'x-unity-mcp-workspace-id'
};

export function readTargetFromHeaders(headers = {}) {
  const target = {};
  for (const [field, header] of Object.entries(TARGET_HEADERS)) {
    const raw = headers[header];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === 'string' && value.trim()) {
      try { target[field] = decodeURIComponent(value.trim()); } catch { target[field] = value.trim(); }
    }
  }
  return Object.keys(target).length > 0 ? target : null;
}

export function targetKey(target) {
  if (!target) return '__default__';
  if (target.instanceId) return `instance:${target.instanceId}`;
  if (target.workspaceId) return `workspace:${target.workspaceId}`;
  if (target.projectPath) return `project:${path.resolve(target.projectPath)}`;
  return '__default__';
}

function withDiscoveryTarget(baseConfig, target) {
  return {
    ...baseConfig,
    unity: {
      ...baseConfig.unity,
      discovery: {
        ...(baseConfig.unity?.discovery || {}),
        ...(target.projectPath && { projectPath: target.projectPath }),
        ...(target.instanceId && { instanceId: target.instanceId }),
        ...(target.workspaceId && { workspaceId: target.workspaceId })
      }
    }
  };
}
```

Inside `startDaemonServer`, replace the single `unityConnection`/`handlers` with a pool:

```js
  const defaultConnection = options.unityConnection || new UnityConnection();
  const connections = new Map([['__default__', { key: '__default__', target: null, connection: defaultConnection }]]);

  const getConnectionEntry = (target) => {
    const key = targetKey(target);
    let entry = connections.get(key);
    if (entry) return entry;
    const connection = typeof options.unityConnectionFactory === 'function'
      ? options.unityConnectionFactory(target)
      : new UnityConnection({ config: withDiscoveryTarget(config, target) });
    entry = { key, target, connection };
    connections.set(key, entry);
    if (options.connectToUnity !== false) {
      Promise.resolve(connection.connect()).catch((error) => {
        lastError = error.message;
        logger.error(`Daemon Unity connection failed for ${key}:`, error.message);
      });
    }
    return entry;
  };

  const describeTargets = () => Array.from(connections.values())
    .filter((entry) => entry.key !== '__default__')
    .map((entry) => ({
      key: entry.key,
      ...entry.target,
      connected: typeof entry.connection.isConnected === 'function' ? entry.connection.isConnected() : null,
      endpoint: entry.connection.endpoint
        ? { host: entry.connection.endpoint.host, port: entry.connection.endpoint.port, projectPath: entry.connection.endpoint.instance?.projectPath }
        : null
    }));
```

- `unityConnection` references elsewhere in the function (health `unity:`, `writeRegistry`'s `endpoint`, initial `connect()`, `close()`) use `defaultConnection`. Add `targets: describeTargets()` to the health JSON and to the `writeDaemonRegistry` payload (`daemonRegistry.js` must pass `targets` through: add `targets: data.targets || []` next to `selectedUnity` in both the write and read shape).
- `close()` disconnects every entry: `for (const entry of connections.values()) entry.connection.disconnect();`.
- `handleMcpRequest(req, res, options)`: on the initialize branch, `session = await createMcpSession(options, readTargetFromHeaders(req.headers));`.
- `createMcpSession(options, target)`: `const handlers = createHandlers(options.getConnectionEntry(target).connection); const server = createDaemonMcpServer(handlers);` — pass `getConnectionEntry` into the `options` object given to `handleMcpRequest` (replace the current `handlers` field).

- [ ] **Step 4: Run tests**

Run: `cd mcp-server && node --test tests/unit/core/daemonServer.test.js && node --test tests/unit/core/daemonRegistry.test.js`
Expected: all pass, including the pre-existing ones.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/core/daemonServer.js mcp-server/src/core/daemonRegistry.js mcp-server/tests/unit/core/daemonServer.test.js
git commit -m "Route daemon MCP sessions to the Unity target named in request headers"
```

---

### Task 2: Shim sends its project target

**Files:**
- Modify: `mcp-server/src/core/daemonClient.js` (`createDaemonMcpClient`)
- Modify: `mcp-server/src/core/server.js` (`startStdioDaemonProxy`)
- Test: `mcp-server/tests/unit/core/daemonClient.test.js`

- [ ] **Step 1: Write failing test** (append to the existing describe; look at how existing tests in that file start a daemon or stub `ensureDaemon`, and follow the same pattern)

```js
  it('sends the shim target as request headers', async () => {
    const registryDir = await makeTempDir();           // reuse the file's temp-dir helper or add one like daemonServer.test.js
    const seen = [];
    const daemon = await startDaemonServer({
      host: '127.0.0.1', port: 0, registryDir, connectToUnity: false,
      unityConnection: { isConnected: () => true, connect: async () => {}, disconnect: () => {}, getConnectionInfo: () => ({}), sendCommand: async () => ({}) },
      unityConnectionFactory: (target) => { seen.push(target); return { isConnected: () => true, connect: async () => {}, disconnect: () => {}, getConnectionInfo: () => ({}), sendCommand: async () => ({ message: 'pong' }) }; }
    });
    servers.push(daemon);

    const { client, transport } = await createDaemonMcpClient({
      registryDir, autoStart: false,
      target: { projectPath: '/tmp/shim project', instanceId: 'abc', workspaceId: 'ws1' }
    });
    await client.callTool({ name: 'ping', arguments: {} });
    await transport.close();

    assert.deepEqual(seen, [{ projectPath: '/tmp/shim project', instanceId: 'abc', workspaceId: 'ws1' }]);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `cd mcp-server && node --test tests/unit/core/daemonClient.test.js`
Expected: new test fails (`seen` is empty).

- [ ] **Step 3: Implement**

`daemonClient.js`:

```js
export function buildTargetHeaders(target = {}) {
  const headers = {};
  if (target.projectPath) headers['x-unity-mcp-project-path'] = encodeURIComponent(target.projectPath);
  if (target.instanceId) headers['x-unity-mcp-instance-id'] = encodeURIComponent(target.instanceId);
  if (target.workspaceId) headers['x-unity-mcp-workspace-id'] = encodeURIComponent(target.workspaceId);
  return headers;
}

export async function createDaemonMcpClient(options = {}) {
  const { registry } = await ensureDaemon(options);
  const client = new Client({ name: `${config.server.name}-stdio-shim`, version: config.server.version }, { capabilities: {} });
  const headers = buildTargetHeaders(options.target);
  const transport = new StreamableHTTPClientTransport(
    new URL(registry.url),
    Object.keys(headers).length > 0 ? { requestInit: { headers } } : undefined
  );
  await client.connect(transport);
  return { client, transport, registry };
}
```

`server.js`, in `startStdioDaemonProxy`, before `registerDaemonProxyHandlers`:

```js
  const discovery = customConfig.unity?.discovery || {};
  const shimTarget = {
    projectPath: discovery.projectPath || findUnityProjectRoot(discovery.cwd || process.cwd()) || '',
    instanceId: discovery.instanceId || '',
    workspaceId: discovery.workspaceId || ''
  };
  logger.info(`Stdio shim Unity target: ${JSON.stringify(shimTarget)}`);
```
(import `findUnityProjectRoot` from `./unityDiscovery.js`), and pass `target: shimTarget` into `createDaemonMcpClient({...})`.

- [ ] **Step 4: Run the whole suite**

Run: `cd mcp-server && npm test`
Expected: all unit + integration tests pass.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/core/daemonClient.js mcp-server/src/core/server.js mcp-server/tests/unit/core/daemonClient.test.js
git commit -m "Send the shim's Unity project target to the daemon"
```

---

### Task 3: Live verification (orchestrator)

- [ ] Stop the running daemon (`kill <pid from ~/.unity-editor-mcp/daemon.json>`); the next shim call auto-starts a fresh one on the new code.
- [ ] From the sand-bucket Claude session call `mcp__unity-mcp__ping` and `get_editor_state`; expect `projectPath` = sand-bucket while the aetherfell Editor is still open.
- [ ] `cat ~/.unity-editor-mcp/daemon.json` shows a `targets` entry for sand-bucket.
