import { describe, expect, it, spyOn } from 'bun:test';
import {
  calculateModelCost,
  getModelPricingDetailed,
  type TokenUsage,
} from './pricing';

// 1M of each token type — cost in USD then reads straight off the $/MTok table.
const ONE_MTOK_EACH: TokenUsage = {
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
  cacheReadTokens: 1_000_000,
  cacheWriteTokens: 1_000_000,
};

describe('getModelPricingDetailed', () => {
  it('matches a current-generation id exactly', () => {
    const match = getModelPricingDetailed('claude-opus-5');
    expect(match.matchQuality).toBe('exact');
    expect(match.modelId).toBe('claude-opus-5');
    expect(match.pricing).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
  });

  it('matches a legacy dated id exactly', () => {
    const match = getModelPricingDetailed('claude-opus-4-5-20251101');
    expect(match.matchQuality).toBe('exact');
    expect(match.pricing.input).toBe(5);
    expect(match.pricing.output).toBe(25);
  });

  it('strips a date suffix from a current-generation id', () => {
    const match = getModelPricingDetailed('claude-sonnet-5-20260401');
    expect(match.matchQuality).toBe('normalized');
    expect(match.modelId).toBe('claude-sonnet-5');
    expect(match.pricing.input).toBe(2);
  });

  it('falls back to a family rule for an unlisted variant', () => {
    const match = getModelPricingDetailed('us.anthropic.claude-opus-4-8-v1:0');
    expect(match.matchQuality).toBe('family');
    expect(match.modelId).toBe('claude-opus-4-8');
    expect(match.pricing.input).toBe(5);
  });

  it('prefers Fable 5.1 over Fable 5 despite the shared prefix', () => {
    expect(getModelPricingDetailed('claude-fable-5-1').pricing.cacheRead).toBe(0.25);
    expect(getModelPricingDetailed('claude-fable-5').pricing.cacheRead).toBe(1.0);
  });

  it('logs loudly and reports fallback quality for a bogus model id', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const match = getModelPricingDetailed('totally-not-a-model-9000');
      expect(match.matchQuality).toBe('fallback');
      expect(match.modelId).toBe('totally-not-a-model-9000');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain('totally-not-a-model-9000');

      // Same id again: still fallback, but only warned once per process.
      expect(getModelPricingDetailed('totally-not-a-model-9000').matchQuality).toBe('fallback');
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('calculateModelCost', () => {
  it('prices Fable 5.1 with its special 0.025x cache read', () => {
    // 10 + 50 + 0.25 + 12.50
    expect(calculateModelCost(ONE_MTOK_EACH, 'claude-fable-5-1')).toBeCloseTo(72.75, 10);
  });

  it('prices Opus 5', () => {
    // 5 + 25 + 0.50 + 6.25
    expect(calculateModelCost(ONE_MTOK_EACH, 'claude-opus-5')).toBeCloseTo(36.75, 10);
  });

  it('prices Sonnet 5', () => {
    // 2 + 10 + 0.20 + 2.50
    expect(calculateModelCost(ONE_MTOK_EACH, 'claude-sonnet-5')).toBeCloseTo(14.7, 10);
  });

  it('prices Haiku 4.5', () => {
    // 1 + 5 + 0.10 + 1.25
    expect(calculateModelCost(ONE_MTOK_EACH, 'claude-haiku-4-5')).toBeCloseTo(7.35, 10);
  });

  it('prices a legacy dated id (Opus 4)', () => {
    // 15 + 75 + 1.50 + 18.75
    expect(calculateModelCost(ONE_MTOK_EACH, 'claude-opus-4-20250514')).toBeCloseTo(110.25, 10);
  });

  it('prices a realistic mixed-token Opus 5 request', () => {
    const usage: TokenUsage = {
      inputTokens: 12_000,
      outputTokens: 3_500,
      cacheReadTokens: 480_000,
      cacheWriteTokens: 25_000,
    };
    const expected =
      (12_000 * 5 + 3_500 * 25 + 480_000 * 0.5 + 25_000 * 6.25) / 1_000_000;
    expect(calculateModelCost(usage, 'claude-opus-5')).toBeCloseTo(expected, 10);
    expect(expected).toBeCloseTo(0.54375, 10);
  });
});
