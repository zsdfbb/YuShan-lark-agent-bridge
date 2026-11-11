import type { AgentEvent } from '../types';
import { log } from '../../core/logger';

export type YushanFinishReason = 'failed' | 'interrupted' | 'timeout';

export interface ProtocolDriftState {
  unknownEvents: number;
  anomalies: number;
}

/** stop_reason values that mean "the run ended cleanly, whatever it produced". */
const NORMAL_STOP_REASONS = new Set(['Completed', 'MaxRounds', 'Truncated', 'NoOutput']);

/**
 * Translates YuShan's `--json` NDJSON stream into `AgentEvent`s.
 *
 * Two shapes travel on that stream and are split before dispatch:
 *  - a session line `{type:'session', id}` (arrives first, but we don't rely
 *    on ordering — any position just records the id);
 *  - an envelope `{source, turn, event}` whose `event` is a single-key object
 *    (`{ModelTextDelta:{text}}`, `{RunFinished:{…}}`, …).
 *
 * Two deliberate departures from a verbatim mapping (see
 * docs/exec-plans/yushan-agent-adapter.md, constraints C1/C2):
 *  - `RoundUsage` is a *per-round delta* and the bridge's `usage` consumer only
 *    counts metrics, so emitting it per round would double-count. `usage` ships
 *    once, from `RunFinished.usage` (the total).
 *  - `ModelTextDelta` is buffered instead of streamed: the bridge's `text` event
 *    is additive and YuShan replays a whole attempt after
 *    `ModelStreamDiscarded`, which would leave two copies of the answer on the
 *    card with no way to retract one. The buffer is flushed as one
 *    `final_text` at the terminal event.
 */
export class YushanTranslator {
  private sessionId: string | undefined;
  private terminal = false;
  private lastNonTerminalError: string | undefined;
  private textBuffer = '';
  readonly drift: ProtocolDriftState = {
    unknownEvents: 0,
    anomalies: 0,
  };

  translate(raw: unknown): AgentEvent[] {
    if (this.terminal) return [];
    if (!isRecord(raw)) {
      this.drift.anomalies++;
      return [];
    }

    if (raw.type === 'session' && typeof raw.id === 'string') {
      this.sessionId = raw.id;
      return [{ type: 'system', sessionId: raw.id }];
    }

    const event = recordValue(raw.event);
    if (!event) {
      this.drift.anomalies++;
      return [];
    }

    const name = eventName(event);
    switch (name) {
      case 'UserMessage':
        // Echoed by the CLI for the prompt the bridge just sent; replaying it
        // would duplicate the user's own text on the card.
        return [];
      case 'RoundStarted':
        return [];
      case 'RoundUsage':
        // Total already arrives in RunFinished.usage — see C1.
        return [];
      case 'ModelThinkingDelta':
        return this.translateThinkingDelta(event);
      case 'ModelTextDelta':
        return this.translateTextDelta(event);
      case 'ModelStreamDiscarded':
        this.textBuffer = '';
        return [];
      case 'ToolCall':
        return this.translateToolCall(event);
      case 'ToolResult':
        return this.translateToolResult(event);
      case 'RunFinished':
        return this.translateRunFinished(event);
      case 'RunFailed':
        return this.translateRunFailed(event);
      default:
        // YuShan's protocol is not exhaustively documented: keep any
        // error-shaped payload so `finish('failed')` can report the real
        // reason instead of the generic "ended before a terminal event".
        this.recordUnknownEvent(name, event);
        return [];
    }
  }

  private recordUnknownEvent(name: string | undefined, event: Record<string, unknown>): void {
    this.drift.unknownEvents++;
    log.warn('yushan', 'unknown_event', { eventType: name ?? '<none>' });
    const detail = errorDetailOf(event);
    if (detail) this.lastNonTerminalError = detail;
  }

