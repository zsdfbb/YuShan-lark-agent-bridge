import { describe, expect, it } from 'vitest';
import { usesFinalTextState } from '../../../src/card/run-state';

describe('usesFinalTextState', () => {
  it('is false for claude — it streams incremental text deltas', () => {
    expect(usesFinalTextState('claude')).toBe(false);
  });

  it('is true for codex — it holds the answer back as final_text', () => {
    expect(usesFinalTextState('codex')).toBe(true);
  });

  it('is true for yushan — it emits no text events at all, only final_text (N3)', () => {
    expect(usesFinalTextState('yushan')).toBe(true);
  });

  it.each(['codex', 'yushan'] as const)(
    '%s must go through the finalText -> blocks promotion path',
    (agentKind) => {
      expect(usesFinalTextState(agentKind)).toBe(true);
    },
  );
});
