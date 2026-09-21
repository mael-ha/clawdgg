import { describe, expect, it, spyOn } from 'bun:test';
import {
  calculateModelCost,
  getModelPricingDetailed,
  splitCacheCreationTokens,
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
    expect(match.pricing).toEqual({
      input: 5,
      output: 25,
      cacheRead: 0.5,
      cacheWrite5m: 6.25,
      cacheWrite1h: 10,
    });
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
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const match = getModelPricingDetailed('claude-opus-4-8-turbo');
      expect(match.matchQuality).toBe('family');
      expect(match.modelId).toBe('claude-opus-4-8');
      expect(match.pricing.input).toBe(5);
    } finally {
      warn.mockRestore();
    }
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

describe('splitCacheCreationTokens', () => {
  it('reads the nested 1h/5m breakdown', () => {
    const split = splitCacheCreationTokens({
      cache_creation_input_tokens: 3439,
      cache_creation: { ephemeral_1h_input_tokens: 3000, ephemeral_5m_input_tokens: 439 },
    });
    expect(split).toEqual({ tokens5m: 439, tokens1h: 3000, fromFlatFallback: false });
  });

  it('falls back to the flat total at the 5m rate when the split is absent', () => {
    const split = splitCacheCreationTokens({ cache_creation_input_tokens: 5000 });
    expect(split).toEqual({ tokens5m: 5000, tokens1h: 0, fromFlatFallback: true });
  });

  it('bills a flat excess over the nested sum at 5m instead of dropping it', () => {
    // Observed in the real corpus: the two fields disagree on a handful of rows.
    const split = splitCacheCreationTokens({
      cache_creation_input_tokens: 1000,
      cache_creation: { ephemeral_1h_input_tokens: 600, ephemeral_5m_input_tokens: 0 },
    });
    expect(split).toEqual({ tokens5m: 400, tokens1h: 600, fromFlatFallback: false });
  });

  it('keeps the nested total when it exceeds the flat field', () => {
    const split = splitCacheCreationTokens({
      cache_creation_input_tokens: 0,
      cache_creation: { ephemeral_1h_input_tokens: 546851, ephemeral_5m_input_tokens: 0 },
    });
    expect(split).toEqual({ tokens5m: 0, tokens1h: 546851, fromFlatFallback: false });
  });

  it('handles a missing usage object', () => {
    expect(splitCacheCreationTokens(undefined)).toEqual({
      tokens5m: 0,
      tokens1h: 0,
      fromFlatFallback: true,
    });
  });
});

describe('cache-write pricing by TTL', () => {
  it('prices a 1h/5m mix at the two different rates', () => {
    // Opus 5: 5m = $6.25/MTok, 1h = $10/MTok
    const usage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 400_000,
      cacheWrite1hTokens: 600_000,
    };
    // 0.4 * 6.25 + 0.6 * 10 = 2.5 + 6 = 8.5
    expect(calculateModelCost(usage, 'claude-opus-5')).toBeCloseTo(8.5, 10);
  });

  it('prices the flat-only fallback entirely at the 5m rate', () => {
    const usage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 1_000_000,
    };
    expect(calculateModelCost(usage, 'claude-opus-5')).toBeCloseTo(6.25, 10);
  });

  it('charges 1h cache writes at 2x the input rate for every model', () => {
    for (const id of [
      'claude-fable-5-1',
      'claude-fable-5',
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
      'claude-opus-4-20250514',
      'claude-3-5-haiku-20241022',
    ]) {
      const p = getModelPricingDetailed(id).pricing;
      expect(p.cacheWrite1h).toBeCloseTo(p.input * 2, 10);
    }
  });

  it('keeps Fable 5.1 cache writes at 12.50 (5m) / 20 (1h)', () => {
    const p = getModelPricingDetailed('claude-fable-5-1').pricing;
    expect(p.cacheWrite5m).toBe(12.5);
    expect(p.cacheWrite1h).toBe(20);
  });
});

