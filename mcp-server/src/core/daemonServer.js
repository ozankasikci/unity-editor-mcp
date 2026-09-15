import http from 'http';
import path from 'path';
import { randomUUID } from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { UnityConnection } from './unityConnection.js';
import { normalizeProjectPath } from './unityDiscovery.js';
import { registerMcpHandlers } from './mcpRegistration.js';
import { createHandlers } from '../handlers/index.js';
import { config, logger } from './config.js';
import { getServerMetadata } from './serverMetadata.js';
import { removeDaemonRegistry, writeDaemonRegistry } from './daemonRegistry.js';

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
    if (typeof value !== 'string' || !value.trim()) {
      continue;
    }

    let decoded;
    try {
      decoded = decodeURIComponent(value.trim());
    } catch {
      decoded = value.trim();
    }

    if (field === 'projectPath' && !path.isAbsolute(decoded)) {
      logger.warn(`Ignoring relative ${header} header value: ${decoded}`);
      continue;
    }

    target[field] = decoded;
  }
  return Object.keys(target).length > 0 ? target : null;
}

export function targetKey(target) {
  if (!target) return '__default__';

  const parts = [];
  const normalizedProjectPath = normalizeProjectPath(target.projectPath);
  if (normalizedProjectPath) parts.push(`project:${normalizedProjectPath}`);
  if (target.instanceId) parts.push(`instance:${target.instanceId}`);
  if (target.workspaceId) parts.push(`workspace:${target.workspaceId}`);

  return parts.length > 0 ? parts.join('|') : '__default__';
}

export function withDiscoveryTarget(baseConfig, target = {}) {
  const hasSelector = Boolean(target.projectPath || target.instanceId || target.workspaceId);
  const baseDiscovery = baseConfig.unity?.discovery || {};
  const discovery = hasSelector
    ? {
        ...baseDiscovery,
        projectPath: target.projectPath || '',
        instanceId: target.instanceId || '',
        workspaceId: target.workspaceId || ''
      }
    : { ...baseDiscovery };

  return {
    ...baseConfig,
    unity: {
      ...baseConfig.unity,
      discovery
    }
  };
}

export async function startDaemonServer(options = {}) {
  const host = options.host || config.daemon.host;
  const requestedPort = Number.isInteger(Number(options.port)) ? Number(options.port) : config.daemon.port;
  const registryDir = options.registryDir || config.daemon.registryDir;
  const unityConnection = options.unityConnection || new UnityConnection();
  const metadata = getServerMetadata();
  const sessions = new Map();
  let selectedUnity = null;
  let lastError = null;
  let actualPort = requestedPort;

  const connections = new Map([
    ['__default__', { key: '__default__', target: null, connection: unityConnection }]
  ]);

  const getConnectionEntry = (target) => {
    const key = targetKey(target);
    let entry = connections.get(key);
    if (entry) {
      return entry;
    }

    const connection = typeof options.unityConnectionFactory === 'function'
      ? options.unityConnectionFactory(target)
      : new UnityConnection({ config: withDiscoveryTarget(config, target) });
    entry = { key, target, connection, lastError: null };
    connections.set(key, entry);

    if (options.connectToUnity !== false) {
      Promise.resolve(connection.connect()).catch((error) => {
        entry.lastError = error.message;
        logger.error(`Daemon Unity connection failed for ${key}:`, error.message);
      });
    }

    return entry;
  };

  const describeTargets = () => Array.from(connections.values())
    .filter((entry) => entry.key !== '__default__')
    .map((entry) => {
      const connected = typeof entry.connection.isConnected === 'function'
        ? entry.connection.isConnected()
        : null;
      const endpoint = entry.connection.endpoint;
      return {
        key: entry.key,
        target: entry.target,
        connected,
        endpoint: connected && endpoint
          ? {
              host: endpoint.host,
              port: endpoint.port,
              projectPath: endpoint.instance?.projectPath
            }
          : null,
        error: entry.lastError || null
      };
    });

  const httpServer = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url || '/', `http://${req.headers.host || `${host}:${requestedPort}`}`).pathname;
      if (pathname === '/health') {
        const health = {
          status: 'ok',
          pid: process.pid,
          server: metadata,
          unity: unityConnection.getConnectionInfo ? unityConnection.getConnectionInfo() : null,
          selectedUnity,
          targets: describeTargets(),
          lastError,
          sessions: sessions.size,
          uptimeSeconds: process.uptime()
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(health));
        return;
      }

      if (pathname === '/mcp') {
        await handleMcpRequest(req, res, {
          sessions,
          getConnectionEntry,
          host,
          port: actualPort,
          maxBodyBytes: options.maxBodyBytes ?? config.daemon.maxBodyBytes,
          sessionIdGenerator: options.sessionIdGenerator === undefined ? () => randomUUID() : options.sessionIdGenerator
        });
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (error) {
      lastError = error.message;
      logger.error('Daemon request failed:', error.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ error: error.message }));
    }
  });

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(requestedPort, host, resolve);
  });

  const port = httpServer.address().port;
  actualPort = port;
  const writeRegistry = async () => {
    const endpoint = unityConnection.endpoint;
    selectedUnity = endpoint?.instance
      ? {
          instanceId: endpoint.instance.instanceId,
          pid: endpoint.instance.pid,
          port: endpoint.instance.port,
          projectPath: endpoint.instance.projectPath,
          workspaceId: endpoint.instance.workspaceId,
          packageVersion: endpoint.instance.packageVersion,
          status: endpoint.instance.status
        }
      : selectedUnity;

    await writeDaemonRegistry({
      registryDir,
      host,
      port,
      pid: process.pid,
      packageName: metadata.packageName,
      packageVersion: metadata.packageVersion,
      gitHead: metadata.gitHead,
      entrypoint: metadata.entrypoint,
      nodeVersion: metadata.nodeVersion,
      selectedUnity,
      targets: describeTargets(),
      lastError
    });
  };

  if (options.connectToUnity !== false) {
    try {
      await unityConnection.connect();
    } catch (error) {
      lastError = error.message;
      logger.error('Initial daemon Unity connection failed:', error.message);
    }
  }

  await writeRegistry();
  const heartbeat = setInterval(() => {
    writeRegistry().catch((error) => {
      lastError = error.message;
      logger.warn(`Daemon registry heartbeat failed: ${error.message}`);
    });
  }, options.heartbeatMs || config.daemon.heartbeatMs);
  heartbeat.unref?.();

  const close = async () => {
    clearInterval(heartbeat);
    await new Promise((resolve) => httpServer.close(resolve));
    const activeSessions = Array.from(sessions.values());
    sessions.clear();
    await Promise.all(activeSessions.map((session) => closeMcpSession(session)));
    for (const entry of connections.values()) {
      entry.connection.disconnect();
    }
    await removeDaemonRegistry({ registryDir });
  };

  return {
    sessions,
    unityConnection,
    httpServer,
    host,
    port,
    url: `http://${host}:${port}/mcp`,
    healthUrl: `http://${host}:${port}/health`,
    close
  };
}

