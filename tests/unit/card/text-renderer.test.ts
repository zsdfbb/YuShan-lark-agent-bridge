import { describe, expect, it } from 'vitest';
import { finalAnswerOnlyState } from '../../../src/bot/cot';
import { initialState, type RunState } from '../../../src/card/run-state';
import { renderText } from '../../../src/card/text-renderer';

function stateWithFinalTextOnly(finalText: string): RunState {
  return { ...initialState, blocks: [], finalText, terminal: 'done', footer: null };
}

describe('renderText reads blocks, not finalText', () => {
  it('renders nothing when only finalText is set — the yushan-N3 counter-example', () => {
    // Documented counter-example: yushan emits no `text` events, only
    // `final_text`. `renderText` only walks `state.blocks`, so a state that
    // skipped the promotion renders an EMPTY body — silently, no error.
    // This is why yushan's finalText must be promoted to blocks first.
    const state = stateWithFinalTextOnly('雨山给出的答案');

    expect(renderText(state)).toBe('');
  });

  it('renders the answer once finalText has been promoted to blocks', () => {
    const promoted = finalAnswerOnlyState(stateWithFinalTextOnly('雨山给出的答案'));

    expect(promoted.blocks).toHaveLength(1);
    expect(renderText(promoted)).toBe('雨山给出的答案');
  });
});
