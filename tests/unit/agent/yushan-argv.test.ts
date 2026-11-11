import { describe, expect, it } from 'vitest';
import { buildYushanArgs } from '../../../src/agent/yushan/argv.js';

describe('YuShan argv contract', () => {
  it('builds a fresh run argv without --resume', () => {
    expect(buildYushanArgs({ prompt: 'hello' })).toEqual(['--json', '--', 'hello']);
  });

  it('inserts --resume <id> between --json and the terminator', () => {
    expect(
      buildYushanArgs({ sessionId: '1794403057_979860000', prompt: 'hi' }),
    ).toEqual(['--json', '--resume', '1794403057_979860000', '--', 'hi']);
  });

  it('keeps the underscore timestamp session id verbatim', () => {
    const args = buildYushanArgs({ sessionId: '1794402820_061076000', prompt: 'hi' });
    expect(args).toContain('1794402820_061076000');
    expect(args[args.indexOf('--resume') + 1]).toBe('1794402820_061076000');
  });

  it('always puts --json first', () => {
    expect(buildYushanArgs({ prompt: 'hello' })[0]).toBe('--json');
    expect(buildYushanArgs({ sessionId: 'session-1', prompt: 'hi' })[0]).toBe('--json');
  });

  it('always emits -- immediately before the prompt', () => {
    const fresh = buildYushanArgs({ prompt: 'hello' });
    expect(fresh).toContain('--');
    expect(fresh[fresh.length - 2]).toBe('--');

    const resumed = buildYushanArgs({ sessionId: 'session-1', prompt: 'hi' });
    expect(resumed[resumed.length - 2]).toBe('--');

    // The terminator appears exactly once.
    expect(fresh.filter((token) => token === '--')).toHaveLength(1);
    expect(resumed.filter((token) => token === '--')).toHaveLength(1);
  });

  it('puts the prompt last as the single trailing token', () => {
    for (const prompt of ['hello', 'a b\nc', '--stats', '']) {
      const args = buildYushanArgs({ sessionId: 'session-1', prompt });
      expect(args[args.length - 1]).toBe(prompt);
      // No other token may carry the prompt value.
      expect(args.filter((token) => token === prompt)).toHaveLength(1);
    }
  });

  it('omits --resume for an empty or undefined session id', () => {
    expect(buildYushanArgs({ prompt: 'hi', sessionId: '' })).toEqual(['--json', '--', 'hi']);
    expect(buildYushanArgs({ prompt: 'hi', sessionId: undefined })).toEqual([
      '--json',
      '--',
      'hi',
    ]);
    expect(buildYushanArgs({ prompt: 'hi' })).not.toContain('--resume');
  });

  it('passes flag-like prompts through verbatim as task text', () => {
    expect(buildYushanArgs({ prompt: '--stats' })).toEqual(['--json', '--', '--stats']);
    expect(buildYushanArgs({ prompt: '--debug' })).toEqual(['--json', '--', '--debug']);
    expect(buildYushanArgs({ prompt: '--resume' })).toEqual(['--json', '--', '--resume']);
    expect(buildYushanArgs({ prompt: '--json' })).toEqual(['--json', '--', '--json']);
    expect(buildYushanArgs({ prompt: '-foo 任务' })).toEqual(['--json', '--', '-foo 任务']);
  });

  it('keeps multi-line and spaced prompts as one unsplit token', () => {
    const prompt = 'a b\nc';
    const args = buildYushanArgs({ prompt });
    expect(args).toHaveLength(3);
    expect(args[args.length - 1]).toBe(prompt);
  });

  it('never leaves the resume id as the final token', () => {
    const args = buildYushanArgs({ sessionId: 'session-1', prompt: 'hi' });
    const resumeIdx = args.indexOf('--resume');
    expect(resumeIdx).toBeGreaterThanOrEqual(0);
    // `--resume` must have an id right after it...
    expect(args[resumeIdx + 1]).toBe('session-1');
    // ...and that id must not be the last token (bare --resume would open a picker).
    expect(resumeIdx + 1).not.toBe(args.length - 1);
  });

  it('does not throw for very long prompts and keeps them intact', () => {
    const prompt = 'x'.repeat(200 * 1024);
    const args = buildYushanArgs({ sessionId: 'session-1', prompt });
    expect(args[args.length - 1]).toBe(prompt);
    expect(args).toHaveLength(5);
  });

  describe('unsafe session ids', () => {
    // The id is the only data-plane token that sits *before* `--`. A leading
    // `-` would be swallowed as a flag and shift the prompt, so such ids are
    // dropped in favour of a fresh run.
    it.each(['-rf', '--resume', '--json', '-', '  spaces  ', 'has space', '']) (
      'drops %j instead of letting it shift the argv',
      (sessionId) => {
        expect(buildYushanArgs({ sessionId, prompt: 'hi' })).toEqual(['--json', '--', 'hi']);
      },
    );

    it('accepts the real timestamp_nanos shape', () => {
      expect(buildYushanArgs({ sessionId: '1794403057_979860000', prompt: 'hi' })).toEqual([
        '--json',
        '--resume',
        '1794403057_979860000',
        '--',
        'hi',
      ]);
    });
  });
});