async function handleMcpRequest(req, res, options) {
  const sessionId = getSessionId(req);

  if (req.method === 'GET' || req.method === 'DELETE') {
    const session = sessionId ? options.sessions.get(sessionId) : null;
    if (!session) {
      writeJsonRpcError(res, 400, -32000, 'Invalid or missing MCP session ID');
      return;
    }
    await session.transport.handleRequest(req, res);
    return;
  }

  if (req.method !== 'POST') {
    writeJsonRpcError(res, 405, -32000, 'Method not allowed');
    return;
  }

  let parsedBody;
  try {
    parsedBody = await readJsonBody(req, {
      maxBodyBytes: options.maxBodyBytes
    });
  } catch (error) {
    if (error.code === 'DAEMON_REQUEST_TOO_LARGE') {
      writeJsonRpcError(res, 413, -32000, `${error.code}: ${error.message}`);
      return;
    }
    throw error;
  }
  let session = sessionId ? options.sessions.get(sessionId) : null;

  if (!session && !sessionId && isInitializeRequest(parsedBody)) {
    session = await createMcpSession(options, readTargetFromHeaders(req.headers));
  }

  if (!session) {
    writeJsonRpcError(res, 400, -32000, 'Invalid or missing MCP session ID');
    return;
  }

  await session.transport.handleRequest(req, res, parsedBody);
}

async function createMcpSession(options, target = null) {
  let sessionId = null;
  const handlers = createHandlers(options.getConnectionEntry(target).connection);
  const server = createDaemonMcpServer(handlers);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: options.sessionIdGenerator,
    enableDnsRebindingProtection: true,
    allowedHosts: createAllowedHosts(options),
    allowedOrigins: createAllowedOrigins(options),
    onsessioninitialized: (initializedSessionId) => {
      sessionId = initializedSessionId;
      options.sessions.set(initializedSessionId, session);
    }
  });
  const session = { server, transport, closing: false };

  transport.onclose = () => {
    const sid = transport.sessionId || sessionId;
    if (sid) {
      options.sessions.delete(sid);
    }
    if (!session.closing) {
      closeMcpSession(session);
    }
  };

  await server.connect(transport);
  return session;
}

async function closeMcpSession(session) {
  if (session.closing) {
    return;
  }

  session.closing = true;
  await session.transport.close().catch(() => {});
  await session.server.close().catch(() => {});
}

function createDaemonMcpServer(handlers) {
  const server = new Server(
    {
      name: `${config.server.name}-daemon`,
      version: config.server.version
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );
  registerMcpHandlers(server, handlers, { logger });
  return server;
}

function getSessionId(req) {
  const header = req.headers['mcp-session-id'];
  return Array.isArray(header) ? header[0] : header;
}

async function readJsonBody(req, options = {}) {
  const chunks = [];
  const maxBodyBytes = options.maxBodyBytes ?? config.daemon.maxBodyBytes;
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > maxBodyBytes) {
      const error = new Error(`Daemon MCP request body exceeds ${maxBodyBytes} bytes`);
      error.code = 'DAEMON_REQUEST_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) {
    return undefined;
  }

  return JSON.parse(raw);
}

function writeJsonRpcError(res, httpStatus, code, message) {
  if (!res.headersSent) {
    res.writeHead(httpStatus, { 'content-type': 'application/json' });
  }
  res.end(JSON.stringify({
    jsonrpc: '2.0',
    error: { code, message },
    id: null
  }));
}

function createAllowedHosts(options = {}) {
  const port = options.port;
  const hosts = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`
  ]);

  if (options.host && options.host !== '::1') {
    hosts.add(`${options.host}:${port}`);
  }
  if (options.host === '::1') {
    hosts.add(`[::1]:${port}`);
  }

  return Array.from(hosts);
}

function createAllowedOrigins(options = {}) {
  const port = options.port;
  const origins = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`
  ]);

  if (options.host && options.host !== '::1') {
    origins.add(`http://${options.host}:${port}`);
  }
  if (options.host === '::1') {
    origins.add(`http://[::1]:${port}`);
  }

  return Array.from(origins);
}

export async function startDaemonCli(options = {}) {
  const daemon = await startDaemonServer(options);
  logger.info(`Unity MCP daemon listening on ${daemon.url}`);

  const shutdown = async () => {
    await daemon.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return daemon;
}
