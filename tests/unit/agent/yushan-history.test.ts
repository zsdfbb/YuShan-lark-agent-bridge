import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { listYushanHistory } from '../../../src/session/yushan-history';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function sessionsDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'yushan-history-'));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }));
  const dir = join(root, 'yushan-sessions');
  await mkdir(dir, { recursive: true });
  return dir;
}

/** The real on-disk shape after `yushan --resume`: meta describes only the LAST turn. */
const RESUME_REWRITE_SAMPLE = [
  '{"type":"meta","v":1,"title":"我刚才让你记住的数字是多少？只回复数字","provider":"opencode-go","model":"deepseek-v4.1-flash","input_tokens":7829,"output_tokens":3,"turns":1}',
  '{"role":"User","content":[{"Text":{"text":"记住数字 42，只回复『好』"}}]}',
  '{"role":"Assistant","content":[{"Text":{"text":"好"}}]}',
  '{"role":"User","content":[{"Text":{"text":"我刚才让你记住的数字是多少？只回复数字"}}]}',
  '{"role":"Assistant","content":[{"Text":{"text":"42"}}]}',
];

async function writeSession(dir: string, name: string, lines: string[]): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8');
  return path;
}

describe('listYushanHistory', () => {
  it('previews the resumed session with meta.title, not the first turn', async () => {
    const dir = await sessionsDir();
    await writeSession(dir, '1794403057_979860000.jsonl', RESUME_REWRITE_SAMPLE);

    const [session] = await listYushanHistory({ sessionsDir: dir });

    expect(session?.preview).toBe('我刚才让你记住的数字是多少？只回复数字');
    expect(session?.preview).not.toContain('记住数字 42');
    expect(session?.lineCount).toBe(5);
    // meta.turns is unreliable: the summary must carry no turn-derived field.
    expect(Object.keys(session ?? {}).sort()).toEqual([
      'lineCount',
      'mtime',
      'preview',
      'sessionId',
    ]);
  });

  it('falls back to the first user turn when meta is missing', async () => {
    const dir = await sessionsDir();
    await writeSession(dir, 'no-meta.jsonl', RESUME_REWRITE_SAMPLE.slice(1));

    const [session] = await listYushanHistory({ sessionsDir: dir });

    expect(session?.preview).toContain('记住数字 42');
    expect(session?.lineCount).toBe(4);
  });

  it('falls back to the first user turn when meta.title is an empty string', async () => {
    const dir = await sessionsDir();
    await writeSession(dir, 'empty-title.jsonl', [
      '{"type":"meta","v":1,"title":"","provider":"opencode-go","model":"deepseek-v4.1-flash","turns":3}',
      ...RESUME_REWRITE_SAMPLE.slice(1),
    ]);

    const [session] = await listYushanHistory({ sessionsDir: dir });

    expect(session?.preview).toContain('记住数字 42');
  });

  it('sorts by mtime descending', async () => {
    const dir = await sessionsDir();
    const older = await writeSession(dir, 'older.jsonl', RESUME_REWRITE_SAMPLE.slice(1));
    const newer = await writeSession(dir, 'newer.jsonl', RESUME_REWRITE_SAMPLE.slice(1));
    await utimes(older, new Date('2024-01-01T00:00:00Z'), new Date('2024-01-01T00:00:00Z'));
    await utimes(newer, new Date('2024-06-01T00:00:00Z'), new Date('2024-06-01T00:00:00Z'));

    const sessions = await listYushanHistory({ sessionsDir: dir });

    expect(sessions.map((s) => s.sessionId)).toEqual(['newer', 'older']);
    expect(sessions[0]?.mtime).toBeGreaterThan(sessions[1]?.mtime ?? 0);
  });

  it('honours limit', async () => {
    const dir = await sessionsDir();
    for (const name of ['a.jsonl', 'b.jsonl', 'c.jsonl']) {
      await writeSession(dir, name, RESUME_REWRITE_SAMPLE.slice(1));
    }

    await expect(listYushanHistory({ sessionsDir: dir, limit: 2 })).resolves.toHaveLength(2);
    await expect(listYushanHistory({ sessionsDir: dir })).resolves.toHaveLength(3);
  });

  it('keeps the file name as an opaque session id', async () => {
    const dir = await sessionsDir();
    await writeSession(dir, '1794403057_979860000.jsonl', RESUME_REWRITE_SAMPLE.slice(1));

    const [session] = await listYushanHistory({ sessionsDir: dir });

    // The id is what `--resume` accepts; it must not be reformatted as a date.
    expect(session?.sessionId).toBe('1794403057_979860000');
  });

  it('returns an empty list for empty and missing directories', async () => {
    const dir = await sessionsDir();
    await expect(listYushanHistory({ sessionsDir: dir })).resolves.toEqual([]);

    const missing = join(dir, 'nope', 'yushan-sessions');
    await expect(listYushanHistory({ sessionsDir: missing })).resolves.toEqual([]);
  });
});
