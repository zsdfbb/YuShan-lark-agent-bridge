import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { SessionSummary } from './history';
import { normalizeSessionPreview } from './preview';

export interface ListYushanHistoryInput {
  /** Must be the adapter's `YUSHAN_SESSIONS_DIR` (`<profileStateDir>/yushan-sessions`). */
  sessionsDir: string;
  limit?: number;
}

const DEFAULT_LIMIT = 5;
const MAX_LINES = 20_000;

/**
 * List recent YuShan sessions, newest first.
 *
 * YuShan rewrites the whole session file on --resume:
 *   - meta.title becomes the LATEST turn's task text (not the session topic)
 *   - meta.turns is UNRELIABLE (measured: 2 complete turns still wrote turns:1)
 *   - meta.input_tokens / output_tokens are single-turn values
 * ⇒ preview uses `title` as the honest approximation of "what we were just
 *   talking about". NEVER derive turn counts from `turns`, never show token counts.
 */
export async function listYushanHistory(
  input: ListYushanHistoryInput,
): Promise<SessionSummary[]> {
  const limit = normalizeLimit(input.limit);
  let files: string[];
  try {
    files = await readdir(input.sessionsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const withStats = await Promise.all(
    files
      .filter((file) => file.endsWith('.jsonl'))
      .map(async (file) => {
        const path = join(input.sessionsDir, file);
        try {
          const st = await stat(path);
          if (!st.isFile()) return null;
          return { file, path, mtime: st.mtimeMs };
        } catch {
          return null;
        }
      }),
  );

  const sorted = withStats
    .filter((entry): entry is { file: string; path: string; mtime: number } => entry !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);

  return Promise.all(
    sorted.map(async (entry) => {
      const { preview, lineCount } = await summarize(entry.path);
      return {
        // The file name IS the session id YuShan accepts on --resume
        // (e.g. `1794403057_979860000`). It is opaque — do not parse it as a
        // date/timestamp, it carries no calendar meaning.
        sessionId: entry.file.replace(/\.jsonl$/, ''),
        mtime: entry.mtime,
        preview,
        lineCount,
      };
    }),
  );
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT;
  return Math.floor(limit);
}

async function summarize(path: string): Promise<{ preview: string; lineCount: number }> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input: stream });
  let metaTitle = '';
  let firstUserText = '';
  let lineCount = 0;
  try {
    for await (const line of rl) {
      lineCount++;
      if (lineCount > MAX_LINES) break;
      if (!metaTitle && line.includes('"type":"meta"')) {
        metaTitle = readMetaTitle(line);
        continue;
      }
      if (!firstUserText && line.includes('"role":"User"')) {
        firstUserText = readUserText(line);
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  const preview =
    (metaTitle ? normalizeSessionPreview(metaTitle) : '') ||
    (firstUserText ? normalizeSessionPreview(firstUserText) : '') ||
    '(空会话)';
  return { preview, lineCount };
}

/** meta.title is the latest turn's task text; treat it as an opaque string. */
function readMetaTitle(line: string): string {
  const obj = parseLine(line);
  if (!obj || obj.type !== 'meta') return '';
  return typeof obj.title === 'string' ? obj.title.trim() : '';
}

/** Fallback preview source: the first real user turn. */
function readUserText(line: string): string {
  const obj = parseLine(line);
  if (!obj || obj.role !== 'User') return '';
  const content = obj.content;
  if (!Array.isArray(content)) return '';
  for (const block of content) {
    const record = asRecord(block);
    const text = asRecord(record?.Text)?.text;
    if (typeof text === 'string' && text.trim()) return text.trim();
  }
  return '';
}

function parseLine(line: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(line) as unknown);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
