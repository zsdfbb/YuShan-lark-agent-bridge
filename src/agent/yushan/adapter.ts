import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { log } from '../../core/logger';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { SpawnFailed } from '../../runtime/errors';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from '../types';
import { buildYushanArgs } from './argv';
import { YushanTranslator, type YushanFinishReason } from './translate';

export interface YushanAdapterOptions {
  binary: string;
  profileStateDir: string;
  stopGraceMs?: number;
  larkChannel?: LarkChannelEnvContext;
}

type YushanChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

/**
 * YuShan's "no output produced" exit code. Cancelled *also* exits 75, so the
 * code alone cannot tell them apart — the JSON `RunFinished{stop_reason}`
 * event is authoritative and this code is only the fallback when stdout
 * closed without a terminal event (see `terminationForExit`).
 */
const YUSHAN_EXIT_CANCELLED_OR_NO_OUTPUT = 75;

/** Baseline grace period; SIGTERM lets YuShan abort the current tool first. */
const MIN_STOP_GRACE_MS = 10_000;

/**
 * How the adapter should close out a stream that produced no terminal event.
 *
 * `'none'` means "the translator already emitted `done`/`error`, add nothing".
 */
export type YushanExitTermination = 'none' | 'normal' | 'interrupted' | 'failed';

/**
 * Maps an exit code onto the fallback terminal semantics.
 *
 * Only consulted when `hadTerminal` is false: a `RunFinished` / `RunFailed`
 * event always wins over the exit code, because exit 75 is ambiguous
 * (Cancelled and NoOutput share it).
 */
export function terminationForExit(
  exitCode: number | null,
  hadTerminal: boolean,
): YushanExitTermination {
  if (hadTerminal) return 'none';
  if (exitCode === 0) return 'normal';
  if (exitCode === YUSHAN_EXIT_CANCELLED_OR_NO_OUTPUT) return 'interrupted';
  // exit 1 (Failed), any other code, or null (killed by a signal).
  return 'failed';
}

export interface BuildYushanEnvInput {
  profileStateDir: string;
  /** Bridge model selection; omitted entirely when empty so YuShan keeps its own. */
  model?: string;
  larkChannel?: LarkChannelEnvContext;
}

/** Builds the env overrides handed to `mergeProcessEnv`. */
export function buildYushanEnv(input: BuildYushanEnvInput): NodeJS.ProcessEnv {
  return {
    ...buildLarkChannelEnv(input.larkChannel),
    // Per-profile session isolation, mirroring codex's CODEX_HOME.
    YUSHAN_SESSIONS_DIR: join(input.profileStateDir, 'yushan-sessions'),
    // Only set when there is a real choice: an empty value would override the
    // model configured in ~/.yushan/state.json with nothing.
    ...(input.model ? { YUSHAN_MODEL: input.model } : {}),
    // Structured logging would flood stderr, which the bridge only reads as
    // failure diagnostics.
    YUSHAN_DEBUG: '0',
  };
}

export class YushanAdapter implements AgentAdapter {
  readonly id = 'yushan';
  readonly displayName = 'YuShan';

  private readonly binary: string;
  private readonly profileStateDir: string;
  private readonly defaultStopGraceMs: number;
  private readonly larkChannel: LarkChannelEnvContext | undefined;

