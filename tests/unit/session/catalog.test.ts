import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { acquireAppRuntimeLock, readRuntimeLockMeta } from '../../../src/runtime/locks';
import { readAndPrune, register } from '../../../src/runtime/registry';
import {
  SessionCatalog,
  sessionCatalogKey,
} from '../../../src/session/catalog.js';

const cleanups: Array<() => Promise<void>> = [];

describe('agent-aware session catalog', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('keys entries by scope, agent, cwd realpath, and policy fingerprint', () => {
    expect(
      sessionCatalogKey({
        scopeId: 'chat-1',
        agentId: 'claude',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
      }),
    ).toBe('chat-1\x1fclaude\x1f/repo\x1ffp-1');
  });

  it('stores Claude sessions and Codex threads in isolated active entries', async () => {
    const catalog = new SessionCatalog(await path());

    catalog.upsertActive({
      scopeId: 'chat-1',
      agentId: 'claude',
      cwdRealpath: '/repo',
      policyFingerprint: 'fp-1',
      sessionId: 'sess-1',
      now: 1000,
    });
    catalog.upsertActive({
      scopeId: 'chat-1',
      agentId: 'codex',
      cwdRealpath: '/repo',
      policyFingerprint: 'fp-1',
      threadId: 'thread-1',
      now: 2000,
    });

    expect(
      catalog.activeFor({
        scopeId: 'chat-1',
        agentId: 'claude',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
      }),
    ).toMatchObject({ sessionId: 'sess-1', agentId: 'claude' });
    expect(
      catalog.activeFor({
        scopeId: 'chat-1',
        agentId: 'codex',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
      }),
    ).toMatchObject({ threadId: 'thread-1', agentId: 'codex' });
    await catalog.flush();
  });

  it('rejects mismatched Claude/Codex identity fields and does not auto-resume damaged entries', async () => {
    const catalog = new SessionCatalog(await path());

    expect(() =>
      catalog.upsertActive({
        scopeId: 'chat-1',
        agentId: 'claude',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
        threadId: 'thread-wrong',
        now: 1000,
      }),
    ).toThrow(/Claude.*sessionId/i);
    expect(() =>
      catalog.upsertActive({
        scopeId: 'chat-1',
        agentId: 'codex',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
        sessionId: 'sess-wrong',
        now: 1000,
      }),
    ).toThrow(/Codex.*threadId/i);

    await catalog.replaceForTest([
      {
        key: sessionCatalogKey({
          scopeId: 'chat-1',
          agentId: 'codex',
          cwdRealpath: '/repo',
          policyFingerprint: 'fp-1',
        }),
        scopeId: 'chat-1',
        agentId: 'codex',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
        sessionId: 'sess-damaged',
        status: 'active',
        updatedAt: 1000,
      },
    ]);

    expect(
      catalog.activeFor({
        scopeId: 'chat-1',
        agentId: 'codex',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
      }),
    ).toBeUndefined();
    await catalog.flush();
  });

  it('archives only the current agent/cwd/fingerprint entry for a new conversation', async () => {
    const catalog = new SessionCatalog(await path());
    const base = {
      scopeId: 'chat-1',
      cwdRealpath: '/repo',
      policyFingerprint: 'fp-1',
    };
    catalog.upsertActive({ ...base, agentId: 'claude', sessionId: 'sess-1', now: 1000 });
    catalog.upsertActive({ ...base, agentId: 'codex', threadId: 'thread-1', now: 1000 });

    expect(catalog.archiveActive({ ...base, agentId: 'claude', now: 2000 })).toBe(true);

    expect(catalog.activeFor({ ...base, agentId: 'claude' })).toBeUndefined();
    expect(catalog.activeFor({ ...base, agentId: 'codex' })).toMatchObject({
      threadId: 'thread-1',
    });
    expect(catalog.entries().filter((entry) => entry.status === 'archived')).toHaveLength(1);
    await catalog.flush();
  });

  it('stores YuShan sessions in the claude-shaped slot and isolates them from codex', async () => {
    const catalogPath = await path();
    const catalog = new SessionCatalog(catalogPath);
    const base = {
      scopeId: 'chat-1',
      cwdRealpath: '/repo',
      policyFingerprint: 'fp-1',
    };

    catalog.upsertActive({
      ...base,
      agentId: 'yushan',
      sessionId: '1794402820_061076000',
      now: 1000,
    });
    catalog.upsertActive({ ...base, agentId: 'codex', threadId: 't1', now: 1000 });

    expect(catalog.activeFor({ ...base, agentId: 'yushan' })).toMatchObject({
      agentId: 'yushan',
      sessionId: '1794402820_061076000',
    });
    expect(catalog.activeFor({ ...base, agentId: 'yushan' })?.threadId).toBeUndefined();
    expect(catalog.activeFor({ ...base, agentId: 'codex' })).toMatchObject({ threadId: 't1' });
    expect(sessionCatalogKey({ ...base, agentId: 'yushan' })).not.toBe(
      sessionCatalogKey({ ...base, agentId: 'codex' }),
    );

    await catalog.flush();
    const reloaded = new SessionCatalog(catalogPath);
    await reloaded.load();
    expect(reloaded.activeFor({ ...base, agentId: 'yushan' })).toMatchObject({
      sessionId: '1794402820_061076000',
    });
  });

  it('rejects YuShan entries that carry a threadId', async () => {
    const catalog = new SessionCatalog(await path());

    expect(() =>
      catalog.upsertActive({
        scopeId: 'chat-1',
        agentId: 'yushan',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
        threadId: 't1',
        now: 1000,
      }),
    ).toThrow(/YuShan.*sessionId/i);
    await catalog.flush();
  });

  it('garbage-collects old archived entries, per-scope overflow, and profile overflow', async () => {
    const catalog = new SessionCatalog(await path());
    await catalog.replaceForTest([
      ...Array.from({ length: 25 }, (_, i) =>
        entry(`chat-1`, `sess-${i}`, 50_000 + i, `fp-${i}`),
      ),
      ...Array.from({ length: 981 }, (_, i) =>
        entry(`chat-${i + 2}`, `other-${i}`, 20_000 + i, `fp-other-${i}`),
      ),
      {
        ...entry('chat-old', 'old', 1),
        status: 'archived',
      },
    ]);

    catalog.gc({
      now: 100 * 24 * 60 * 60 * 1000,
      maxArchivedAgeMs: 90 * 24 * 60 * 60 * 1000,
      maxEntriesPerScope: 20,
      maxEntriesPerProfile: 1000,
    });

    expect(catalog.entries().some((item) => item.sessionId === 'old')).toBe(false);
    expect(catalog.entries().filter((item) => item.scopeId === 'chat-1')).toHaveLength(20);
    expect(catalog.entries()).toHaveLength(1000);
    await catalog.flush();
  });
});

