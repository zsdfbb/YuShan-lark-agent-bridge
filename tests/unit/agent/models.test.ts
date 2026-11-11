import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL,
  isDefaultModel,
  modelLabel,
  normalizeModelSelection,
  resolveModelArg,
  supportedModels,
} from '../../../src/agent/models.js';

describe('agent model catalog', () => {
  it('offers a distinct catalog per agent kind, each led by the default sentinel', () => {
    const claude = supportedModels('claude');
    const codex = supportedModels('codex');
    expect(claude[0]?.value).toBe(DEFAULT_MODEL);
    expect(codex[0]?.value).toBe(DEFAULT_MODEL);
    expect(claude.map((m) => m.value)).toContain('claude-opus-4-8');
    expect(codex.map((m) => m.value)).toContain('gpt-5-codex');
    expect(claude.map((m) => m.value)).not.toContain('gpt-5-codex');
  });

  it('treats unset and the default sentinel as "use agent default"', () => {
    expect(isDefaultModel(undefined)).toBe(true);
    expect(isDefaultModel('')).toBe(true);
    expect(isDefaultModel(DEFAULT_MODEL)).toBe(true);
    expect(isDefaultModel('claude-opus-4-8')).toBe(false);
  });

  it('coerces unknown / cross-agent selections back to the default option', () => {
    expect(normalizeModelSelection('claude', 'claude-opus-4-8')).toBe('claude-opus-4-8');
    // A Codex model left over after switching a profile to Claude is invalid.
    expect(normalizeModelSelection('claude', 'gpt-5-codex')).toBe(DEFAULT_MODEL);
    expect(normalizeModelSelection('claude', undefined)).toBe(DEFAULT_MODEL);
  });

  it('resolves the --model argument, omitting it for the default', () => {
    expect(resolveModelArg('claude', 'claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(resolveModelArg('claude', DEFAULT_MODEL)).toBeUndefined();
    expect(resolveModelArg('claude', undefined)).toBeUndefined();
    // Cross-agent value → no flag rather than a broken model.
    expect(resolveModelArg('codex', 'claude-opus-4-8')).toBeUndefined();
  });

  it('labels a stored value using the picker option text', () => {
    expect(modelLabel('claude', 'claude-opus-4-8')).toBe('Opus 4.8（最新）');
    expect(modelLabel('claude', DEFAULT_MODEL)).toContain('跟随默认');
  });

  describe('yushan branch', () => {
    it('offers only the default sentinel — no concrete model catalog', () => {
      const yushan = supportedModels('yushan');
      expect(yushan).toHaveLength(1);
      expect(yushan[0]?.value).toBe(DEFAULT_MODEL);
    });

    it('never leaks another agent\'s model ids into the yushan catalog', () => {
      const values = supportedModels('yushan').map((m) => m.value);
      expect(values.filter((v) => v.startsWith('claude-') || v.startsWith('gpt-'))).toEqual([]);
    });

    it('drops a cross-agent leftover instead of forwarding it to YuShan', () => {
      expect(resolveModelArg('yushan', 'claude-opus-4-8')).toBeUndefined();
    });

    it('omits the model argument for the default sentinel', () => {
      expect(resolveModelArg('yushan', DEFAULT_MODEL)).toBeUndefined();
    });

    it('normalizes a stale Claude selection back to the default option', () => {
      expect(normalizeModelSelection('yushan', 'claude-opus-4-8')).toBe(DEFAULT_MODEL);
    });

    it('labels the default option for the saved-config card', () => {
      expect(modelLabel('yushan', DEFAULT_MODEL)).toBe('跟随默认（不指定）');
    });
  });

  it('regression: claude and codex catalogs are unchanged', () => {
    expect(supportedModels('claude')).toHaveLength(7);
    expect(supportedModels('claude').map((m) => m.value)).toEqual([
      DEFAULT_MODEL,
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-sonnet-5',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
      'opusplan',
    ]);
    expect(supportedModels('codex')).toHaveLength(4);
    expect(supportedModels('codex').map((m) => m.value)).toEqual([
      DEFAULT_MODEL,
      'gpt-5-codex',
      'gpt-5',
      'o3',
    ]);
  });
});
