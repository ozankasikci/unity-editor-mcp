import { spawn } from 'child_process';
import fs from 'fs';
import fsp from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { config, logger } from './config.js';
import {
  getDaemonLockPath,
  getDaemonLogPath,
  isProcessAlive,
  readDaemonRegistry,
  removeDaemonRegistry
} from './daemonRegistry.js';
import { getServerMetadata } from './serverMetadata.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverEntryPath = path.join(__dirname, 'server.js');

export function getExpectedDaemonMetadata() {
  return {
    ...getServerMetadata(),
    entrypoint: serverEntryPath
  };
}

export async function getDaemonHealth(registry, options = {}) {
  if (!registry?.healthUrl) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 1000);
  try {
    const response = await fetch(registry.healthUrl, { signal: controller.signal });
    if (!response.ok) {
      return null;
    }
    return response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function ensureDaemon(options = {}) {
  const daemonConfig = { ...config.daemon, ...options };
  const expectedMetadata = options.expectedMetadata || getExpectedDaemonMetadata();
  const getHealth = options.getHealth || getDaemonHealth;
  const processAlive = options.isProcessAlive || isProcessAlive;
  const sleepFn = options.sleepMs || sleep;
  const spawnDaemon = options.spawnDaemon || startDaemonProcess;
  const deadline = Date.now() + daemonConfig.startupTimeoutMs;
  let triedReplacingMismatchedDaemon = false;
  let lastHealthUnavailableDaemon = null;

  do {
    const existing = await inspectExistingDaemon({
      daemonConfig,
      expectedMetadata,
      getHealth,
      processAlive
    });
    if (existing?.usable) {
      return { registry: existing.registry, health: existing.health, started: false };
    }

    if (existing?.mismatch) {
      if (triedReplacingMismatchedDaemon) {
        throw createVersionMismatchError(existing, daemonConfig, expectedMetadata);
      }
      triedReplacingMismatchedDaemon = true;
      try {
        await stopMismatchedDaemon(existing.registry, {
          processAlive,
          terminateProcess: options.terminateProcess,
          timeoutMs: options.processExitTimeoutMs ?? 1500
        });
      } catch (error) {
        const mismatchError = createVersionMismatchError(existing, daemonConfig, expectedMetadata);
        mismatchError.cause = error;
        throw mismatchError;
      }
      await removeDaemonRegistry({ registryDir: daemonConfig.registryDir });
      continue;
    }

    if (existing?.healthUnavailable) {
      lastHealthUnavailableDaemon = existing;
      await sleepFn(daemonConfig.pollIntervalMs);
      continue;
    }

    if (daemonConfig.autoStart === false) {
      const error = new Error('Unity MCP daemon is not running and auto-start is disabled');
      error.code = 'DAEMON_NOT_RUNNING';
      throw error;
    }

    const lock = await acquireDaemonSpawnLock(daemonConfig, { processAlive });
    if (!lock.acquired) {
      await sleepFn(daemonConfig.pollIntervalMs);
      continue;
    }

    try {
      spawnDaemon({
        ...daemonConfig,
        logPath: getDaemonLogPath({ registryDir: daemonConfig.registryDir })
      });
      const started = await waitForHealthyDaemon({
        daemonConfig,
        expectedMetadata,
        getHealth,
        processAlive,
        sleepFn,
        deadline
      });
      if (started) {
        return { ...started, started: true };
      }
    } finally {
      await releaseDaemonSpawnLock(lock);
    }
  } while (Date.now() < deadline);

  if (lastHealthUnavailableDaemon) {
    throw createHealthUnavailableError(lastHealthUnavailableDaemon, daemonConfig);
  }

  throw createStartTimeoutError(daemonConfig);
}

async function inspectExistingDaemon({ daemonConfig, expectedMetadata, getHealth, processAlive }) {
  const registry = await readDaemonRegistry({ registryDir: daemonConfig.registryDir });
  if (!registry) {
    return null;
  }

  if (!processAlive(registry.pid)) {
    await removeDaemonRegistry({ registryDir: daemonConfig.registryDir });
    return null;
  }

  const health = await getHealth(registry, { timeoutMs: daemonConfig.healthTimeoutMs });
  if (!health) {
    return { registry, healthUnavailable: true };
  }

  const mismatch = findDaemonMetadataMismatch(expectedMetadata, registry, health);
  if (mismatch) {
    return { registry, health, mismatch };
  }

  return { registry, health, usable: true };
}

async function waitForHealthyDaemon({ daemonConfig, expectedMetadata, getHealth, processAlive, sleepFn, deadline }) {
  do {
    await sleepFn(daemonConfig.pollIntervalMs);
    const registry = await readDaemonRegistry({ registryDir: daemonConfig.registryDir });
    if (!registry || !processAlive(registry.pid)) {
      continue;
    }

    const health = await getHealth(registry, { timeoutMs: daemonConfig.healthTimeoutMs });
    if (!health) {
      continue;
    }

    const mismatch = findDaemonMetadataMismatch(expectedMetadata, registry, health);
    if (mismatch) {
      throw createVersionMismatchError({ registry, health, mismatch }, daemonConfig, expectedMetadata);
    }

    return { registry, health };
  } while (Date.now() < deadline);

  return null;
}

export function startDaemonProcess(options = {}) {
  const daemonConfig = { ...config.daemon, ...options };
  const logPath = daemonConfig.logPath || getDaemonLogPath({ registryDir: daemonConfig.registryDir });
  const args = [
    serverEntryPath,
    'daemon',
    '--daemon-port',
    String(daemonConfig.port),
    '--daemon-registry-dir',
    daemonConfig.registryDir
  ];

  fs.mkdirSync(daemonConfig.registryDir, { recursive: true });
  const logFd = fs.openSync(logPath, 'a');
  let child;
  try {
    child = spawn(process.execPath, args, {
      cwd: path.resolve(__dirname, '..', '..'),
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        UNITY_MCP_DAEMON_AUTOSTART: 'false'
      }
    });
  } finally {
    fs.closeSync(logFd);
  }

  child.unref();
  logger.info(`Started Unity MCP daemon process ${child.pid}; logging to ${logPath}`);
  return child;
}

