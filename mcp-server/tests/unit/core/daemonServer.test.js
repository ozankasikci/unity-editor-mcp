import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'fs/promises';
import http from 'http';
import os from 'os';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  readTargetFromHeaders,
  startDaemonServer,
  targetKey,
  withDiscoveryTarget
} from '../../../src/core/daemonServer.js';
import { readDaemonRegistry } from '../../../src/core/daemonRegistry.js';

describe('daemon server', () => {
  const tempDirs = [];
  const servers = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await Promise.all(tempDirs.map((dir) => fsp.rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function makeTempDir() {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'unity-mcp-daemon-server-'));
    tempDirs.push(dir);
    return dir;
  }

  it('starts a local HTTP daemon and writes health metadata', async () => {
    const registryDir = await makeTempDir();
    const daemon = await startDaemonServer({
      host: '127.0.0.1',
      port: 0,
      registryDir,
      connectToUnity: false
    });
    servers.push(daemon);

    const response = await fetch(`http://127.0.0.1:${daemon.port}/health`);
    const health = await response.json();
    const registry = await readDaemonRegistry({ registryDir });

    assert.equal(response.status, 200);
    assert.equal(health.status, 'ok');
    assert.equal(health.pid, process.pid);
    assert.equal(registry.pid, process.pid);
    assert.equal(registry.port, daemon.port);
    assert.equal(registry.url, `http://127.0.0.1:${daemon.port}/mcp`);
  });

  it('serves MCP tools over Streamable HTTP', async () => {
    const registryDir = await makeTempDir();
    const unityConnection = {
      isConnected: () => true,
      connect: async () => {},
      disconnect: () => {},
      getConnectionInfo: () => ({
        connected: true,
        endpoint: { port: 6400 }
      }),
      sendCommand: async (type, params) => {
        assert.equal(type, 'ping');
        return {
          message: 'pong',
          echo: params.message,
          timestamp: '2026-06-29T00:00:00.000Z',
          unityVersion: '6000.2.7f2'
        };
      }
    };
    const daemon = await startDaemonServer({
      host: '127.0.0.1',
      port: 0,
      registryDir,
      unityConnection,
      connectToUnity: false
    });
    servers.push(daemon);

    const client = new Client(
      { name: 'daemon-server-test', version: '1.0.0' },
      { capabilities: {} }
    );
    const transport = new StreamableHTTPClientTransport(new URL(daemon.url));
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      const result = await client.callTool({
        name: 'ping',
        arguments: { message: 'hello' }
      });

      assert.ok(tools.tools.some((tool) => tool.name === 'ping'));
      assert.equal(result.structuredContent.message, 'pong');
      assert.equal(result.structuredContent.echo, 'hello');
    } finally {
      await client.close();
    }
  });

  it('accepts a fresh Streamable HTTP client after the previous client closes', async () => {
    const registryDir = await makeTempDir();
    const unityConnection = createMockUnityConnection();
    const daemon = await startDaemonServer({
      host: '127.0.0.1',
      port: 0,
      registryDir,
      unityConnection,
      connectToUnity: false
    });
    servers.push(daemon);

    const first = await callPingThroughNewClient(daemon.url, 'first');
    const second = await callPingThroughNewClient(daemon.url, 'second');

    assert.equal(first.structuredContent.echo, 'first');
    assert.equal(second.structuredContent.echo, 'second');
  });

  it('rejects MCP requests with invalid localhost host or origin headers', async () => {
    const registryDir = await makeTempDir();
    const daemon = await startDaemonServer({
      host: '127.0.0.1',
      port: 0,
      registryDir,
      unityConnection: createMockUnityConnection(),
      connectToUnity: false
    });
    servers.push(daemon);

    const invalidHost = await postMcpJson(daemon.port, {
      host: 'evil.example',
      origin: `http://127.0.0.1:${daemon.port}`
    });
    const invalidOrigin = await postMcpJson(daemon.port, {
      host: `127.0.0.1:${daemon.port}`,
      origin: 'http://evil.example'
    });

    assert.equal(invalidHost.statusCode, 403);
    assert.match(invalidHost.body, /Invalid Host header/);
    assert.equal(invalidOrigin.statusCode, 403);
    assert.match(invalidOrigin.body, /Invalid Origin header/);
  });

  it('rejects oversized daemon POST bodies before parsing JSON', async () => {
    const registryDir = await makeTempDir();
    const daemon = await startDaemonServer({
      host: '127.0.0.1',
      port: 0,
      registryDir,
      unityConnection: createMockUnityConnection(),
      connectToUnity: false,
      maxBodyBytes: 8
    });
    servers.push(daemon);

    const response = await postRaw(daemon.port, 'x'.repeat(64), {
      host: `127.0.0.1:${daemon.port}`
    });

    assert.equal(response.statusCode, 413);
    assert.match(response.body, /DAEMON_REQUEST_TOO_LARGE/);
  });

  it('binds each MCP session to the Unity target named in its headers', async () => {
    const registryDir = await makeTempDir();
    const seen = [];
    const makeStub = (label) => ({
      isConnected: () => true,
      connect: async () => {},
      disconnect: () => {},
      getConnectionInfo: () => ({ connected: true, endpoint: { port: 1, projectPath: label } }),
      sendCommand: async () => ({ message: 'pong', projectPath: label })
    });
    const defaultConnection = makeStub('default');
    const daemon = await startDaemonServer({
      host: '127.0.0.1',
      port: 0,
      registryDir,
      connectToUnity: false,
      heartbeatMs: 25,
      unityConnection: defaultConnection,
      unityConnectionFactory: (target) => {
        seen.push(target);
        return makeStub(target.projectPath);
      }
    });
    servers.push(daemon);

    const clients = [];
    async function clientFor(headers) {
      const client = new Client({ name: 'target-test', version: '1.0.0' }, { capabilities: {} });
      const transport = new StreamableHTTPClientTransport(new URL(daemon.url), {
        requestInit: { headers }
      });
      await client.connect(transport);
      clients.push(client);
      return client;
    }

    try {
      const a = await clientFor({ 'x-unity-mcp-project-path': encodeURIComponent('/tmp/proj-a') });
      const b = await clientFor({ 'x-unity-mcp-project-path': encodeURIComponent('/tmp/proj-b') });
      const none = await clientFor({});

      const ra = await a.callTool({ name: 'ping', arguments: {} });
      const rb = await b.callTool({ name: 'ping', arguments: {} });
      const rn = await none.callTool({ name: 'ping', arguments: {} });

      assert.deepEqual(seen.map((t) => t.projectPath), ['/tmp/proj-a', '/tmp/proj-b']);
      assert.equal(ra.structuredContent.projectPath, '/tmp/proj-a');
      assert.equal(rb.structuredContent.projectPath, '/tmp/proj-b');
      assert.equal(rn.structuredContent.projectPath, 'default');

      const health = await (await fetch(daemon.healthUrl)).json();
      assert.deepEqual(health.targets.map((t) => t.target.projectPath).sort(), ['/tmp/proj-a', '/tmp/proj-b']);

      let registryTargets = [];
      for (let attempt = 0; attempt < 40 && registryTargets.length < 2; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        const registry = await readDaemonRegistry({ registryDir });
        registryTargets = (registry?.targets || []).map((t) => t.target.projectPath).sort();
      }
      assert.deepEqual(registryTargets, ['/tmp/proj-a', '/tmp/proj-b']);
    } finally {
      await Promise.all(clients.map((client) => client.close().catch(() => {})));
    }
  });

  it('reuses one connection per target across sessions', async () => {
    const registryDir = await makeTempDir();
    let created = 0;
    const makeStub = () => ({
      isConnected: () => true,
      connect: async () => {},
      disconnect: () => {},
      getConnectionInfo: () => ({ connected: true, endpoint: { port: 1 } }),
      sendCommand: async () => ({ message: 'pong' })
    });
    const daemon = await startDaemonServer({
      host: '127.0.0.1',
      port: 0,
      registryDir,
      connectToUnity: false,
      unityConnection: makeStub(),
      unityConnectionFactory: () => {
        created++;
        return makeStub();
      }
    });
    servers.push(daemon);

    for (let i = 0; i < 2; i++) {
      const client = new Client({ name: `reuse-test-${i}`, version: '1.0.0' }, { capabilities: {} });
      const transport = new StreamableHTTPClientTransport(new URL(daemon.url), {
        requestInit: { headers: { 'x-unity-mcp-project-path': encodeURIComponent('/tmp/same') } }
      });
      try {
        await client.connect(transport);
        await client.callTool({ name: 'ping', arguments: {} });
      } finally {
        await client.close();
      }
    }

    assert.equal(created, 1);
  });

  it('shares one connection between a project root and its Assets folder', async () => {
    const { created } = await countFactoryCalls([
      { 'x-unity-mcp-project-path': encodeURIComponent('/tmp/x') },
      { 'x-unity-mcp-project-path': encodeURIComponent('/tmp/x/Assets') }
    ]);
    assert.equal(created, 1);
  });

  it('does not share a connection between different projects in one workspace', async () => {
    const { created } = await countFactoryCalls([
      {
        'x-unity-mcp-project-path': encodeURIComponent('/tmp/ws/proj-a'),
        'x-unity-mcp-workspace-id': 'ws-1'
      },
      {
        'x-unity-mcp-project-path': encodeURIComponent('/tmp/ws/proj-b'),
        'x-unity-mcp-workspace-id': 'ws-1'
      }
    ]);
    assert.equal(created, 2);
  });

  async function countFactoryCalls(headerSets) {
    const registryDir = await makeTempDir();
    let created = 0;
    const daemon = await startDaemonServer({
      host: '127.0.0.1',
      port: 0,
      registryDir,
      connectToUnity: false,
      unityConnection: createPoolStub(),
      unityConnectionFactory: () => {
        created++;
        return createPoolStub();
      }
    });
    servers.push(daemon);

    for (const [index, headers] of headerSets.entries()) {
      const client = new Client({ name: `pool-test-${index}`, version: '1.0.0' }, { capabilities: {} });
      const transport = new StreamableHTTPClientTransport(new URL(daemon.url), {
        requestInit: { headers }
      });
      try {
        await client.connect(transport);
        await client.callTool({ name: 'ping', arguments: {} });
      } finally {
        await client.close();
      }
    }

    return { created };
  }

  it('drops relative projectPath header values', () => {
    assert.equal(readTargetFromHeaders({
      'x-unity-mcp-project-path': encodeURIComponent('relative/proj')
    }), null);

    assert.deepEqual(readTargetFromHeaders({
      'x-unity-mcp-project-path': encodeURIComponent('../escape'),
      'x-unity-mcp-instance-id': 'abc'
    }), { instanceId: 'abc' });

    assert.deepEqual(readTargetFromHeaders({
      'x-unity-mcp-project-path': encodeURIComponent('/abs/proj')
    }), { projectPath: '/abs/proj' });
  });

  it('keys on every provided selector and normalizes the project path', () => {
    assert.equal(targetKey(null), '__default__');
    assert.equal(targetKey({}), '__default__');
    assert.equal(
      targetKey({ projectPath: '/tmp/x/Assets' }),
      targetKey({ projectPath: '/tmp/x' })
    );
    assert.notEqual(
      targetKey({ projectPath: '/tmp/a', workspaceId: 'ws' }),
      targetKey({ projectPath: '/tmp/b', workspaceId: 'ws' })
    );
    assert.equal(
      targetKey({ projectPath: '/tmp/a', instanceId: 'i1', workspaceId: 'ws' }),
      'project:/tmp/a|instance:i1|workspace:ws'
    );
  });

  it('clears ambient discovery selectors when the target names one', () => {
    const baseConfig = {
      unity: {
        host: '127.0.0.1',
        discovery: {
          projectPath: '/env/project',
          instanceId: 'env-instance',
          workspaceId: 'env-workspace',
          registryDir: '/env/registry'
        }
      }
    };

    const scoped = withDiscoveryTarget(baseConfig, { projectPath: '/tmp/target' });
    assert.deepEqual(scoped.unity.discovery, {
      projectPath: '/tmp/target',
      instanceId: '',
      workspaceId: '',
      registryDir: '/env/registry'
    });
    assert.equal(scoped.unity.host, '127.0.0.1');
    assert.deepEqual(baseConfig.unity.discovery, {
      projectPath: '/env/project',
      instanceId: 'env-instance',
      workspaceId: 'env-workspace',
      registryDir: '/env/registry'
    });

    assert.deepEqual(
      withDiscoveryTarget(baseConfig, {}).unity.discovery,
      baseConfig.unity.discovery
    );
  });
});

