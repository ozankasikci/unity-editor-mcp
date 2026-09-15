#!/usr/bin/env node
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { UnityConnection } from './unityConnection.js';
import { registerMcpHandlers } from './mcpRegistration.js';
import { registerDaemonProxyHandlers } from './daemonProxy.js';
import { createDaemonMcpClient } from './daemonClient.js';
import { findUnityProjectRoot } from './unityDiscovery.js';
import { startDaemonCli } from './daemonServer.js';
import { createHandlers } from '../handlers/index.js';
import { config, logger } from './config.js';

export async function main() {
  if (process.argv.includes('daemon')) {
    await startDaemonCli();
    return;
  }

  if (config.daemon.enabled) {
    await startStdioDaemonProxy();
    return;
  }

  await startDirectStdioServer();
}

export async function startStdioDaemonProxy(customConfig = config, options = {}) {
  let cachedClient = null;
  let cachedTransport = null;
  const server = new Server(
    {
      name: customConfig.server.name,
      version: customConfig.server.version,
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  const discovery = customConfig.unity?.discovery || {};
  const shimTarget = {
    projectPath: discovery.projectPath || findUnityProjectRoot(discovery.cwd || process.cwd()) || '',
    instanceId: discovery.instanceId || '',
    workspaceId: discovery.workspaceId || ''
  };
  logger.info(`Stdio shim Unity target: ${JSON.stringify(shimTarget)}`);

  registerDaemonProxyHandlers(server, {
    getClient: async ({ forceRefresh } = {}) => {
      if (cachedClient && !forceRefresh) {
        return cachedClient;
      }

      if (forceRefresh) {
        await closeQuietly(cachedTransport);
        await closeQuietly(cachedClient);
        cachedClient = null;
        cachedTransport = null;
      }

      const connection = await createDaemonMcpClient({
        ...customConfig.daemon,
        ...(options.daemon || {}),
        target: shimTarget
      });
      cachedClient = connection.client;
      cachedTransport = connection.transport;
      return cachedClient;
    },
    onClientError: async (error, context = {}) => {
      logger.warn(`Daemon MCP ${context.method || 'request'} failed; refreshing shim transport: ${error.message}`);
    }
  });

  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info('MCP stdio shim connected to Unity MCP daemon');

    const shutdown = async () => {
      logger.info('Shutting down stdio daemon proxy...');
      await cachedTransport?.close?.();
      await cachedClient?.close?.();
      await server.close();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return { server, get cachedClient() { return cachedClient; } };
  } catch (error) {
    console.error('Failed to start server:', error);
    console.error('Stack trace:', error.stack);
    process.exit(1);
  }
}

async function closeQuietly(target) {
  try {
    await target?.close?.();
  } catch {
    // Best-effort cleanup before reconnecting the shim to the daemon.
  }
}

export async function startDirectStdioServer(customConfig = config) {
  const { server, unityConnection } = await createServer(customConfig);
  unityConnection.on('connected', () => {
    logger.info('Unity connection established');
  });

  unityConnection.on('disconnected', () => {
    logger.info('Unity connection lost');
  });

  unityConnection.on('error', (error) => {
    logger.error('Unity connection error:', error.message);
  });

  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info('MCP direct stdio server started successfully');

    try {
      await unityConnection.connect();
    } catch (error) {
      logger.error('Initial Unity connection failed:', error.message);
      logger.info('Unity connection will retry automatically');
    }

    const shutdown = async () => {
      logger.info('Shutting down...');
      unityConnection.disconnect();
      await server.close();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return { server, unityConnection };
  } catch (error) {
    console.error('Failed to start server:', error);
    console.error('Stack trace:', error.stack);
    process.exit(1);
  }
}

export async function createServer(customConfig = config) {
  const testUnityConnection = new UnityConnection({ config: customConfig });
  const testHandlers = createHandlers(testUnityConnection);
  
  const testServer = new Server(
    {
      name: customConfig.server.name,
      version: customConfig.server.version,
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );
  
  registerMcpHandlers(testServer, testHandlers, { logger });
  
  return {
    server: testServer,
    unityConnection: testUnityConnection
  };
}

// Start the server
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    console.error('Stack trace:', error.stack);
    process.exit(1);
  });
}