  constructor(opts: YushanAdapterOptions) {
    this.binary = opts.binary;
    this.profileStateDir = opts.profileStateDir;
    this.defaultStopGraceMs = Math.max(opts.stopGraceMs ?? 5000, MIN_STOP_GRACE_MS);
    this.larkChannel = opts.larkChannel;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'yushan',
      agentName: 'YuShan',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  async prepareRun(): Promise<void> {
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        'yushan binary check failed',
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic,
      );
    }
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for YushanAdapter.run');
    }

    // The prompt is one argv token (YuShan has no stdin task channel), so
    // `opts.images` is unused: attachments reach the model as prompt text refs.
    const args = buildYushanArgs({ sessionId: opts.sessionId, prompt: opts.prompt });
    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      env: mergeProcessEnv(
        process.env,
        buildYushanEnv({
          profileStateDir: this.profileStateDir,
          model: opts.model,
          larkChannel: this.larkChannel,
        }),
      ),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as YushanChild;

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd,
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      model: opts.model,
    });

    const stderrChunks: Buffer[] = [];
    let runtimeError: Error | null = null;
    let stderrBuffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBuffer += chunk.toString('utf8');
      let nl = stderrBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = stderrBuffer.slice(0, nl);
        stderrBuffer = stderrBuffer.slice(nl + 1);
        if (line.trim()) log.warn('agent', 'stderr', { line });
        nl = stderrBuffer.indexOf('\n');
      }
    });
    const stderrTail = (): string =>
      Buffer.concat(stderrChunks).toString('utf8').trim().slice(0, 500);

    let stopReason: YushanFinishReason | undefined;
    child.on('error', (err) => {
      runtimeError = err;
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
    });
    child.stdin.on('error', (err) => {
      log.warn('agent', 'stdin-error', { message: err.message });
    });
    // The task lives in argv; an open stdin would make YuShan wait forever.
    child.stdin.end();

    const stopGraceMs = opts.stopGraceMs ?? this.defaultStopGraceMs;

    return {
      runId: opts.runId,
      events: createEventStream(child, stderrTail, () => runtimeError, () => stopReason),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        stopReason = 'interrupted';
        log.info('agent', 'stop-sigterm', { pid: child.pid ?? null, graceMs: stopGraceMs });
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              log.warn('agent', 'stop-sigkill', {
                pid: child.pid ?? null,
                graceMs: stopGraceMs,
                reason: 'grace-period-expired',
              });
              child.kill('SIGKILL');
            }
            resolve();
          }, stopGraceMs);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        if (child.exitCode !== null || child.signalCode !== null) {
          return Promise.resolve(true);
        }
        return new Promise<boolean>((resolve) => {
          const onExit = (): void => {
            clearTimeout(timer);
            resolve(true);
          };
          const timer = setTimeout(() => {
            child.removeListener('exit', onExit);
            resolve(false);
          }, timeoutMs);
          child.once('exit', onExit);
        });
      },
    };
  }
}

async function* createEventStream(
  child: YushanChild,
  stderrTail: () => string,
  getError: () => Error | null,
  getStopReason: () => YushanFinishReason | undefined,
): AsyncGenerator<AgentEvent> {
  const translator = new YushanTranslator();
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn yushan: ${err.message}` : 'spawn returned no pid',
      terminationReason: 'failed',
    };
    return;
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let malformedLines = 0;
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // A garbled line is protocol drift, not a reason to kill the run.
        malformedLines++;
        continue;
      }
      yield* translator.translate(parsed);
    }
  } finally {
    rl.close();
  }

  if (malformedLines > 0 || translator.drift.unknownEvents > 0 || translator.drift.anomalies > 0) {
    log.warn('yushan', 'protocol-drift', {
      malformedLines,
      unknownEvents: translator.drift.unknownEvents,
      anomalies: translator.drift.anomalies,
    });
  }

  const earlyRuntimeError = getError();
  if (earlyRuntimeError && child.exitCode === null && child.signalCode === null) {
    if (!translator.terminalEmitted()) {
      yield {
        type: 'error',
        message: `yushan runtime error: ${earlyRuntimeError.message}`,
        terminationReason: 'failed',
      };
    }
    return;
  }

  const exitCode = await waitForExitCode(child);
  const stopReason = getStopReason();
  if (stopReason) {
    yield* translator.finish(stopReason);
    return;
  }

  switch (terminationForExit(exitCode, translator.terminalEmitted())) {
    case 'none':
      return;
    case 'normal':
      yield* translator.finishWithExitCode(0, stderrTail());
      return;
    case 'interrupted':
      yield* translator.finish('interrupted');
      return;
    case 'failed': {
      if (exitCode === null) {
        // Killed by a signal: no exit code to report, and the translator's
        // own message is the honest one here.
        log.warn('yushan', 'killed-before-terminal', { stderr: stderrTail() || null });
        yield* translator.finish('failed');
        return;
      }
      yield* translator.finishWithExitCode(exitCode, stderrTail());
      return;
    }
  }
}

async function waitForExitCode(child: YushanChild): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return child.exitCode;
  }
  return new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });
}
