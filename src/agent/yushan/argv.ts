import { log } from '../../core/logger';

/** `1794403057_979860000` (timestamp_nanos). Anything else
 * is either corrupt catalog data or a hostile value, and an id starting with
 * `-` in particular would be swallowed as a flag *before* the `--` terminator,
 * shifting the prompt out of its position. Fall back to a fresh run instead.
 */
const SESSION_ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z_-]*$/;

export function isSafeYushanSessionId(value: unknown): boolean {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value);
}

export interface BuildYushanArgsInput {
  /** Existing YuShan session id to resume. Empty/undefined starts a fresh run. */
  sessionId?: string;
  /** The whole task prompt. Passed as exactly one argv token, never via stdin. */
  prompt: string;
}

/**
 * Builds the YuShan coding-agent argv for a single non-interactive run.
 *
 * Invariant order: `--json [--resume <id>] -- <prompt>`
 *
 * - `--json` is the leading subcommand selector, so it must stay first.
 * - `--resume <id>` is omitted unless `sessionId` is a non-empty string. The id is
 *   never the last token, otherwise YuShan reads a bare `--resume` and opens its
 *   interactive session picker.
 * - `--` is always emitted: YuShan's `split_leading_flags` stops at the first
 *   non-flag token, so a prompt that happens to be exactly `--stats` (or `--debug`,
 *   `--resume`) would otherwise be swallowed as a flag.
 * - The prompt is exactly one token. Yushan treats `-` as a "read stdin"
 *   placeholder it does not support, so stdin is not an option either.
 */
export function buildYushanArgs(input: BuildYushanArgsInput): string[] {
  const args = ['--json'];

  if (input.sessionId) {
    if (isSafeYushanSessionId(input.sessionId)) {
      args.push('--resume', input.sessionId);
    } else {
      // Drop the id rather than let it be parsed as a flag: a fresh run loses
      // context, but a shifted argv corrupts the prompt.
      log.warn('yushan', 'unsafe_session_id', { shape: input.sessionId.length });
    }
  }

  args.push('--', input.prompt);

  return args;
}
