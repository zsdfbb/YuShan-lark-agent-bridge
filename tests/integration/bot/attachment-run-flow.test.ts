import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  claudeCapability,
  codexCapability,
  yushanCapability,
  type AgentCapability,
} from '../../../src/agent/capability.js';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { ProcessPool } from '../../../src/bot/process-pool.js';
import { attachmentTransport, startRunFlow } from '../../../src/bot/run-flow.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import type { AgentAttachment } from '../../../src/policy/run-policy.js';
import { RunExecutor } from '../../../src/runtime/run-executor.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

const MIXED_ATTACHMENTS: AgentAttachment[] = [
  { kind: 'image', path: '/tmp/a.png', requiredness: 'optional', decision: 'accepted' },
  { kind: 'file', path: '/tmp/b.docx', requiredness: 'optional', decision: 'accepted' },
  {
    kind: 'image',
    path: '/tmp/rejected.png',
    requiredness: 'optional',
    decision: 'rejected',
    rejectionReason: 'unsupported-image-mime',
  },
  { kind: 'file', path: '/tmp/skipped.pdf', requiredness: 'optional', decision: 'skipped' },
];

describe('attachment run flow', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('passes accepted image attachment paths to Codex adapter image args only', async () => {
    const h = await createHarness('codex');

    const result = await startRunFlow({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'inspect attachments',
      attachments: [
        {
          kind: 'image',
          path: '/media/image.png',
          requiredness: 'optional',
          decision: 'accepted',
        },
        {
          kind: 'file',
          path: '/media/file.txt',
          requiredness: 'optional',
          decision: 'accepted',
        },
        {
          kind: 'image',
          path: '/media/rejected.svg',
          requiredness: 'optional',
          decision: 'rejected',
          rejectionReason: 'unsupported-image-mime',
        },
      ],
      access: { ok: true, reason: 'allowed-user' },
      capability: codexCapability(h.profileConfig),
      profileConfig: h.profileConfig,
      sessions: h.sessions,
      workspaces: h.workspaces,
      executor: h.executor,
      now: 1000,
    });

    expect(result.ok).toBe(true);
    expect(h.agent.runOptions[0]).toMatchObject({
      images: ['/media/image.png'],
    });
  });

  it('maps each agent to its attachment transport', () => {
    expect(attachmentTransport('codex')).toBe('flag');
    expect(attachmentTransport('yushan')).toBe('text-ref');
    expect(attachmentTransport('claude')).toBe('stdin');
  });

  it('sends yushan accepted attachments as prompt text refs, not image flags', async () => {
    const h = await createHarness('yushan');

    const result = await runWith(h, yushanCapability(h.profileConfig), MIXED_ATTACHMENTS);

    expect(result.ok).toBe(true);
    expect(h.agent.runOptions[0]?.images).toBeUndefined();
    const prompt = h.agent.runOptions[0]?.prompt ?? '';
    expect(prompt).toContain('## attachments');
    expect(prompt).toContain('- [image: /tmp/a.png]');
    expect(prompt).toContain('- [file: /tmp/b.docx]');
    // Rejected / skipped attachments never reach the prompt.
    expect(prompt).not.toContain('/tmp/rejected.png');
    expect(prompt).not.toContain('/tmp/skipped.pdf');
    // The refs block comes after the user input section.
    expect(prompt.indexOf('## attachments')).toBeGreaterThan(
      prompt.indexOf('</user_input>'),
    );
  });

  it('leaves codex prompt refs out and keeps only accepted images as flags', async () => {
    const h = await createHarness('codex');

    const result = await runWith(h, codexCapability(h.profileConfig), MIXED_ATTACHMENTS);

    expect(result.ok).toBe(true);
    expect(h.agent.runOptions[0]?.images).toEqual(['/tmp/a.png']);
    expect(h.agent.runOptions[0]?.prompt).not.toContain('## attachments');
  });

  it('leaves claude attachments to its own stdin protocol', async () => {
    const h = await createHarness('claude');

    const result = await runWith(h, claudeCapability(h.profileConfig), MIXED_ATTACHMENTS);

    expect(result.ok).toBe(true);
    expect(h.agent.runOptions[0]?.images).toBeUndefined();
    expect(h.agent.runOptions[0]?.prompt).not.toContain('## attachments');
  });
});

async function runWith(
  h: Awaited<ReturnType<typeof createHarness>>,
  capability: AgentCapability,
  attachments: AgentAttachment[],
) {
  return startRunFlow({
    scopeId: 'chat-1',
    scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
    prompt: 'inspect attachments',
    attachments,
    access: { ok: true, reason: 'allowed-user' },
    capability,
    profileConfig: h.profileConfig,
    sessions: h.sessions,
    workspaces: h.workspaces,
    executor: h.executor,
    now: 1000,
  });
}

async function createHarness(
  agentKind: 'claude' | 'codex' | 'yushan' = 'codex',
): Promise<{
  tmp: TmpProfile;
  agent: FakeAgentAdapter;
  executor: RunExecutor;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
}> {
  const tmp = await createTmpProfile('attachment-run-flow-');
  const agent = new FakeAgentAdapter({
    id: agentKind,
    displayName: agentKind,
    events: [{ type: 'done', terminationReason: 'normal' }],
  });
  const executor: RunExecutor = new RunExecutor({
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
    ...(agentKind === 'codex' ? { codex: { binaryPath: '/usr/local/bin/codex' } } : {}),
  });
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  workspaces.setCwd('chat-1', tmp.workspace);
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  const workspaceRealpath = await realpath(tmp.workspace);
  return {
    tmp,
    agent,
    executor,
    sessions,
    workspaces,
    profileConfig: {
      ...profileConfig,
      workspaces: {
        ...profileConfig.workspaces,
        default: workspaceRealpath,
      },
    },
  };
}
