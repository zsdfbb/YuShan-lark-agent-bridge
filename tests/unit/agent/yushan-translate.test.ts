import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types.js';
import { YushanTranslator } from '../../../src/agent/yushan/translate.js';

const SESSION_ID = '1794402820_061076000';
const CALL_ID = 'call_eb32de0e901240038ab5c57a';
const FINAL_SENTENCE =
  '当前目录只有两个文件：`fixture-normal.err` 和 `fixture-normal.ndjson`，看起来像是一组测试夹具（fixture）输出。';

/** Envelope wrapper, matching the real `{source, turn, event}` shape. */
function envelope(event: Record<string, unknown>, turn = 1): Record<string, unknown> {
  return { source: 'agent', turn, event };
}

function textDelta(text: string): Record<string, unknown> {
  return envelope({ ModelTextDelta: { text } });
}

function roundUsage(
  round: number,
  input: number,
  output: number,
  cacheHit: number,
  reasoning: number,
): Record<string, unknown> {
  return envelope({
    RoundUsage: {
      purpose: 'turn',
      round,
      usage: {
        input_tokens: input,
        output_tokens: output,
        prompt_cache_hit_tokens: cacheHit,
        reasoning_tokens: reasoning,
      },
    },
  });
}

function usageEvents(events: AgentEvent[]): AgentEvent[] {
  return events.filter((event) => event.type === 'usage');
}

