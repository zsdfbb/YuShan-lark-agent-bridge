import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeCapability, yushanCapability } from '../../../src/agent/capability';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { recordRunSessionEvent, startRunFlow } from '../../../src/bot/run-flow';
import { ProcessPool } from '../../../src/bot/process-pool';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { SessionCatalog } from '../../../src/session/catalog';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('IM run flow', () => {
  it('rejects missing cwd without falling back to the user home', async () => {
    const h = await createHarness();

    const result = await startRunFlow({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'hello',
      attachments: [],
      access: { ok: true, reason: 'allowed-user' },
      capability: claudeCapability(h.profileConfig),
      profileConfig: h.profileConfig,
      sessions: h.sessions,
      workspaces: h.workspaces,
      executor: h.executor,
      now: 1000,
    });

    expect(result).toMatchObject({
      ok: false,
      rejectReason: {
        code: 'empty-requested-cwd',
      },
    });
    expect(h.agent.runOptions).toEqual([]);
  });

  it('submits cwd through RunExecutor and resumes matching sessions', async () => {
    const h = await createHarness();
    const workspaceRealpath = await realpath(h.tmp.workspace);
    h.workspaces.setCwd('chat-1', h.tmp.workspace);
    h.sessions.set('chat-1', 'sess-1', workspaceRealpath);

    const result = await startRunFlow({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'hello',
      attachments: [],
      access: { ok: true, reason: 'allowed-user' },
      capability: claudeCapability(h.profileConfig),
      profileConfig: h.profileConfig,
      sessions: h.sessions,
      workspaces: h.workspaces,
      executor: h.executor,
      now: 1000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected run flow to start');
    expect(result.cwdRealpath).toBe(workspaceRealpath);
    expect(result.resumeFrom).toBe('sess-1');
    expect(h.agent.runOptions[0]).toMatchObject({
      runId: 'run-1',
      cwd: workspaceRealpath,
      sessionId: 'sess-1',
    });
  });

  it('uses the profile default workspace when a scope has no explicit binding', async () => {
    const h = await createHarness({ defaultWorkspace: true });
    const workspaceRealpath = await realpath(h.tmp.workspace);

    const result = await startRunFlow({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'hello',
      attachments: [],
      access: { ok: true, reason: 'allowed-user' },
      capability: claudeCapability(h.profileConfig),
      profileConfig: h.profileConfig,
      sessions: h.sessions,
      workspaces: h.workspaces,
      executor: h.executor,
      now: 1000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected run flow to start');
    expect(result.cwdRealpath).toBe(workspaceRealpath);
    expect(h.agent.runOptions[0]?.cwd).toBe(workspaceRealpath);
  });

  it('starts a yushan run without any session or thread id on the first turn', async () => {
    const h = await createHarness({ agentKind: 'yushan' });
    h.workspaces.setCwd('chat-1', h.tmp.workspace);

    const result = await startRunFlow(yushanInput(h));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected yushan run flow to start');
    expect(result.resumeFrom).toBeUndefined();
    expect(h.agent.runOptions[0]).toMatchObject({
      sessionId: undefined,
      threadId: undefined,
    });
  });

  it('records a yushan session id in the catalog without a thread id', async () => {
    const h = await createHarness({ agentKind: 'yushan' });
    h.workspaces.setCwd('chat-1', h.tmp.workspace);

    const first = await startRunFlow(yushanInput(h));
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('expected yushan run flow to start');

    recordRunSessionEvent({
      scopeId: 'chat-1',
      sessions: h.sessions,
      sessionCatalog: h.catalog,
      capability: yushanCapability(h.profileConfig),
      policy: first.policy,
      event: {
        type: 'system',
        sessionId: '1794402820_061076000',
        cwd: first.cwdRealpath,
      },
    });

    const entry = h.catalog.activeFor({
      scopeId: 'chat-1',
      agentId: 'yushan',
      cwdRealpath: first.cwdRealpath,
      policyFingerprint: first.policy.policyFingerprint,
    });
    expect(entry?.sessionId).toBe('1794402820_061076000');
    expect(entry?.threadId).toBeUndefined();
    expect(h.sessions.resumeFor('chat-1', first.cwdRealpath)).toBe('1794402820_061076000');
  });

  it('resumes a yushan run from the catalog session id on the second turn', async () => {
    const h = await createHarness({ agentKind: 'yushan' });
    h.workspaces.setCwd('chat-1', h.tmp.workspace);

    const first = await startRunFlow(yushanInput(h));
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('expected yushan run flow to start');
    await collect(first.execution.subscribe());

    recordRunSessionEvent({
      scopeId: 'chat-1',
      sessions: h.sessions,
      sessionCatalog: h.catalog,
      capability: yushanCapability(h.profileConfig),
      policy: first.policy,
      event: { type: 'system', sessionId: '1794402820_061076000', cwd: first.cwdRealpath },
    });

    const second = await startRunFlow(yushanInput(h));

    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('expected resumed yushan run flow');
    expect(second.resumeFrom).toBe('1794402820_061076000');
    expect(h.agent.runOptions[1]).toMatchObject({
      sessionId: '1794402820_061076000',
      threadId: undefined,
    });
  });
});

function yushanInput(h: Awaited<ReturnType<typeof createHarness>>): Parameters<typeof startRunFlow>[0] {
  return {
    scopeId: 'chat-1',
    scope: { source: 'im' as const, chatId: 'chat-1', actorId: 'ou_user' },
    prompt: 'hello',
    attachments: [],
    access: { ok: true as const, reason: 'allowed-user' as const },
    capability: yushanCapability(h.profileConfig),
    profileConfig: h.profileConfig,
    sessions: h.sessions,
    sessionCatalog: h.catalog,
    workspaces: h.workspaces,
    executor: h.executor,
    now: 1000,
  };
}

async function collect(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of events) {
    /* drain */
  }
}

async function createHarness(options: {
  defaultWorkspace?: boolean;
  agentKind?: 'claude' | 'yushan';
} = {}): Promise<{
  tmp: TmpProfile;
  agent: FakeAgentAdapter;
  executor: RunExecutor;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  catalog: SessionCatalog;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
}> {
  const agentKind = options.agentKind ?? 'claude';
  const tmp = await createTmpProfile('bridge-im-run-flow-');
  const agent = new FakeAgentAdapter({
    id: agentKind,
    events: [{ type: 'done', terminationReason: 'normal' }],
  });
  const executor = new RunExecutor({
    agent,
    pool: new ProcessPool(() => 1),
    activeRuns: new ActiveRuns(),
    createRunId: () => 'run-1',
    now: () => 1000,
  });
  const profileConfig = createDefaultProfileConfig({
    agentKind,
    accounts: {
      app: {
        id: 'cli_test',
        secret: '${APP_SECRET}',
        tenant: 'feishu',
      },
    },
  });
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const catalog = new SessionCatalog(join(tmp.profile, 'session-catalog.json'));
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush(), catalog.flush()]);
    await tmp.cleanup();
  });
  return {
    tmp,
    agent,
    executor,
    sessions,
    workspaces,
    catalog,
    profileConfig: {
      ...profileConfig,
      workspaces: {
        ...profileConfig.workspaces,
        ...(options.defaultWorkspace ? { default: tmp.workspace } : {}),
      },
    },
  };
}
