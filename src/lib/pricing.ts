// Anthropic API Pricing Configuration
// SINGLE SOURCE OF TRUTH — the CLI (cli/index.ts) and the JSONL backfill
// (src/scripts/backfill-jsonl.ts) both import from here. Never re-declare a
// price table anywhere else: two tables drift, and drifted tables silently
// mis-report cost.
//
// Last updated: 2026-09-21
// Source: https://www.anthropic.com/pricing, https://docs.claude.com/en/docs/about-claude/pricing

export const PRICING_VERSION = '2026-09';
export const PRICING_LAST_UPDATED = '2026-09-21';

// Pricing per million tokens (MTok)
// Cache pricing is normally cache_read = 0.1x base input, cache_write = 1.25x
// base input. Exceptions are called out inline (Fable 5.1 / Mythos 5.1 read at
// 0.025x). cacheWrite is always the 5-minute ephemeral rate, because Claude
// Code's JSONL only reports one undifferentiated cache_creation_input_tokens.
export interface ModelPricing {
  input: number;      // Fresh input tokens
  output: number;     // Output tokens
  cacheRead: number;  // Cache read tokens
  cacheWrite: number; // Cache write tokens (5m ephemeral)
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  // ───────────────────────────────────────────────────────────────────────
  // Current generation — NO date suffix in the model id
  // ───────────────────────────────────────────────────────────────────────
  // Claude Fable 5.1 — cacheRead is a special 0.025x, not the usual 0.1x
  'claude-fable-5-1': {
    input: 10,
    output: 50,
    cacheRead: 0.25,
    cacheWrite: 12.50,
  },
  // Claude Mythos 5.1 (Project Glasswing) — same tier as Fable 5.1
  'claude-mythos-5-1': {
    input: 10,
    output: 50,
    cacheRead: 0.25,
    cacheWrite: 12.50,
  },
  // Claude Fable 5 — same per-token price as 5.1 but standard 0.1x cache read
  'claude-fable-5': {
    input: 10,
    output: 50,
    cacheRead: 1.00,
    cacheWrite: 12.50,
  },
  'claude-opus-5': {
    input: 5,
    output: 25,
    cacheRead: 0.50,
    cacheWrite: 6.25,
  },
  'claude-opus-4-8': {
    input: 5,
    output: 25,
    cacheRead: 0.50,
    cacheWrite: 6.25,
  },
  'claude-opus-4-7': {
    input: 5,
    output: 25,
    cacheRead: 0.50,
    cacheWrite: 6.25,
  },
  'claude-opus-4-6': {
    input: 5,
    output: 25,
    cacheRead: 0.50,
    cacheWrite: 6.25,
  },
  'claude-sonnet-5': {
    input: 2,
    output: 10,
    cacheRead: 0.20,
    cacheWrite: 2.50,
  },
  'claude-sonnet-4-6': {
    input: 3,
    output: 15,
    cacheRead: 0.30,
    cacheWrite: 3.75,
  },
  'claude-haiku-4-5': {
    input: 1,
    output: 5,
    cacheRead: 0.10,
    cacheWrite: 1.25,
  },

  // ───────────────────────────────────────────────────────────────────────
  // Legacy — dated model ids
  // ───────────────────────────────────────────────────────────────────────
  'claude-opus-4-5-20251101': {
    input: 5,
    output: 25,
    cacheRead: 0.50,
    cacheWrite: 6.25,
  },
  'claude-opus-4-1-20250414': {
    input: 15,
    output: 75,
    cacheRead: 1.50,
    cacheWrite: 18.75,
  },
  'claude-opus-4-20250514': {
    input: 15,
    output: 75,
    cacheRead: 1.50,
    cacheWrite: 18.75,
  },
  'claude-3-opus-20240229': {
    input: 15,
    output: 75,
    cacheRead: 1.50,
    cacheWrite: 18.75,
  },
  // Note: Sonnet 4.5 long context (>200K input) is priced at a premium
  // ($6/$22.50/$7.50/$0.60). We use standard pricing — long context is an edge
  // case for most users and the JSONL does not distinguish the two.
  'claude-sonnet-4-5-20250929': {
    input: 3,
    output: 15,
    cacheRead: 0.30,
    cacheWrite: 3.75,
  },
  'claude-sonnet-4-20250514': {
    input: 3,
    output: 15,
    cacheRead: 0.30,
    cacheWrite: 3.75,
  },
  'claude-3-7-sonnet-20250219': {
    input: 3,
    output: 15,
    cacheRead: 0.30,
    cacheWrite: 3.75,
  },
  'claude-3-5-sonnet-20241022': {
    input: 3,
    output: 15,
    cacheRead: 0.30,
    cacheWrite: 3.75,
  },
  'claude-3-5-sonnet-20240620': {
    input: 3,
    output: 15,
    cacheRead: 0.30,
    cacheWrite: 3.75,
  },
  'claude-3-sonnet-20240229': {
    input: 3,
    output: 15,
    cacheRead: 0.30,
    cacheWrite: 3.75,
  },
  'claude-3-5-haiku-20241022': {
    input: 0.80,
    output: 4,
    cacheRead: 0.08,
    cacheWrite: 1.00,
  },
  'claude-3-haiku-20240307': {
    input: 0.25,
    output: 1.25,
    cacheRead: 0.025,
    cacheWrite: 0.3125,
  },
};

