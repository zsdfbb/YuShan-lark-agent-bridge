import { describe, expect, it } from 'vitest';
import { BRIDGE_SYSTEM_PROMPT } from '../../../src/agent/bridge-system-prompt';
import {
  capabilityForProfile,
  claudeCapability,
  codexCapability,
  yushanCapability,
} from '../../../src/agent/capability';
import type { AccessMode } from '../../../src/config/permissions';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';

describe('agent capability contract', () => {
  it('defines Claude capability with legacy callback marker compatibility', () => {
    const capability = claudeCapability();

    expect(capability).toMatchObject({
      agentId: 'claude',
      sessionKind: 'claude-session',
      promptInjection: 'append-system-prompt',
      supportsNativeHistory: true,
      systemPrompt: BRIDGE_SYSTEM_PROMPT,
      callback: {
        marker: '__bridge_cb',
        legacyMarkers: ['__claude_cb'],
      },
    });
  });

  it('defines Codex capability with thread sessions and stdin prompt injection', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: {
        app: {
          id: 'cli_test',
          secret: '${APP_SECRET}',
          tenant: 'feishu',
        },
      },
      codex: {
        binaryPath: '/usr/local/bin/codex',
      },
      permissions: {
        defaultAccess: 'workspace',
        maxAccess: 'workspace',
      },
    });

    expect(codexCapability(profile)).toMatchObject({
      agentId: 'codex',
      sessionKind: 'codex-thread',
      promptInjection: 'stdin-prefix',
      supportsNativeHistory: false,
      systemPrompt: BRIDGE_SYSTEM_PROMPT,
      permissions: {
        maxAccess: 'workspace',
      },
    });
  });

  it('uses Codex profile max access as the static capability ceiling', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: {
        app: {
          id: 'cli_test',
          secret: '${APP_SECRET}',
          tenant: 'feishu',
        },
      },
      codex: {
        binaryPath: '/usr/local/bin/codex',
      },
      permissions: {
        defaultAccess: 'read-only',
        maxAccess: 'read-only',
      },
    });

    expect(codexCapability(profile).permissions.maxAccess).toBe('read-only');
  });

  it('defines YuShan capability with stdin prompt injection and no legacy markers', () => {
    expect(yushanCapability()).toMatchObject({
      agentId: 'yushan',
      sessionKind: 'yushan-session',
      promptInjection: 'stdin-prefix',
      supportsNativeHistory: true,
      systemPrompt: BRIDGE_SYSTEM_PROMPT,
      callback: {
        marker: '__bridge_cb',
        legacyMarkers: [],
      },
    });
  });

  it('keeps YuShan legacy callback markers empty unlike Claude', () => {
    expect(yushanCapability().callback.legacyMarkers).toEqual([]);
    expect(claudeCapability().callback.legacyMarkers).toEqual(['__claude_cb']);
  });

  it.each<AccessMode>(['full', 'workspace', 'read-only'])(
    'pins YuShan max access to full regardless of profile setting (%s)',
    (mode) => {
      const profile = { permissions: { defaultAccess: mode, maxAccess: mode } };

      expect(yushanCapability(profile).permissions.maxAccess).toBe('full');
    },
  );

  it('still honours profile max access for Claude and Codex', () => {
    const permissions = {
      permissions: { defaultAccess: 'read-only' as const, maxAccess: 'read-only' as const },
    };

    expect(claudeCapability(permissions).permissions.maxAccess).toBe('read-only');
    expect(codexCapability(permissions).permissions.maxAccess).toBe('read-only');
  });

  it('dispatches capability from profile agentKind', () => {
    const yushanProfile = createDefaultProfileConfig({
      agentKind: 'yushan',
      accounts: {
        app: {
          id: 'cli_test',
          secret: '${APP_SECRET}',
          tenant: 'feishu',
        },
      },
      permissions: {
        defaultAccess: 'read-only',
        maxAccess: 'read-only',
      },
    });
    expect(capabilityForProfile(yushanProfile).agentId).toBe('yushan');
    expect(capabilityForProfile(yushanProfile).sessionKind).toBe('yushan-session');

    const codexProfile = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: {
        app: {
          id: 'cli_test',
          secret: '${APP_SECRET}',
          tenant: 'feishu',
        },
      },
      codex: {
        binaryPath: '/usr/local/bin/codex',
      },
      permissions: {
        defaultAccess: 'workspace',
        maxAccess: 'workspace',
      },
    });
    expect(capabilityForProfile(codexProfile).agentId).toBe('codex');
    expect(capabilityForProfile(codexProfile).permissions.maxAccess).toBe('workspace');

    const claudeProfile = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: {
        app: {
          id: 'cli_test',
          secret: '${APP_SECRET}',
          tenant: 'feishu',
        },
      },
      permissions: {
        defaultAccess: 'read-only',
        maxAccess: 'read-only',
      },
    });
    expect(capabilityForProfile(claudeProfile).agentId).toBe('claude');
    expect(capabilityForProfile(claudeProfile).permissions.maxAccess).toBe('read-only');
  });
});