export function buildTargetHeaders(target = {}) {
  const headers = {};
  if (target?.projectPath) {
    headers['x-unity-mcp-project-path'] = encodeURIComponent(target.projectPath);
  }
  if (target?.instanceId) {
    headers['x-unity-mcp-instance-id'] = encodeURIComponent(target.instanceId);
  }
  if (target?.workspaceId) {
    headers['x-unity-mcp-workspace-id'] = encodeURIComponent(target.workspaceId);
  }
  return headers;
}

export async function createDaemonMcpClient(options = {}) {
  const { registry } = await ensureDaemon(options);
  const client = new Client(
    {
      name: `${config.server.name}-stdio-shim`,
      version: config.server.version
    },
    {
      capabilities: {}
    }
  );
  const headers = buildTargetHeaders(options.target);
  const transport = new StreamableHTTPClientTransport(
    new URL(registry.url),
    Object.keys(headers).length > 0 ? { requestInit: { headers } } : undefined
  );
  await client.connect(transport);
  return { client, transport, registry };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireDaemonSpawnLock(daemonConfig, options = {}) {
  const registryDir = daemonConfig.registryDir;
  const lockPath = getDaemonLockPath({ registryDir });
  await fsp.mkdir(registryDir, { recursive: true });

  try {
    await fsp.writeFile(lockPath, JSON.stringify({
      pid: process.pid,
      createdAt: new Date().toISOString()
    }, null, 2), {
      flag: 'wx',
      mode: 0o600
    });
    return { acquired: true, lockPath };
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }

  if (await isDaemonLockStale(lockPath, daemonConfig, options)) {
    await fsp.rm(lockPath, { force: true });
    return acquireDaemonSpawnLock(daemonConfig, options);
  }

  return { acquired: false, lockPath };
}

async function releaseDaemonSpawnLock(lock) {
  if (!lock?.acquired || !lock.lockPath) {
    return;
  }

  await fsp.rm(lock.lockPath, { force: true });
}

export async function isDaemonLockStale(lockPath, daemonConfig, options = {}) {
  const processAlive = options.processAlive || isProcessAlive;
  try {
    const lock = JSON.parse(await fsp.readFile(lockPath, 'utf8'));
    const createdAtMs = Date.parse(lock.createdAt);
    const tooOld = !Number.isFinite(createdAtMs) ||
      Date.now() - createdAtMs > daemonConfig.startupTimeoutMs;
    return tooOld || !processAlive(lock.pid);
  } catch {
    return true;
  }
}

function findDaemonMetadataMismatch(expectedMetadata, registry, health) {
  const running = getRunningDaemonMetadata(registry, health);
  const comparisons = [
    ['packageVersion', expectedMetadata.packageVersion, running.packageVersion],
    ['gitHead', expectedMetadata.gitHead, running.gitHead],
    ['entrypoint', normalizePath(expectedMetadata.entrypoint), normalizePath(running.entrypoint)]
  ];

  for (const [field, expected, actual] of comparisons) {
    if (!expected || expected === 'unknown') {
      continue;
    }
    if (!actual || actual !== expected) {
      return { field, expected, actual: actual || null, running };
    }
  }

  return null;
}

function getRunningDaemonMetadata(registry, health) {
  const server = health?.server || {};
  return {
    packageVersion: server.packageVersion || server.version || registry.packageVersion || registry.version || null,
    gitHead: server.gitHead || registry.gitHead || null,
    entrypoint: server.entrypoint || registry.entrypoint || null,
    nodeVersion: server.nodeVersion || registry.nodeVersion || null
  };
}

function normalizePath(value) {
  return value ? path.resolve(value) : value;
}

async function stopMismatchedDaemon(registry, options = {}) {
  const processAlive = options.processAlive || isProcessAlive;
  const terminateProcess = options.terminateProcess || ((pid) => process.kill(Number(pid), 'SIGTERM'));
  await terminateProcess(registry.pid);
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(registry.pid)) {
      return;
    }
    await sleep(50);
  }

  if (processAlive(registry.pid)) {
    const error = new Error(`Timed out stopping stale Unity MCP daemon process ${registry.pid}`);
    error.code = 'DAEMON_VERSION_MISMATCH';
    error.pid = registry.pid;
    throw error;
  }
}