// Last-resort pricing for a model id that matches nothing at all — current
// Sonnet tier, i.e. the middle of the live lineup. Only reachable via the
// 'fallback' match quality, which is logged and stored, never silent.
export const DEFAULT_PRICING: ModelPricing = {
  input: 2,
  output: 10,
  cacheRead: 0.20,
  cacheWrite: 2.50,
};

// Token usage breakdown
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * How confidently a model id was priced.
 *   exact      — the id is a key in MODEL_PRICING
 *   normalized — matched after stripping a trailing -YYYYMMDD date suffix
 *   family     — matched a model family/version rule, not a specific id
 *   fallback   — matched nothing; DEFAULT_PRICING was used (logged)
 */
export type PricingMatchQuality = 'exact' | 'normalized' | 'family' | 'fallback';

export interface ModelPricingMatch {
  pricing: ModelPricing;
  matchQuality: PricingMatchQuality;
  /** MODEL_PRICING key that supplied the price, or the input id on fallback. */
  modelId: string;
}

// Family/version rules, most specific first — ordering is load-bearing
// ('fable-5' also matches 'fable-5-1', 'opus-4' also matches 'opus-4-5', ...).
// The trailing generic rule per family maps an unrecognised generation to the
// CURRENT tier price, not to a years-old one.
const FAMILY_RULES: ReadonlyArray<readonly [readonly string[], string]> = [
  [['fable-5-1', 'fable-5.1'], 'claude-fable-5-1'],
  [['mythos-5-1', 'mythos-5.1'], 'claude-mythos-5-1'],
  [['fable-5'], 'claude-fable-5'],
  [['fable'], 'claude-fable-5-1'],
  [['mythos'], 'claude-mythos-5-1'],

  [['opus-5', 'opus5'], 'claude-opus-5'],
  [['opus-4-8', 'opus-4.8'], 'claude-opus-4-8'],
  [['opus-4-7', 'opus-4.7'], 'claude-opus-4-7'],
  [['opus-4-6', 'opus-4.6'], 'claude-opus-4-6'],
  [['opus-4-5', 'opus-4.5'], 'claude-opus-4-5-20251101'],
  [['opus-4-1', 'opus-4.1'], 'claude-opus-4-1-20250414'],
  [['opus-4', 'opus4'], 'claude-opus-4-20250514'],
  [['opus-3', '3-opus'], 'claude-3-opus-20240229'],
  [['opus'], 'claude-opus-5'],

  [['sonnet-5', 'sonnet5'], 'claude-sonnet-5'],
  [['sonnet-4-6', 'sonnet-4.6'], 'claude-sonnet-4-6'],
  [['sonnet-4-5', 'sonnet-4.5'], 'claude-sonnet-4-5-20250929'],
  [['sonnet-4', 'sonnet4'], 'claude-sonnet-4-20250514'],
  [['sonnet-3-7', 'sonnet-3.7', '3-7-sonnet'], 'claude-3-7-sonnet-20250219'],
  [['sonnet-3-5', 'sonnet-3.5', '3-5-sonnet'], 'claude-3-5-sonnet-20241022'],
  [['sonnet-3', '3-sonnet'], 'claude-3-sonnet-20240229'],
  [['sonnet'], 'claude-sonnet-5'],

  [['haiku-4-5', 'haiku-4.5'], 'claude-haiku-4-5'],
  [['haiku-3-5', 'haiku-3.5', '3-5-haiku'], 'claude-3-5-haiku-20241022'],
  [['haiku-3', '3-haiku'], 'claude-3-haiku-20240307'],
  [['haiku'], 'claude-haiku-4-5'],
];

// One warning per distinct unmatched id per process — the backfill walks
// hundreds of thousands of rows and must not drown its own output.
const warnedUnknownModels = new Set<string>();

/** Strip a trailing -YYYYMMDD (or @YYYYMMDD) snapshot suffix. */
function stripDateSuffix(modelId: string): string {
  return modelId.replace(/[-@]\d{8}$/, '');
}

/**
 * Price a model id, reporting how the match was made so callers can record
 * estimate quality. An id that matches nothing is logged with its exact text —
 * there is no silent substitution.
 */