describe('model id coverage', () => {
  const quiet = () => spyOn(console, 'warn').mockImplementation(() => {});

  it('prices Mythos 5.1 exactly, at the Fable 5.1 tier', () => {
    const match = getModelPricingDetailed('claude-mythos-5-1');
    expect(match.matchQuality).toBe('exact');
    expect(match.pricing).toEqual(getModelPricingDetailed('claude-fable-5-1').pricing);
  });

  it('routes an unlisted mythos variant to Mythos 5.1 by family', () => {
    const warn = quiet();
    try {
      const match = getModelPricingDetailed('claude-mythos-preview');
      expect(match.matchQuality).toBe('family');
      expect(match.modelId).toBe('claude-mythos-5-1');
    } finally {
      warn.mockRestore();
    }
  });

  it('normalizes the dated Haiku 4.5 id onto the undated entry', () => {
    const match = getModelPricingDetailed('claude-haiku-4-5-20251001');
    expect(match.matchQuality).toBe('normalized');
    expect(match.modelId).toBe('claude-haiku-4-5');
    expect(match.pricing.input).toBe(1);
  });

  it('strips a Vertex @YYYYMMDD suffix', () => {
    const match = getModelPricingDetailed('claude-sonnet-5@20260401');
    expect(match.matchQuality).toBe('normalized');
    expect(match.modelId).toBe('claude-sonnet-5');
  });

  it('strips a Bedrock vendor prefix and revision suffix', () => {
    const match = getModelPricingDetailed('us.anthropic.claude-opus-5-v1:0');
    expect(match.matchQuality).toBe('normalized');
    expect(match.modelId).toBe('claude-opus-5');
  });

  it('prices Sonnet 4.6 and Opus 4.7 / 4.6 exactly', () => {
    expect(getModelPricingDetailed('claude-sonnet-4-6')).toMatchObject({
      matchQuality: 'exact',
      pricing: { input: 3, output: 15 },
    });
    expect(getModelPricingDetailed('claude-opus-4-7')).toMatchObject({
      matchQuality: 'exact',
      pricing: { input: 5, output: 25 },
    });
    expect(getModelPricingDetailed('claude-opus-4-6')).toMatchObject({
      matchQuality: 'exact',
      pricing: { input: 5, output: 25 },
    });
  });

  it('does not let sonnet-5 shadow 3-5-sonnet', () => {
    expect(getModelPricingDetailed('claude-3-5-sonnet-20241022').pricing.input).toBe(3);
    expect(getModelPricingDetailed('claude-sonnet-5').pricing.input).toBe(2);
  });

  it('does not let haiku-4-5 shadow 3-5-haiku', () => {
    expect(getModelPricingDetailed('claude-3-5-haiku-20241022').pricing.input).toBe(0.8);
    expect(getModelPricingDetailed('claude-haiku-4-5').pricing.input).toBe(1);
  });

  it('treats an empty model id as a fallback', () => {
    const warn = quiet();
    try {
      expect(getModelPricingDetailed('').matchQuality).toBe('fallback');
    } finally {
      warn.mockRestore();
    }
  });

  it('points a bare-family rule at the current generation, not the oldest', () => {
    const warn = quiet();
    try {
      // The next unlisted minor must not inherit years-old prices.
      expect(getModelPricingDetailed('claude-opus-4-9').modelId).toBe('claude-opus-4-8');
      expect(getModelPricingDetailed('claude-opus-4-9').pricing.input).toBe(5);
      expect(getModelPricingDetailed('claude-fable-5-2').modelId).toBe('claude-fable-5-1');
      expect(getModelPricingDetailed('claude-fable-5-2').pricing.cacheRead).toBe(0.25);
      // ...while the genuine legacy ids still hit their own entries.
      expect(getModelPricingDetailed('claude-opus-4-20250514')).toMatchObject({
        matchQuality: 'exact',
        pricing: { input: 15 },
      });
      expect(getModelPricingDetailed('claude-fable-5')).toMatchObject({
        matchQuality: 'exact',
        pricing: { cacheRead: 1 },
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('warns once on a family match but stays silent on exact/normalized', () => {
    const warn = quiet();
    try {
      getModelPricingDetailed('claude-opus-5');
      getModelPricingDetailed('claude-haiku-4-5-20251001');
      expect(warn).not.toHaveBeenCalled();

      getModelPricingDetailed('claude-opus-4-3');
      getModelPricingDetailed('claude-opus-4-3');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain('claude-opus-4-3');
    } finally {
      warn.mockRestore();
    }
  });
});