function createVersionMismatchError(existing, daemonConfig, expectedMetadata) {
  const error = new Error('Unity MCP daemon is running a different server source; run `unity-editor-mcp cleanup-stale`, then try again.');
  error.code = 'DAEMON_VERSION_MISMATCH';
  error.registryDir = daemonConfig.registryDir;
  error.lockPath = getDaemonLockPath({ registryDir: daemonConfig.registryDir });
  error.logPath = getDaemonLogPath({ registryDir: daemonConfig.registryDir });
  error.current = expectedMetadata;
  error.running = existing.mismatch?.running || getRunningDaemonMetadata(existing.registry, existing.health);
  error.mismatch = existing.mismatch;
  return error;
}

function createStartTimeoutError(daemonConfig) {
  const error = new Error(
    'Timed out waiting for Unity MCP daemon to start. ' +
    'Run `unity-editor-mcp doctor`, `unity-editor-mcp cleanup-stale`, or set UNITY_MCP_USE_DAEMON=false for direct stdio mode.'
  );
  error.code = 'DAEMON_START_TIMEOUT';
  error.registryDir = daemonConfig.registryDir;
  error.lockPath = getDaemonLockPath({ registryDir: daemonConfig.registryDir });
  error.logPath = getDaemonLogPath({ registryDir: daemonConfig.registryDir });
  return error;
}

function createHealthUnavailableError(existing, daemonConfig) {
  const error = new Error(
    'Registered Unity MCP daemon process is alive but its health endpoint did not respond. ' +
    'Run `unity-editor-mcp doctor` or `unity-editor-mcp cleanup-stale` if this persists.'
  );
  error.code = 'DAEMON_HEALTH_UNAVAILABLE';
  error.registryDir = daemonConfig.registryDir;
  error.pid = existing.registry.pid;
  error.healthUrl = existing.registry.healthUrl;
  error.lockPath = getDaemonLockPath({ registryDir: daemonConfig.registryDir });
  error.logPath = getDaemonLogPath({ registryDir: daemonConfig.registryDir });
  return error;
}