export function getModelPricingDetailed(modelId: string): ModelPricingMatch {
  const exact = MODEL_PRICING[modelId];
  if (exact) return { pricing: exact, matchQuality: 'exact', modelId };

  const lower = modelId.toLowerCase();

  const normalizedId = stripDateSuffix(lower);
  const normalized = MODEL_PRICING[normalizedId];
  if (normalized) {
    return { pricing: normalized, matchQuality: 'normalized', modelId: normalizedId };
  }

  for (const [needles, key] of FAMILY_RULES) {
    if (needles.some(n => lower.includes(n))) {
      const pricing = MODEL_PRICING[key];
      if (pricing) return { pricing, matchQuality: 'family', modelId: key };
    }
  }

  if (!warnedUnknownModels.has(modelId)) {
    warnedUnknownModels.add(modelId);
    console.warn(
      `[pricing] No price match for model "${modelId}" — falling back to DEFAULT_PRICING ` +
      `($${DEFAULT_PRICING.input}/$${DEFAULT_PRICING.output} per MTok). ` +
      `Add it to MODEL_PRICING in src/lib/pricing.ts (table version ${PRICING_VERSION}).`
    );
  }
  return { pricing: DEFAULT_PRICING, matchQuality: 'fallback', modelId };
}

/** Thin wrapper for callers that only need the numbers. */
export function getModelPricing(modelId: string): ModelPricing {
  return getModelPricingDetailed(modelId).pricing;
}

// Calculate cost for token usage with a specific model
export function calculateModelCost(usage: TokenUsage, modelId: string): number {
  const pricing = getModelPricing(modelId);
  return (
    (usage.inputTokens * pricing.input / 1_000_000) +
    (usage.outputTokens * pricing.output / 1_000_000) +
    (usage.cacheReadTokens * pricing.cacheRead / 1_000_000) +
    (usage.cacheWriteTokens * pricing.cacheWrite / 1_000_000)
  );
}

// Calculate total cost across multiple models
export function calculateTotalCost(usageByModel: Record<string, TokenUsage>): number {
  let total = 0;
  for (const [modelId, usage] of Object.entries(usageByModel)) {
    total += calculateModelCost(usage, modelId);
  }
  return total;
}

// Format cost for display
export function formatCost(cost: number): string {
  if (cost >= 1000) {
    return `$${(cost / 1000).toFixed(1)}K`;
  }
  if (cost >= 100) {
    return `$${Math.round(cost)}`;
  }
  if (cost >= 10) {
    return `$${cost.toFixed(1)}`;
  }
  return `$${cost.toFixed(2)}`;
}

// Get model display name (shorter, friendlier)
export function getModelDisplayName(modelId: string): string {
  const lowerModelId = modelId.toLowerCase();

  if (lowerModelId.includes('fable-5-1') || lowerModelId.includes('fable-5.1')) return 'Fable 5.1';
  if (lowerModelId.includes('mythos-5-1') || lowerModelId.includes('mythos-5.1')) return 'Mythos 5.1';
  if (lowerModelId.includes('fable')) return 'Fable 5';
  if (lowerModelId.includes('mythos')) return 'Mythos';
  if (lowerModelId.includes('opus-5')) return 'Opus 5';
  if (lowerModelId.includes('opus-4-8') || lowerModelId.includes('opus-4.8')) return 'Opus 4.8';
  if (lowerModelId.includes('opus-4-7') || lowerModelId.includes('opus-4.7')) return 'Opus 4.7';
  if (lowerModelId.includes('opus-4-6') || lowerModelId.includes('opus-4.6')) return 'Opus 4.6';
  if (lowerModelId.includes('opus-4-5') || lowerModelId.includes('opus-4.5')) return 'Opus 4.5';
  if (lowerModelId.includes('opus-4-1') || lowerModelId.includes('opus-4.1')) return 'Opus 4.1';
  if (lowerModelId.includes('opus-4')) return 'Opus 4';
  if (lowerModelId.includes('opus')) return 'Opus 3';
  if (lowerModelId.includes('sonnet-5')) return 'Sonnet 5';
  if (lowerModelId.includes('sonnet-4-6') || lowerModelId.includes('sonnet-4.6')) return 'Sonnet 4.6';
  if (lowerModelId.includes('sonnet-4-5') || lowerModelId.includes('sonnet-4.5')) return 'Sonnet 4.5';
  if (lowerModelId.includes('sonnet-4')) return 'Sonnet 4';
  if (lowerModelId.includes('3-7-sonnet') || lowerModelId.includes('sonnet-3-7')) return 'Sonnet 3.7';
  if (lowerModelId.includes('3-5-sonnet') || lowerModelId.includes('sonnet-3.5')) return 'Sonnet 3.5';
  if (lowerModelId.includes('sonnet')) return 'Sonnet 3';
  if (lowerModelId.includes('haiku-4-5') || lowerModelId.includes('haiku-4.5')) return 'Haiku 4.5';
  if (lowerModelId.includes('3-5-haiku') || lowerModelId.includes('haiku-3.5')) return 'Haiku 3.5';
  if (lowerModelId.includes('haiku')) return 'Haiku 3';

  return modelId;
}
