import type { AccessMode } from '../config/permissions';
import type { AgentKind, ProfileConfig } from '../config/profile-schema';
import { BRIDGE_SYSTEM_PROMPT } from './bridge-system-prompt';

export type AgentCapabilityId = AgentKind;
export type AgentSessionKind = 'claude-session' | 'codex-thread' | 'yushan-session';
export type PromptInjectionMode = 'append-system-prompt' | 'stdin-prefix';

export interface AgentCapability {
  agentId: AgentCapabilityId;
  sessionKind: AgentSessionKind;
  promptInjection: PromptInjectionMode;
  systemPrompt: string;
  supportsNativeHistory: boolean;
  callback: {
    marker: '__bridge_cb';
    legacyMarkers: string[];
  };
  permissions: {
    maxAccess: AccessMode;
  };
}

export function claudeCapability(profile?: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  const maxAccess = profile?.permissions.maxAccess ?? 'full';
  return {
    agentId: 'claude',
    sessionKind: 'claude-session',
    promptInjection: 'append-system-prompt',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: true,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: ['__claude_cb'],
    },
    permissions: {
      maxAccess,
    },
  };
}

/**
 * YuShan capability.
 *
 * `permissions.maxAccess` is pinned to `'full'` regardless of the profile: YuShan
 * exposes no sandbox CLI surface, so a narrower profile setting would be a fake
 * guarantee (R7). Tool approval is always auto-approved.
 */
export function yushanCapability(_profile?: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  return {
    agentId: 'yushan',
    sessionKind: 'yushan-session',
    promptInjection: 'stdin-prefix',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: true,
    callback: { marker: '__bridge_cb', legacyMarkers: [] },
    permissions: { maxAccess: 'full' },
  };
}

export function codexCapability(profile: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  const maxAccess = profile.permissions.maxAccess;
  return {
    agentId: 'codex',
    sessionKind: 'codex-thread',
    promptInjection: 'stdin-prefix',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: false,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: [],
    },
    permissions: {
      maxAccess,
    },
  };
}

/** Single dispatch point: profile agentKind → capability. Replaces the
 *  `agentKind === 'codex' ? codexCapability() : claudeCapability()` ternaries. */
export function capabilityForProfile(profile: ProfileConfig): AgentCapability {
  switch (profile.agentKind) {
    case 'codex': return codexCapability(profile);
    case 'yushan': return yushanCapability(profile);
    case 'claude': return claudeCapability(profile);
  }
}