function createPoolStub() {
  return {
    isConnected: () => true,
    connect: async () => {},
    disconnect: () => {},
    getConnectionInfo: () => ({ connected: true, endpoint: { port: 1 } }),
    sendCommand: async () => ({ message: 'pong' })
  };
}

function createMockUnityConnection() {
  return {
    isConnected: () => true,
    connect: async () => {},
    disconnect: () => {},
    getConnectionInfo: () => ({
      connected: true,
      endpoint: { port: 6400 }
    }),
    sendCommand: async (type, params) => {
      assert.equal(type, 'ping');
      return {
        message: 'pong',
        echo: params.message,
        timestamp: '2026-06-29T00:00:00.000Z',
        unityVersion: '6000.2.7f2'
      };
    }
  };
}

async function callPingThroughNewClient(url, message) {
  const client = new Client(
    { name: `daemon-server-test-${message}`, version: '1.0.0' },
    { capabilities: {} }
  );
  const transport = new StreamableHTTPClientTransport(new URL(url));
  try {
    await client.connect(transport);
    return await client.callTool({
      name: 'ping',
      arguments: { message }
    });
  } finally {
    await client.close();
  }
}

function postMcpJson(port, headers) {
  return postRaw(port, JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'host-header-test', version: '1.0.0' }
    }
  }), {
    ...headers,
    'content-type': 'application/json'
  });
}

function postRaw(port, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: '/mcp',
      method: 'POST',
      headers: {
        ...headers,
        'content-length': Buffer.byteLength(body)
      }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    request.on('error', reject);
    request.end(body);
  });
}
