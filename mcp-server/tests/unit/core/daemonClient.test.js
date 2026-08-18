import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'fs/promises';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  ensureDaemon,
  getExpectedDaemonMetadata
} from '../../../src/core/daemonClient.js';
import {
  getDaemonRegistryPath,
  getDaemonLockPath,
  getDaemonLogPath,
  readDaemonRegistry,
  writeDaemonRegistry
} from '../../../src/core/daemonRegistry.js';

describe('daemon client', () => {
  const tempDirs = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => fsp.rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
    mock.restoreAll();
  });

  async function makeTempDir() {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'unity-mcp-daemon-client-'));
    tempDirs.push(dir);
    return dir;
  }

  it('serializes concurrent daemon starts with a single spawn lock', async () => {
    const registryDir = await makeTempDir();
    const metadata = getExpectedDaemonMetadata();
    const spawnDaemon = mock.fn(() => {
      writeDaemonRegistrySync({
        registryDir,
        pid: 4242,
        port: 49152,
        packageVersion: metadata.packageVersion,
        gitHead: metadata.gitHead,
        entrypoint: metadata.entrypoint,
        nodeVersion: metadata.nodeVersion
      });
      return { pid: 4242 };
    });

    const options = {
      registryDir,
      startupTimeoutMs: 15000,
      pollIntervalMs: 1,
      healthTimeoutMs: 1,
      spawnDaemon,
      isProcessAlive: () => true,
      getHealth: async (registry) => registry ? createHealth(registry, metadata) : null,
      sleepMs: async () => {}
    };

    const [first, second] = await Promise.all([
      ensureDaemon(options),
      ensureDaemon(options)
    ]);

    assert.equal(spawnDaemon.mock.calls.length, 1);
    assert.equal(first.registry.port, 49152);
    assert.equal(second.registry.port, 49152);
    assert.equal(fs.existsSync(getDaemonLockPath({ registryDir })), false);
  });

  it('reuses a healthy daemon when metadata matches the current server source', async () => {
    const registryDir = await makeTempDir();
    const metadata = getExpectedDaemonMetadata();
    await writeDaemonRegistry({
      registryDir,
      pid: 4243,
      port: 49153,
      packageVersion: metadata.packageVersion,
      gitHead: metadata.gitHead,
      entrypoint: metadata.entrypoint,
      nodeVersion: metadata.nodeVersion
    });
    const spawnDaemon = mock.fn();

    const result = await ensureDaemon({
      registryDir,
      startupTimeoutMs: 50,
      pollIntervalMs: 1,
      healthTimeoutMs: 1,
      spawnDaemon,
      isProcessAlive: () => true,
      getHealth: async (registry) => createHealth(registry, metadata)
    });

    assert.equal(result.started, false);
    assert.equal(spawnDaemon.mock.calls.length, 0);
  });

  it('does not spawn a replacement while the registered daemon is alive but health is unavailable', async () => {
    const registryDir = await makeTempDir();
    const metadata = getExpectedDaemonMetadata();
    await writeDaemonRegistry({
      registryDir,
      pid: 4260,
      port: 49157,
      packageVersion: metadata.packageVersion,
      gitHead: metadata.gitHead,
      entrypoint: metadata.entrypoint,
      nodeVersion: metadata.nodeVersion
    });
    const spawnDaemon = mock.fn();

    await assert.rejects(
      ensureDaemon({
        registryDir,
        startupTimeoutMs: 10,
        pollIntervalMs: 1,
        healthTimeoutMs: 1,
        spawnDaemon,
        isProcessAlive: () => true,
        getHealth: async () => null,
        sleepMs: async () => {}
      }),
      (error) => {
        assert.equal(error.code, 'DAEMON_HEALTH_UNAVAILABLE');
        assert.equal(error.registryDir, registryDir);
        assert.equal(error.pid, 4260);
        assert.match(error.healthUrl, /49157\/health/);
        assert.equal(error.lockPath, getDaemonLockPath({ registryDir }));
        assert.equal(error.logPath, getDaemonLogPath({ registryDir }));
        return true;
      }
    );
    assert.equal(spawnDaemon.mock.calls.length, 0);
  });

  it('replaces a healthy daemon when package version or git head is stale', async () => {
    const registryDir = await makeTempDir();
    const metadata = getExpectedDaemonMetadata();
    await writeDaemonRegistry({
      registryDir,
      pid: 4244,
      port: 49154,
      packageVersion: '0.0.0-old',
      gitHead: 'oldsha',
      entrypoint: metadata.entrypoint,
      nodeVersion: metadata.nodeVersion
    });
    const stopped = [];
    const alive = new Set([4244]);
    const spawnDaemon = mock.fn(() => {
      alive.add(4245);
      writeDaemonRegistrySync({
        registryDir,
        pid: 4245,
        port: 49155,
        packageVersion: metadata.packageVersion,
        gitHead: metadata.gitHead,
        entrypoint: metadata.entrypoint,
        nodeVersion: metadata.nodeVersion
      });
      return { pid: 4245 };
    });

    const result = await ensureDaemon({
      registryDir,
      startupTimeoutMs: 5000,
      pollIntervalMs: 1,
      healthTimeoutMs: 1,
      spawnDaemon,
      isProcessAlive: (pid) => alive.has(Number(pid)),
      terminateProcess: async (pid) => {
        stopped.push(pid);
        alive.delete(Number(pid));
      },
      getHealth: async (registry) => createHealth(registry, metadata),
      sleepMs: async () => {}
    });

    assert.deepEqual(stopped, [4244]);
    assert.equal(spawnDaemon.mock.calls.length, 1);
    assert.equal(result.registry.pid, 4245);
  });

  it('returns current and running metadata when a mismatched daemon cannot be replaced', async () => {
    const registryDir = await makeTempDir();
    const metadata = getExpectedDaemonMetadata();
    await writeDaemonRegistry({
      registryDir,
      pid: 4250,
      port: 49156,
      packageVersion: '0.0.0-old',
      gitHead: 'oldsha',
      entrypoint: metadata.entrypoint,
      nodeVersion: metadata.nodeVersion
    });

    await assert.rejects(
      ensureDaemon({
        registryDir,
        startupTimeoutMs: 25,
        pollIntervalMs: 1,
        healthTimeoutMs: 1,
        processExitTimeoutMs: 5,
        isProcessAlive: () => true,
        terminateProcess: async () => {},
        getHealth: async (registry) => createHealth(registry, metadata),
        sleepMs: async () => {}
      }),
      (error) => {
        assert.equal(error.code, 'DAEMON_VERSION_MISMATCH');
        assert.equal(error.current.packageVersion, metadata.packageVersion);
        assert.equal(error.running.packageVersion, '0.0.0-old');
        assert.equal(error.mismatch.field, 'packageVersion');
        return true;
      }
    );
  });

  it('removes stale locks before spawning and keeps fresh locks from spawning another daemon', async () => {
    const registryDir = await makeTempDir();
    const staleLockPath = getDaemonLockPath({ registryDir });
    await fsp.mkdir(registryDir, { recursive: true });
    await fsp.writeFile(staleLockPath, JSON.stringify({
      pid: 5555,
      createdAt: new Date(Date.now() - 60000).toISOString()
    }));
    const spawnDaemon = mock.fn(() => ({ pid: 4246 }));

    await assert.rejects(
      ensureDaemon({
        registryDir,
        startupTimeoutMs: 5,
        pollIntervalMs: 1,
        healthTimeoutMs: 1,
        spawnDaemon,
        isProcessAlive: () => false,
        getHealth: async () => null,
        sleepMs: async () => {}
      }),
      { code: 'DAEMON_START_TIMEOUT' }
    );
    assert.equal(spawnDaemon.mock.calls.length, 1);

    await fsp.writeFile(staleLockPath, JSON.stringify({
      pid: 7777,
      createdAt: new Date(Date.now() + 60000).toISOString()
    }));
    const blockedSpawn = mock.fn();
    await assert.rejects(
      ensureDaemon({
        registryDir,
        startupTimeoutMs: 5,
        pollIntervalMs: 1,
        healthTimeoutMs: 1,
        spawnDaemon: blockedSpawn,
        isProcessAlive: () => true,
        getHealth: async () => null,
        sleepMs: async () => {}
      }),
      { code: 'DAEMON_START_TIMEOUT' }
    );
    assert.equal(blockedSpawn.mock.calls.length, 0);
  });

  it('includes lock and log paths in daemon startup timeout diagnostics', async () => {
    const registryDir = await makeTempDir();

    await assert.rejects(
      ensureDaemon({
        registryDir,
        startupTimeoutMs: 5,
        pollIntervalMs: 1,
        healthTimeoutMs: 1,
        spawnDaemon: () => ({ pid: 4247 }),
        isProcessAlive: () => false,
        getHealth: async () => null,
        sleepMs: async () => {}
      }),
      (error) => {
        assert.equal(error.code, 'DAEMON_START_TIMEOUT');
        assert.equal(error.registryDir, registryDir);
        assert.equal(error.lockPath, getDaemonLockPath({ registryDir }));
        assert.equal(error.logPath, getDaemonLogPath({ registryDir }));
        assert.match(error.message, /cleanup-stale/);
        return true;
      }
    );
  });
});

