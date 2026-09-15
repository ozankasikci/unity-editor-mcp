import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

export function getDefaultDaemonRegistryDir() {
  return path.join(os.homedir(), '.unity-editor-mcp');
}

export function getDaemonRegistryPath(options = {}) {
  return path.join(options.registryDir || getDefaultDaemonRegistryDir(), 'daemon.json');
}

export function getDaemonLockPath(options = {}) {
  return path.join(options.registryDir || getDefaultDaemonRegistryDir(), 'daemon.lock');
}

export function getDaemonLogPath(options = {}) {
  return path.join(options.registryDir || getDefaultDaemonRegistryDir(), 'daemon.log');
}

export async function readDaemonRegistry(options = {}) {
  try {
    const registryPath = getDaemonRegistryPath(options);
    return JSON.parse(await fsp.readFile(registryPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function writeDaemonRegistry(data, options = {}) {
  const registryDir = data.registryDir || options.registryDir || getDefaultDaemonRegistryDir();
  const registryPath = getDaemonRegistryPath({ registryDir });
  const tempPath = `${registryPath}.${process.pid}.tmp`;
  const now = new Date().toISOString();
  const existing = await readDaemonRegistry({ registryDir }).catch(() => null);
  const registry = {
    schemaVersion: 1,
    pid: data.pid ?? process.pid,
    host: data.host || '127.0.0.1',
    port: data.port,
    url: data.url || (data.port ? `http://${data.host || '127.0.0.1'}:${data.port}/mcp` : undefined),
    healthUrl: data.healthUrl || (data.port ? `http://${data.host || '127.0.0.1'}:${data.port}/health` : undefined),
    packageName: data.packageName || null,
    packageVersion: data.packageVersion || data.version || null,
    version: data.packageVersion || data.version || null,
    gitHead: data.gitHead || null,
    entrypoint: data.entrypoint || null,
    nodeVersion: data.nodeVersion || null,
    startedAt: data.startedAt || existing?.startedAt || now,
    lastSeen: data.lastSeen || now,
    selectedUnity: data.selectedUnity || null,
    targets: data.targets || [],
    lastError: data.lastError || null
  };

  await fsp.mkdir(registryDir, { recursive: true });
  await fsp.writeFile(tempPath, JSON.stringify(registry, null, 2));
  await fsp.rename(tempPath, registryPath);
  return registry;
}

export async function removeDaemonRegistry(options = {}) {
  await fsp.rm(getDaemonRegistryPath(options), { force: true });
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) {
    return false;
  }

  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

export function isRegistryFresh(registry, staleAfterMs) {
  if (!registry?.lastSeen) {
    return false;
  }

  const lastSeenMs = Date.parse(registry.lastSeen);
  return Number.isFinite(lastSeenMs) && Date.now() - lastSeenMs <= staleAfterMs;
}

export function summarizeDaemonRegistry(registry, options = {}) {
  const staleAfterMs = options.staleAfterMs ?? 30000;
  if (!registry) {
    return {
      status: 'missing',
      message: 'No Unity MCP daemon registry was found.'
    };
  }

  const alive = isProcessAlive(registry.pid);
  const fresh = isRegistryFresh(registry, staleAfterMs);
  return {
    status: alive && fresh ? 'ok' : 'stale',
    alive,
    fresh,
    pid: registry.pid,
    port: registry.port,
    url: registry.url,
    packageName: registry.packageName,
    packageVersion: registry.packageVersion || registry.version,
    version: registry.packageVersion || registry.version,
    gitHead: registry.gitHead,
    entrypoint: registry.entrypoint,
    nodeVersion: registry.nodeVersion,
    startedAt: registry.startedAt,
    lastSeen: registry.lastSeen,
    selectedUnity: registry.selectedUnity,
    targets: registry.targets || [],
    lastError: registry.lastError,
    message: alive && fresh
      ? 'Unity MCP daemon is alive and fresh.'
      : 'Unity MCP daemon registry is stale or the process is not alive.'
  };
}
