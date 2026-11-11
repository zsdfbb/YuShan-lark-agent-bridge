import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeNewProfile, onboardCreate, type CreateProfileInput } from '../../../src/ui/onboard';
import { loadRootConfig } from '../../../src/config/profile-store';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function tmpRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-onboard-'));
  roots.push(root);
  return root;
}

describe('writeNewProfile (new-profile is additive)', () => {
  it('refuses to overwrite an existing profile and lets a new name coexist', async () => {
    const root = await tmpRoot();
    const base = {
      profile: 'claude',
      agentKind: 'claude' as const,
      appSecret: 'secret',
      tenant: 'feishu' as const,
      workspace: root,
    };

    const first = await writeNewProfile({ ...base, appId: 'cli_a' }, root);
    expect(first.profile).toBe('claude');

    // Same name → refuse (do NOT clobber the existing profile).
    await expect(writeNewProfile({ ...base, appId: 'cli_b' }, root)).rejects.toThrow(/已存在/);

    // The existing profile still points at the original app.
    const afterCollision = (await loadRootConfig(join(root, 'config.json')))!;
    expect(afterCollision.profiles.claude?.accounts.app.id).toBe('cli_a');

    // A different name is added alongside.
    const second = await writeNewProfile({ ...base, profile: 'work', appId: 'cli_b' }, root);
    expect(second.profile).toBe('work');
    const root2 = (await loadRootConfig(join(root, 'config.json')))!;
    expect(Object.keys(root2.profiles).sort()).toEqual(['claude', 'work']);
  });

  it('creates a profile with a Unicode (Chinese) name from the scanned bot name', async () => {
    const root = await tmpRoot();

    const created = await writeNewProfile(
      {
        profile: '助手',
        agentKind: 'claude',
        appId: 'cli_nimo',
        appSecret: 'secret',
        tenant: 'feishu',
        workspace: root,
      },
      root,
    );
    expect(created.profile).toBe('助手');

    const cfg = (await loadRootConfig(join(root, 'config.json')))!;
    expect(cfg.profiles['助手']?.accounts.app.id).toBe('cli_nimo');
  });

  it('rejects a path-unsafe profile name with a clear 400 (not a 500)', async () => {
    const root = await tmpRoot();
    await expect(
      writeNewProfile(
        { profile: 'a/b', agentKind: 'claude', appId: 'cli_x', appSecret: 's', tenant: 'feishu' },
        root,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('writeNewProfile (agentKind is not silently coerced)', () => {
  it('persists agentKind yushan verbatim (not claude) and writes no codex block', async () => {
    const root = await tmpRoot();

    const created = await writeNewProfile(
      {
        profile: 'ys',
        agentKind: 'yushan',
        appId: 'cli_ys',
        appSecret: 'secret',
        tenant: 'feishu',
        workspace: root,
      },
      root,
    );
    expect(created.profile).toBe('ys');

    const cfg = (await loadRootConfig(join(root, 'config.json')))!;
    expect(cfg.profiles.ys?.agentKind).toBe('yushan');
    expect(cfg.profiles.ys?.codex).toBeUndefined();
  });

  it('claude stays claude (no regression)', async () => {
    const root = await tmpRoot();
    await writeNewProfile(
      { profile: 'c', agentKind: 'claude', appId: 'cli_c', appSecret: 's', tenant: 'feishu', workspace: root },
      root,
    );
    const cfg = (await loadRootConfig(join(root, 'config.json')))!;
    expect(cfg.profiles.c?.agentKind).toBe('claude');
    expect(cfg.profiles.c?.codex).toBeUndefined();
  });

  it('throws on an unknown agentKind and writes no profile', async () => {
    const root = await tmpRoot();
    await expect(
      writeNewProfile(
        {
          profile: 'bogus',
          agentKind: 'bogus' as CreateProfileInput['agentKind'],
          appId: 'cli_bogus',
          appSecret: 's',
          tenant: 'feishu',
          workspace: root,
        },
        root,
      ),
    ).rejects.toThrow(/agentKind|unsupported agent/);

    const cfg = await loadRootConfig(join(root, 'config.json'));
    expect(cfg?.profiles.bogus).toBeUndefined();
  });

  it('onboardCreate rejects an unknown agentKind before touching credentials', async () => {
    const root = await tmpRoot();
    await expect(onboardCreate({ agentKind: 'bogus', appId: 'a', appSecret: 'b' }, root)).rejects.toThrow(
      /agentKind/,
    );
    const cfg = await loadRootConfig(join(root, 'config.json'));
    expect(cfg?.profiles ?? {}).toEqual({});
  });
});
