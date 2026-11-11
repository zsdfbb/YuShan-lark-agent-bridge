import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => ({
  spawnProcess: vi.fn(),
}));

vi.mock('../../../src/platform/spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/platform/spawn')>();
  return { ...actual, spawnProcess: spawnMock.spawnProcess };
});

import {
  terminationForExit,
  buildYushanEnv,
  YushanAdapter,
} from '../../../src/agent/yushan/adapter';
import type { AgentEvent } from '../../../src/agent/types';

interface FakeChild extends EventEmitter {
  pid: number;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4242;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn();
  return child;
}

const PROFILE_STATE_DIR = join('/tmp', 'ys-profile');

function adapter(): YushanAdapter {
  return new YushanAdapter({
    binary: '/usr/local/bin/ys-coding-agent',
    profileStateDir: PROFILE_STATE_DIR,
  });
}

function spawnArgs(): string[] {
  return spawnMock.spawnProcess.mock.calls[0]?.[1] as string[];
}

function spawnEnv(): NodeJS.ProcessEnv {
  const options = spawnMock.spawnProcess.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv };
  return options.env ?? {};
}

beforeEach(() => {
  spawnMock.spawnProcess.mockReset();
});

describe('YushanAdapter argv', () => {
  it('always emits --json, the -- terminator and the prompt as one token', () => {
    spawnMock.spawnProcess.mockReturnValue(fakeChild());

    adapter().run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    expect(spawnMock.spawnProcess).toHaveBeenCalledTimes(1);
    expect(spawnArgs()).toEqual(['--json', '--', 'hi']);
  });

  it('resumes with --resume <id> ahead of the terminator when a sessionId is given', () => {
    spawnMock.spawnProcess.mockReturnValue(fakeChild());

    adapter().run({ runId: 'r1', prompt: 'hi', cwd: '/tmp', sessionId: 's1' });

    expect(spawnArgs()).toEqual(['--json', '--resume', 's1', '--', 'hi']);
  });
});

describe('YushanAdapter env', () => {
  it('isolates sessions per profile and pins YUSHAN_DEBUG off', () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);

    adapter().run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    const env = spawnEnv();
    expect(env.YUSHAN_SESSIONS_DIR).toBe(join(PROFILE_STATE_DIR, 'yushan-sessions'));
    expect(env.YUSHAN_SESSIONS_DIR?.endsWith('yushan-sessions')).toBe(true);
    expect(env.YUSHAN_DEBUG).toBe('0');
    // The bridge always pipes the task via argv, so stdin must be closed.
    expect(child.stdin.writableEnded).toBe(true);
  });

  it('injects YUSHAN_MODEL when a model was selected', () => {
    spawnMock.spawnProcess.mockReturnValue(fakeChild());

    adapter().run({ runId: 'r1', prompt: 'hi', cwd: '/tmp', model: 'my-model' });

    expect(spawnEnv().YUSHAN_MODEL).toBe('my-model');
  });

  it('omits the YUSHAN_MODEL key entirely when no model was selected', () => {
    spawnMock.spawnProcess.mockReturnValue(fakeChild());

    adapter().run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    const env = spawnEnv();
    expect('YUSHAN_MODEL' in env).toBe(false);
    // Same for the pure builder: absence, not an empty string.
    expect('YUSHAN_MODEL' in buildYushanEnv({ profileStateDir: PROFILE_STATE_DIR })).toBe(false);
    expect(
      'YUSHAN_MODEL' in buildYushanEnv({ profileStateDir: PROFILE_STATE_DIR, model: '' }),
    ).toBe(false);
  });
});

describe('terminationForExit', () => {
  it('never overrides a terminal event the translator already emitted', () => {
    expect(terminationForExit(0, true)).toBe('none');
    expect(terminationForExit(75, true)).toBe('none');
    expect(terminationForExit(1, true)).toBe('none');
    expect(terminationForExit(null, true)).toBe('none');
  });

  it('reads exit 75 as interrupted only when no terminal event arrived', () => {
    expect(terminationForExit(75, false)).toBe('interrupted');
  });

  it('reads exit 1 as failure', () => {
    expect(terminationForExit(1, false)).toBe('failed');
  });

  it('reads exit 0 as a normal close', () => {
    expect(terminationForExit(0, false)).toBe('normal');
  });

  it('reads a signal kill (no exit code) as failure', () => {
    expect(terminationForExit(null, false)).toBe('failed');
    expect(terminationForExit(137, false)).toBe('failed');
  });
});

describe('YushanAdapter terminal fallback', () => {
  it('adds no terminal event when RunFinished already ended the stream (exit 75)', async () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const run = adapter().run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    // Cancelled run: the JSON event says so, so exit 75 must not add another.
    child.stdout.write(`${JSON.stringify({ type: 'session', id: 'sess-1' })}\n`);
    child.stdout.write(
      `${JSON.stringify({ source: 'agent', turn: 1, event: { RunFinished: { stop_reason: 'Cancelled' } } })}\n`,
    );
    child.stdout.end();
    child.exitCode = 75;
    child.emit('exit', 75, null);

    const events = await collect(run.events);

    expect(events.map((event) => event.type)).toEqual(['system', 'done']);
    expect(terminalCount(events)).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'interrupted' });
  });

  it('falls back to interrupted for exit 75 when stdout closed with no terminal event', async () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const run = adapter().run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    child.stdout.write(`${JSON.stringify({ type: 'session', id: 'sess-1' })}\n`);
    child.stdout.write('not json at all\n');
    child.stdout.end();
    child.exitCode = 75;
    child.emit('exit', 75, null);

    const events = await collect(run.events);

    expect(terminalCount(events)).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'interrupted' });
  });

  it('falls back to a normal done for exit 0 when stdout closed with no terminal event', async () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const run = adapter().run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    child.stdout.end();
    child.exitCode = 0;
    child.emit('exit', 0, null);

    const events = await collect(run.events);

    expect(events).toEqual([{ type: 'done', terminationReason: 'normal' }]);
  });

  it('reports failure with the stderr tail when exiting 1 without a terminal event', async () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const run = adapter().run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    child.stderr.write('未知参数: --nope\n');
    child.stdout.end();
    child.exitCode = 1;
    child.emit('exit', 1, null);

    const events = await collect(run.events);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', terminationReason: 'failed' });
    expect((events[0] as { message: string }).message).toContain('未知参数: --nope');
  });

  it('translates a full Completed stream into system/final_text/usage/done', async () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const run = adapter().run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    for (const line of [
      { type: 'session', id: 'sess-1' },
      { source: 'agent', turn: 1, event: { ModelTextDelta: { text: '答案' } } },
      {
        source: 'agent',
        turn: 1,
        event: {
          RunFinished: {
            stop_reason: 'Completed',
            usage: { input_tokens: 10, output_tokens: 2 },
          },
        },
      },
    ]) {
      child.stdout.write(`${JSON.stringify(line)}\n`);
    }
    child.stdout.end();
    child.exitCode = 0;
    child.emit('exit', 0, null);

    const events = await collect(run.events);

    expect(events.map((event) => event.type)).toEqual(['system', 'final_text', 'usage', 'done']);
    expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });
  });
});

describe('YushanAdapter stop', () => {
  it('sends SIGTERM first and closes out as interrupted', async () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const run = adapter().run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    const stopping = run.stop();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.exitCode = 143;
    child.emit('exit', 143, null);
    await stopping;
  });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function terminalCount(events: AgentEvent[]): number {
  return events.filter((event) => event.type === 'done' || event.type === 'error').length;
}