describe('YuShan NDJSON translator', () => {
  it('translates the session line into a system event', () => {
    const t = new YushanTranslator();

    expect(t.translate({ id: SESSION_ID, type: 'session' })).toEqual([
      { type: 'system', sessionId: SESSION_ID },
    ]);
  });

  it('buffers ModelTextDelta and emits the joined sentence once at RunFinished', () => {
    const t = new YushanTranslator();
    t.translate({ id: SESSION_ID, type: 'session' });
    const deltas = [
      '当前目录只有两个文件：',
      '`fixture-normal.err`',
      ' 和 ',
      '`fixture-normal.ndjson`',
      '，看起来像是',
      '一组测试夹具',
      '（fixture）',
      '输出。',
    ];

    for (const delta of deltas) {
      expect(t.translate(textDelta(delta))).toEqual([]);
    }
    // No `text` event may escape while the attempt is still in flight.
    const finished = t.translate(
      envelope({ RunFinished: { stop_reason: 'Completed', rounds: 2 } }),
    );

    expect(finished).toEqual([
      { type: 'final_text', content: FINAL_SENTENCE },
      { type: 'done', sessionId: SESSION_ID, terminationReason: 'normal' },
    ]);
  });

  it('drops buffered text when ModelStreamDiscarded replays the attempt', () => {
    const t = new YushanTranslator();

    expect(t.translate(textDelta('第一份草稿'))).toEqual([]);
    expect(t.translate(textDelta('，会被作废'))).toEqual([]);
    expect(t.translate(envelope({ ModelStreamDiscarded: { reason: 'retryable error' } }))).toEqual(
      [],
    );
    expect(t.translate(textDelta('重放后的正文'))).toEqual([]);

    const events = t.translate(envelope({ RunFinished: { stop_reason: 'Completed' } }));

    expect(events[0]).toEqual({ type: 'final_text', content: '重放后的正文' });
  });

  it('drops buffered text on a discarded stream and emits no final_text when empty', () => {
    const t = new YushanTranslator();

    t.translate(textDelta('草稿'));
    t.translate({ source: 'agent', turn: 1, event: { ModelStreamDiscarded: {} } });

    expect(t.translate(envelope({ RunFinished: { stop_reason: 'NoOutput' } }))).toEqual([
      { type: 'done', terminationReason: 'normal' },
    ]);
  });

  it('maps ToolCall and ToolResult as a pair, including error results', () => {
    const t = new YushanTranslator();

    expect(
      t.translate(
        envelope({ ToolCall: { call: { id: CALL_ID, name: 'ls', arguments: { path: '.' } } } }),
      ),
    ).toEqual([{ type: 'tool_use', id: CALL_ID, name: 'ls', input: { path: '.' } }]);

    expect(
      t.translate(
        envelope({
          ToolResult: {
            id: CALL_ID,
            result: { content: 'fixture-normal.err\nfixture-normal.ndjson', is_error: false },
          },
        }),
      ),
    ).toEqual([
      {
        type: 'tool_result',
        id: CALL_ID,
        output: 'fixture-normal.err\nfixture-normal.ndjson',
        isError: false,
      },
    ]);

    expect(
      t.translate(
        envelope({
          ToolResult: { id: CALL_ID, result: { content: 'ls: not found', is_error: true } },
        }),
      ),
    ).toEqual([
      { type: 'tool_result', id: CALL_ID, output: 'ls: not found', isError: true },
    ]);
  });

  it('maps ModelThinkingDelta and swallows UserMessage / RoundStarted', () => {
    const t = new YushanTranslator();

    expect(t.translate(envelope({ ModelThinkingDelta: { text: '想想' } }))).toEqual([
      { type: 'thinking', delta: '想想' },
    ]);
    expect(
      t.translate(
        envelope({
          UserMessage: { message: { role: 'User', content: [{ Text: { text: '用 ls 看一下' } }] } },
        }),
      ),
    ).toEqual([]);
    expect(t.translate(envelope({ RoundStarted: { round: 1 } }))).toEqual([]);
  });

  it('emits usage exactly once, from the RunFinished total', () => {
    const t = new YushanTranslator();
    const collected: AgentEvent[] = [];

    // RoundUsage is a per-round delta: 7814 + 7872 = 15686.
    collected.push(...t.translate(roundUsage(1, 7814, 37, 0, 0)));
    collected.push(...t.translate(roundUsage(2, 7872, 36, 7808, 0)));
    expect(collected).toEqual([]);

    collected.push(
      ...t.translate(
        envelope({
          RunFinished: {
            stop_reason: 'Completed',
            usage: {
              input_tokens: 15686,
              output_tokens: 73,
              prompt_cache_hit_tokens: 7808,
              reasoning_tokens: 0,
            },
            rounds: 2,
          },
        }),
      ),
    );

    const usages = usageEvents(collected);
    expect(usages).toHaveLength(1);
    expect(usages[0]).toEqual({
      type: 'usage',
      inputTokens: 15686,
      outputTokens: 73,
      cachedInputTokens: 7808,
      reasoningOutputTokens: 0,
    });
    expect('costUsd' in (usages[0] as object)).toBe(false);

    const event = usages[0];
    expect(event?.type === 'usage' ? event.inputTokens : undefined).not.toBe(7814);
    expect(event?.type === 'usage' ? event.inputTokens : undefined).not.toBe(7872);
  });

  it('orders final_text before usage before done', () => {
    const t = new YushanTranslator();

    t.translate(textDelta('总结'));
    const events = t.translate(
      envelope({
        RunFinished: {
          stop_reason: 'Completed',
          usage: { input_tokens: 1, output_tokens: 2 },
          rounds: 1,
        },
      }),
    );

    const finalIndex = events.findIndex((event) => event.type === 'final_text');
    const usageIndex = events.findIndex((event) => event.type === 'usage');
    const doneIndex = events.findIndex((event) => event.type === 'done');

    expect(finalIndex).toBeGreaterThanOrEqual(0);
    expect(finalIndex).toBeLessThan(usageIndex);
    expect(usageIndex).toBeLessThan(doneIndex);
  });

  it('omits usage when RunFinished carries none', () => {
    const t = new YushanTranslator();

    const events = t.translate(envelope({ RunFinished: { stop_reason: 'Completed' } }));

    expect(usageEvents(events)).toEqual([]);
    expect(events).toEqual([{ type: 'done', terminationReason: 'normal' }]);
  });

  it.each(['Completed', 'MaxRounds', 'Truncated', 'NoOutput'])(
    'maps stop_reason %s to a normal termination',
    (stopReason) => {
      const t = new YushanTranslator();
      t.translate(textDelta('正文'));

      const events = t.translate(envelope({ RunFinished: { stop_reason: stopReason } }));
      const done = events.at(-1);

      expect(done).toEqual({ type: 'done', terminationReason: 'normal' });
    },
  );

  it('maps stop_reason Cancelled to an interrupted termination, keeping the buffer', () => {
    const t = new YushanTranslator();
    t.translate(textDelta('半句话'));

    expect(t.translate(envelope({ RunFinished: { stop_reason: 'Cancelled' } }))).toEqual([
      { type: 'final_text', content: '半句话' },
      { type: 'done', terminationReason: 'interrupted' },
    ]);
  });

  it('emits no final_text for NoOutput', () => {
    const t = new YushanTranslator();

    const events = t.translate(envelope({ RunFinished: { stop_reason: 'NoOutput' } }));

    expect(events.some((event) => event.type === 'final_text')).toBe(false);
    expect(events).toEqual([{ type: 'done', terminationReason: 'normal' }]);
  });

  it('maps RunFailed to a single error event with no done', () => {
    const t = new YushanTranslator();
    t.translate(textDelta('写到一半'));

    const events = t.translate(envelope({ RunFailed: { error: 'boom' } }));

    expect(events).toEqual([{ type: 'error', message: 'boom', terminationReason: 'failed' }]);
    expect(events.some((event) => event.type === 'done')).toBe(false);
  });

  it('counts unknown events and malformed lines as separate drift', () => {
    const t = new YushanTranslator();

    expect(t.translate({ source: 'agent', turn: 1, event: { DeferredResult: {} } })).toEqual([]);
    expect(t.drift.unknownEvents).toBe(1);
    expect(t.drift.anomalies).toBe(0);

    expect(t.translate(null)).toEqual([]);
    expect(t.drift.anomalies).toBe(1);
    expect(t.drift.unknownEvents).toBe(1);
  });

  it('is idempotent once a terminal event has been emitted', () => {
    const t = new YushanTranslator();

    t.translate(textDelta('正文'));
    t.translate(envelope({ RunFinished: { stop_reason: 'Completed' } }));
    expect(t.terminalEmitted()).toBe(true);

    expect(t.translate(textDelta('迟到的增量'))).toEqual([]);
    expect(t.translate(envelope({ ToolCall: { call: { id: 'x', name: 'ls', arguments: {} } } })))
      .toEqual([]);
    expect(t.finish('failed')).toEqual([]);
    expect(t.finishWithExitCode(1, 'panic')).toEqual([]);
  });

  it('falls back to an exit code when the stream ends without a terminal event', () => {
    const t = new YushanTranslator();
    t.translate(textDelta('正文'));

    expect(t.finishWithExitCode(75, '')).toEqual([
      { type: 'final_text', content: '正文' },
      { type: 'done', terminationReason: 'normal' },
    ]);
  });

  it('finishes as failed when the stream ends without a terminal event', () => {
    const t = new YushanTranslator();

    const events = t.finish('failed');

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', terminationReason: 'failed' });
    expect(t.terminalEmitted()).toBe(true);
  });
});