  /** Fallback for a stream that ended without a terminal event. Idempotent. */
  finish(reason: YushanFinishReason = 'failed'): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    const events = this.drainFinalText();
    if (reason === 'failed') {
      const detail = this.lastNonTerminalError ? `: ${this.lastNonTerminalError}` : '';
      events.push({
        type: 'error',
        message: truncate(`yushan stream ended before a terminal event${detail}`, 4096),
        terminationReason: 'failed',
      });
      return events;
    }
    events.push(this.doneEvent(reason));
    return events;
  }

  /**
   * Fallback for when stdout closed without a terminal event: map the CLI's
   * exit code onto a terminal event. Idempotent.
   */
  finishWithExitCode(exitCode: number, stderrTail: string): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    const events = this.drainFinalText();
    if (exitCode === 0) {
      events.push(this.doneEvent('normal'));
      return events;
    }
    if (exitCode === 75) {
      // YuShan's "no output produced" code. Not an interruption.
      events.push(this.doneEvent('normal'));
      return events;
    }
    const detail = stderrTail.trim() ? `: ${truncate(stderrTail.trim(), 500)}` : '';
    events.push({
      type: 'error',
      message: truncate(`yushan exited with code ${exitCode}${detail}`, 4096),
      terminationReason: 'failed',
    });
    return events;
  }

  terminalEmitted(): boolean {
    return this.terminal;
  }

  private translateThinkingDelta(event: Record<string, unknown>): AgentEvent[] {
    const body = recordValue(event.ModelThinkingDelta);
    const text = stringValue(body?.text);
    if (text === undefined || text === '') return [];
    return [{ type: 'thinking', delta: text }];
  }

  private translateTextDelta(event: Record<string, unknown>): AgentEvent[] {
    const body = recordValue(event.ModelTextDelta);
    const text = stringValue(body?.text);
    if (text === undefined) return [];
    this.textBuffer += text;
    return [];
  }

  private translateToolCall(event: Record<string, unknown>): AgentEvent[] {
    const body = recordValue(event.ToolCall);
    const call = recordValue(body?.call);
    const id = stringValue(call?.id);
    const name = stringValue(call?.name);
    if (!id || !name) {
      this.drift.anomalies++;
      return [];
    }
    return [{ type: 'tool_use', id, name, input: call?.arguments }];
  }

  private translateToolResult(event: Record<string, unknown>): AgentEvent[] {
    const body = recordValue(event.ToolResult);
    const id = stringValue(body?.id);
    if (!id) {
      this.drift.anomalies++;
      return [];
    }
    const result = recordValue(body?.result);
    return [
      {
        type: 'tool_result',
        id,
        output: result?.content === undefined ? '' : stringifyOutput(result.content),
        isError: result?.is_error === true,
      },
    ];
  }

  private translateRunFinished(event: Record<string, unknown>): AgentEvent[] {
    this.terminal = true;
    const body = recordValue(event.RunFinished);
    const stopReason = stringValue(body?.stop_reason);
    const events: AgentEvent[] = [];
    // NoOutput means the model produced nothing; there is no text to flush.
    if (stopReason !== 'NoOutput') {
      events.push(...this.drainFinalText());
    }
    this.textBuffer = '';
    const usage = usageEvent(body?.usage);
    if (usage) events.push(usage);
    events.push(this.doneEvent(terminationReasonFor(stopReason)));
    return events;
  }

  private doneEvent(reason: 'normal' | 'interrupted' | 'timeout'): AgentEvent {
    return this.sessionId
      ? { type: 'done', sessionId: this.sessionId, terminationReason: reason }
      : { type: 'done', terminationReason: reason };
  }

  private translateRunFailed(event: Record<string, unknown>): AgentEvent[] {
    this.terminal = true;
    const body = recordValue(event.RunFailed);
    const message =
      stringValue(body?.error) ??
      stringValue(recordValue(body?.error)?.message) ??
      'yushan run failed';
    this.textBuffer = '';
    return [{ type: 'error', message: truncate(message, 4096), terminationReason: 'failed' }];
  }

  private drainFinalText(): AgentEvent[] {
    if (!this.textBuffer) return [];
    const content = this.textBuffer;
    this.textBuffer = '';
    return [{ type: 'final_text', content }];
  }
}

function usageEvent(raw: unknown): AgentEvent | undefined {
  const usage = recordValue(raw);
  if (!usage) return undefined;
  const inputTokens = numberValue(usage.input_tokens);
  const outputTokens = numberValue(usage.output_tokens);
  const cachedInputTokens = numberValue(usage.prompt_cache_hit_tokens);
  const reasoningOutputTokens = numberValue(usage.reasoning_tokens);
  // No numbers at all means the field was absent, not zero — don't guess.
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cachedInputTokens === undefined &&
    reasoningOutputTokens === undefined
  ) {
    return undefined;
  }
  // Measured: a SIGTERM'd run reports `RunFinished{Cancelled}` with every
  // counter at 0. Reporting that as a usage sample would drag the profile's
  // token averages toward zero for work the model never did.
  if (
    !inputTokens &&
    !outputTokens &&
    !cachedInputTokens &&
    !reasoningOutputTokens
  ) {
    return undefined;
  }
  const event: AgentEvent = {
    type: 'usage',
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
  };
  return event;
}

/**
 * `Cancelled` is the only stop reason that maps to `interrupted`. Everything
 * else — including `NoOutput`, which shares exit code 75 with `Cancelled` — is
 * a normal completion. Switching on the exit code instead would turn an empty
 * answer into a spurious interruption.
 */
function terminationReasonFor(stopReason: string | undefined): 'normal' | 'interrupted' {
  if (stopReason === 'Cancelled') return 'interrupted';
  // Any stop reason outside the known set is an unknown-protocol signal, but
  // the stream did finish, so it is still a normal termination.
  if (stopReason && !NORMAL_STOP_REASONS.has(stopReason)) {
    log.warn('yushan', 'unknown_stop_reason', { stopReason });
  }
  return 'normal';
}

function eventName(event: Record<string, unknown>): string | undefined {
  for (const key of Object.keys(event)) return key;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Best-effort extraction of a human-readable reason from an unrecognised
 * envelope event. Only fires for error-shaped payloads (`{SomeError:{message}}`
 * or `{SomeError:"text"}`); anything else yields `undefined` so a merely
 * unknown-but-benign event never gets mistaken for a failure cause.
 */
function errorDetailOf(event: Record<string, unknown>): string | undefined {
  const name = eventName(event);
  if (!name || !/error|fail/i.test(name)) return undefined;
  const payload = event[name];
  if (typeof payload === 'string') return truncate(payload, 500);
  const body = recordValue(payload);
  const message =
    stringValue(body?.message) ?? stringValue(body?.error) ?? stringValue(body?.reason);
  return message ? truncate(message, 500) : undefined;
}

function stringifyOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}