describe('yushan runtime state', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('round-trips a yushan agentKind through the process registry', async () => {
    const root = await tempRoot();
    const registryFile = join(root, 'registry', 'processes.json');

    const entry = await register({
      appId: 'cli_test',
      tenant: 'feishu',
      profileName: 'yushan',
      agentKind: 'yushan',
      configPath: join(root, 'config.json'),
      version: '0.7.1',
      registryFile,
    });

    expect(entry.agentKind).toBe('yushan');
    expect(readAndPrune(registryFile)).toEqual([
      expect.objectContaining({ id: entry.id, agentKind: 'yushan', profileName: 'yushan' }),
    ]);
  });

  it('accepts yushan lock metadata as a valid runtime lock', async () => {
    const root = await tempRoot();
    const paths = resolveAppPaths({ rootDir: root, profile: 'yushan' });

    const lock = await acquireAppRuntimeLock(paths, 'cli_test', 'yushan');
    try {
      await expect(readRuntimeLockMeta(lock.target)).resolves.toMatchObject({
        kind: 'app',
        profile: 'yushan',
        agentKind: 'yushan',
        appId: 'cli_test',
      });
    } finally {
      await lock.release();
    }
  });
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'session-catalog-runtime-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function path(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'session-catalog-test-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'catalog.json');
}

function entry(
  scopeId: string,
  sessionId: string,
  updatedAt: number,
  policyFingerprint = 'fp-1',
) {
  const identity = {
    scopeId,
    agentId: 'claude' as const,
    cwdRealpath: '/repo',
    policyFingerprint,
  };
  return {
    key: sessionCatalogKey(identity),
    ...identity,
    sessionId,
    status: 'active' as const,
    updatedAt,
  };
}
