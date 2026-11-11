import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('README runtime contract', () => {
  it('documents maintained runtime surfaces in user-visible docs', async () => {
    const docs = await readDocs();

    for (const phrase of [
      'per-profile service',
      'workspaces.default',
      '/invite user',
      '/remove user',
      '/invite group',
      '/remove group',
      '/invite all group',
      'Windows',
      '.cmd',
      'profile export',
      'profile remove',
      '--purge --yes',
      '--include-secrets --yes',
      'lark-cli identity policy',
      'profile-local lark-cli directory',
      'lark-cli 身份策略',
      '当前 profile 的 lark-cli 目录',
      'pnpm test',
      'pnpm typecheck',
      'pnpm build',
    ]) {
      expect(docs).toContain(phrase);
    }
  });

  it('keeps CLI help aligned with profile-aware service and first-run workspace flags', async () => {
    const [cli, help, configCard] = await Promise.all([
      readFile(new URL('../../../src/cli/index.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../../src/card/templates.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../../src/card/config-card.ts', import.meta.url), 'utf8'),
    ]);

    expect(cli).toContain('--workspace <path>');
    expect(cli).toContain('profile name (defaults to active profile)');
    expect(cli).toContain('Archive a profile and its local state');
    expect(help).not.toContain('/doc ws');
    expect(configCard).not.toContain('`/doc`');
  });

  it('does not document trusted or allowed directory authorization', async () => {
    const docs = await readDocs();

    for (const phrase of [
      '允许访问目录',
      '可信目录',
      '安全目录',
      'trustedRoots',
      '/ws add',
      '/ws remove --root',
      'allowed directory',
      'allowed directories',
      'trusted directory',
      'safe directory',
    ]) {
      expect(docs).not.toContain(phrase);
    }
  });

  it('documents access control commands instead of config-only access management', async () => {
    const docs = await readDocs();

    expect(docs).not.toContain('`/config` only adjusts presentation preferences. Manage access in the profile config.');
    expect(docs).not.toContain('`/config` 只调整展示偏好，不再维护访问名单。请在 profile config 里维护。');
  });

  it('documents cloud-doc comments as document-scoped instead of access-gated', async () => {
    const docs = await readDocs();

    expect(docs).toContain('Cloud-doc comments are document-scoped');
    expect(docs).toContain('云文档评论按文档权限生效');
    expect(docs).not.toContain('comments.enabled');
    expect(docs).not.toContain('comments.rateLimit');
    expect(docs).not.toContain('/doc ws bind');
  });

  it('documents canonical permissions instead of recommending legacy sandbox config', async () => {
    const docs = await readDocs();

    expect(docs).toContain('"permissions"');
    expect(docs).toContain('"defaultAccess": "full"');
    expect(docs).toContain('"maxAccess": "full"');
    expect(docs).toContain('legacy `sandbox`');
    expect(docs).toContain('旧版 `sandbox`');
    expect(docs).not.toContain('"sandbox"');
    expect(docs).not.toContain('"沙箱"');
  });

  it('documents yushan as the third supported agent in both READMEs', async () => {
    const [en, zh] = await readDocsSeparately();

    for (const doc of [en, zh]) {
      expect(doc).toContain('ys-coding-agent');
      expect(doc).toContain('YUSHAN_SESSIONS_DIR');
      expect(doc).toContain('LARK_CHANNEL_YUSHAN_BIN');
    }
  });

  it('documents the yushan auto-approve limitation in the matching language', async () => {
    const [en, zh] = await readDocsSeparately();

    expect(/AutoApprove|auto-approve/.test(en)).toBe(true);
    expect(zh).toContain('自动批准');
  });

  it('never claims yushan supports a read-only tier', async () => {
    const [en, zh] = await readDocsSeparately();

    // A positive claim has no negation inside the same sentence.
    expect(en).not.toMatch(/\byushan\b(?![^.]*\bnot\b)[^.]*\bsupports?\b[^.]*read-only/i);
    expect(zh).not.toMatch(/yushan(?![^。]*不)[^。]*只读/);

    for (const phrase of [
      'YuShan supports read-only',
      'yushan supports read-only',
      'yushan supports the read-only',
      'yushan 支持只读档',
      'yushan 也支持只读',
    ]) {
      expect(`${en}\n${zh}`).not.toContain(phrase);
    }
  });

  it('exposes yushan in the web agent selector and detection candidates', async () => {
    const [types, wizard, detection] = await Promise.all([
      readFile(new URL('../../../web/src/lib/types.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../../web/src/views/OnboardWizard.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../../src/cli/agent-detection.ts', import.meta.url), 'utf8'),
    ]);

    const agentKindLine = types
      .split('\n')
      .find((line) => line.includes('type AgentKind'));
    expect(agentKindLine).toBeDefined();
    expect(agentKindLine).toContain('"yushan"');

    expect(wizard).toContain('value="yushan"');
    expect(wizard).toContain('YuShan');

    const emptyStateLine = wizard
      .split('\n')
      .find((line) => line.includes('未检测到已安装的 agent'));
    expect(emptyStateLine).toBeDefined();
    expect(emptyStateLine).toContain('yushan');

    expect(detection).toContain('ys-coding-agent');
    expect(detection).toContain('LARK_CHANNEL_YUSHAN_BIN');
  });
});

async function readDocsSeparately(): Promise<[string, string]> {
  return Promise.all([
    readFile(new URL('../../../README.md', import.meta.url), 'utf8'),
    readFile(new URL('../../../README.zh.md', import.meta.url), 'utf8'),
  ]);
}

async function readDocs(): Promise<string> {
  const [en, zh] = await Promise.all([
    readFile(new URL('../../../README.md', import.meta.url), 'utf8'),
    readFile(new URL('../../../README.zh.md', import.meta.url), 'utf8'),
  ]);
  return `${en}\n${zh}`;
}