function createHealth(registry, metadata) {
  return {
    status: 'ok',
    pid: registry.pid,
    server: {
      packageVersion: registry.packageVersion ?? metadata.packageVersion,
      gitHead: registry.gitHead ?? metadata.gitHead,
      entrypoint: registry.entrypoint ?? metadata.entrypoint,
      nodeVersion: registry.nodeVersion ?? metadata.nodeVersion
    }
  };
}

function writeDaemonRegistrySync(data) {
  const registryDir = data.registryDir;
  const now = new Date().toISOString();
  const registry = {
    schemaVersion: 1,
    pid: data.pid,
    host: data.host || '127.0.0.1',
    port: data.port,
    url: data.url || `http://${data.host || '127.0.0.1'}:${data.port}/mcp`,
    healthUrl: data.healthUrl || `http://${data.host || '127.0.0.1'}:${data.port}/health`,
    packageName: data.packageName || null,
    packageVersion: data.packageVersion || data.version || null,
    version: data.packageVersion || data.version || null,
    gitHead: data.gitHead || null,
    entrypoint: data.entrypoint || null,
    nodeVersion: data.nodeVersion || null,
    startedAt: data.startedAt || now,
    lastSeen: data.lastSeen || now,
    selectedUnity: data.selectedUnity || null,
    lastError: data.lastError || null
  };

  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(getDaemonRegistryPath({ registryDir }), JSON.stringify(registry, null, 2));
  return registry;
}
