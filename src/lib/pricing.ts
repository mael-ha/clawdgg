// Anthropic API Pricing Configuration
// SINGLE SOURCE OF TRUTH — the CLI (cli/index.ts) and the JSONL backfill
// (src/scripts/backfill-jsonl.ts) both import from here. Never re-declare a
// price table anywhere else: two tables drift, and drifted tables silently
// mis-report cost.
//
// Last updated: 2026-10-18
// Source: https://platform.claude.com/docs/en/about-claude/pricing
// Every number below was read off that page's model-pricing table on the date
// above. Never add a model whose price you have not read there — the family
// rule guesses and warns, which is honest; an invented number is not.

export const PRICING_VERSION = '2026-10';
export const PRICING_LAST_UPDATED = '2026-10-18';

// Pricing per million tokens (MTok)
// Cache pricing is normally cache_read = 0.1x base input, 5m cache_write =
// 1.25x and 1h cache_write = 2x base input. Exceptions are called out inline
// (Fable 5.1 / Mythos 5.1 read at 0.025x; Opus 5.5 / Sonnet 5.5 at 0.05x).
//
// The two cache-write rates are BOTH needed: Claude Code's JSONL reports the
// split in `usage.cache_creation.{ephemeral_1h,ephemeral_5m}_input_tokens`,
// and across the local transcript corpus 37% of cache-creation tokens are 1h.
// Pricing all of it at the 5m rate understates cache-write cost by ~22%.
export interface ModelPricing {
  input: number;        // Fresh input tokens
  output: number;       // Output tokens
  cacheRead: number;    // Cache read tokens
  cacheWrite5m: number; // Cache creation, 5-minute TTL (normally 1.25x input)
  cacheWrite1h: number; // Cache creation, 1-hour TTL (normally 2x input)
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
    cacheWrite5m: 12.50,
    cacheWrite1h: 20,
  },
  // Claude Mythos 5.1 (Project Glasswing) — same tier as Fable 5.1
  'claude-mythos-5-1': {
    input: 10,
    output: 50,
    cacheRead: 0.25,
    cacheWrite5m: 12.50,
    cacheWrite1h: 20,
  },
  // Claude Fable 5 — same per-token price as 5.1 but standard 0.1x cache read
  'claude-fable-5': {
    input: 10,
    output: 50,
    cacheRead: 1.00,
    cacheWrite5m: 12.50,
    cacheWrite1h: 20,
  },
  // Claude Opus 5.5 — the current Opus, cheaper than Opus 5. cacheRead is a
  // special 0.05x, not the usual 0.1x.
  'claude-opus-5-5': {
    input: 4,
    output: 20,
    cacheRead: 0.20,
    cacheWrite5m: 5,
    cacheWrite1h: 8,
  },
  'claude-opus-5': {
    input: 5,
    output: 25,
    cacheRead: 0.50,
    cacheWrite5m: 6.25,
    cacheWrite1h: 10,
  },
  'claude-opus-4-8': {
    input: 5,
    output: 25,
    cacheRead: 0.50,
    cacheWrite5m: 6.25,
    cacheWrite1h: 10,
  },
  'claude-opus-4-7': {
    input: 5,
    output: 25,
    cacheRead: 0.50,
    cacheWrite5m: 6.25,
    cacheWrite1h: 10,
  },
  'claude-opus-4-6': {
    input: 5,
    output: 25,
    cacheRead: 0.50,
    cacheWrite5m: 6.25,
    cacheWrite1h: 10,
  },
  // Claude Sonnet 5.5 — same per-token price as Sonnet 5 but cacheRead is a
  // special 0.05x (Sonnet 5 reads at the usual 0.1x).
  'claude-sonnet-5-5': {
    input: 2,
    output: 10,
    cacheRead: 0.10,
    cacheWrite5m: 2.50,
    cacheWrite1h: 4,
  },
  'claude-sonnet-5': {
    input: 2,
    output: 10,
    cacheRead: 0.20,
    cacheWrite5m: 2.50,
    cacheWrite1h: 4,
  },
  'claude-sonnet-4-6': {
    input: 3,
    output: 15,
    cacheRead: 0.30,
    cacheWrite5m: 3.75,
    cacheWrite1h: 6,
  },
  // Claude Haiku 5.5 is priced by PROMPT LENGTH, not by a long-context flag.
  // This is the standard (<=100K) tier; MODEL_PRICING_LONG_PROMPT holds the
  // other one and getModelPricingDetailed picks between them.
  'claude-haiku-5-5': {
    input: 0.10,
    output: 0.50,
    cacheRead: 0.01,
    cacheWrite5m: 0.125,
    cacheWrite1h: 0.20,
  },
  'claude-haiku-4-5': {
    input: 1,
    output: 5,
    cacheRead: 0.10,
    cacheWrite5m: 1.25,
    cacheWrite1h: 2,
  },

  // ───────────────────────────────────────────────────────────────────────
  // Legacy — dated model ids
  // ───────────────────────────────────────────────────────────────────────
  'claude-opus-4-5-20251101': {
    input: 5,
    output: 25,
    cacheRead: 0.50,
    cacheWrite5m: 6.25,
    cacheWrite1h: 10,
  },
  'claude-opus-4-1-20250414': {
    input: 15,
    output: 75,
    cacheRead: 1.50,
    cacheWrite5m: 18.75,
    cacheWrite1h: 30,
  },
  'claude-opus-4-20250514': {
    input: 15,
    output: 75,
    cacheRead: 1.50,
    cacheWrite5m: 18.75,
    cacheWrite1h: 30,
  },
  'claude-3-opus-20240229': {
    input: 15,
    output: 75,
    cacheRead: 1.50,
    cacheWrite5m: 18.75,
    cacheWrite1h: 30,
  },
  // Note: Sonnet 4.5 long context (>200K input) is priced at a premium
  // ($6/$22.50/$7.50/$0.60). We use standard pricing — long context is an edge
  // case for most users and the JSONL does not distinguish the two.
  'claude-sonnet-4-5-20250929': {
    input: 3,
    output: 15,
    cacheRead: 0.30,
    cacheWrite5m: 3.75,
    cacheWrite1h: 6,
  },
  'claude-sonnet-4-20250514': {
    input: 3,
    output: 15,
    cacheRead: 0.30,
    cacheWrite5m: 3.75,
    cacheWrite1h: 6,
  },
  'claude-3-7-sonnet-20250219': {
    input: 3,
    output: 15,
    cacheRead: 0.30,
    cacheWrite5m: 3.75,
    cacheWrite1h: 6,
  },
  'claude-3-5-sonnet-20241022': {
    input: 3,
    output: 15,
    cacheRead: 0.30,
    cacheWrite5m: 3.75,
    cacheWrite1h: 6,
  },
  'claude-3-5-sonnet-20240620': {
    input: 3,
    output: 15,
    cacheRead: 0.30,
    cacheWrite5m: 3.75,
    cacheWrite1h: 6,
  },
  'claude-3-sonnet-20240229': {
    input: 3,
    output: 15,
    cacheRead: 0.30,
    cacheWrite5m: 3.75,
    cacheWrite1h: 6,
  },
  'claude-3-5-haiku-20241022': {
    input: 0.80,
    output: 4,
    cacheRead: 0.08,
    cacheWrite5m: 1.00,
    cacheWrite1h: 1.6,
  },
  'claude-3-haiku-20240307': {
    input: 0.25,
    output: 1.25,
    cacheRead: 0.025,
    cacheWrite5m: 0.3125,
    cacheWrite1h: 0.5,
  },
};

// ───────────────────────────────────────────────────────────────────────────
// Price VARIANTS of a model already in MODEL_PRICING
// ───────────────────────────────────────────────────────────────────────────

/**
 * Fast mode (`speed=fast`) buys faster output at a premium, for the Opus
 * family only. The page lists input and output; "prompt caching multipliers
 * apply on top of fast mode pricing", so the cache rates below are the normal
 * multiples of the fast INPUT price:
 *   Opus 5.5  $8  in -> read 0.05x = $0.40, 5m 1.25x = $10, 1h 2x = $16
 *   Opus 5    $10 in -> read 0.1x  = $1.00, 5m 1.25x = $12.50, 1h 2x = $20
 *   Opus 4.8  same as Opus 5
 * Read off the pricing page's "Fast mode pricing" table on 2026-10-18.
 */
export const MODEL_PRICING_FAST: Record<string, ModelPricing> = {
  'claude-opus-5-5': {
    input: 8,
    output: 40,
    cacheRead: 0.40,
    cacheWrite5m: 10,
    cacheWrite1h: 16,
  },
  'claude-opus-5': {
    input: 10,
    output: 50,
    cacheRead: 1.00,
    cacheWrite5m: 12.50,
    cacheWrite1h: 20,
  },
  'claude-opus-4-8': {
    input: 10,
    output: 50,
    cacheRead: 1.00,
    cacheWrite5m: 12.50,
    cacheWrite1h: 20,
  },
};

/**
 * Haiku 5.5's over-100K tier, verbatim from the pricing page (2026-10-18):
 * input $0.50, 5m writes $0.625, 1h writes $1, cache hits $0.05, output $2.50.
 *
 * The threshold, also verbatim: "A request's prompt length counts all of its
 * input tokens, including cache reads and cache writes. Each request is priced
 * on its own." So it is decidable from a single request's usage block — which
 * is exactly what the JSONL import has — and NOT from an aggregate. Callers
 * that only have summed tokens (the ClickHouse cache-savings query) cannot
 * apply it and get the standard tier.
 */
export const HAIKU_LONG_PROMPT_TOKENS = 100_000;

export const MODEL_PRICING_LONG_PROMPT: Record<string, ModelPricing> = {
  'claude-haiku-5-5': {
    input: 0.50,
    output: 2.50,
    cacheRead: 0.05,
    cacheWrite5m: 0.625,
    cacheWrite1h: 1,
  },
};

// Last-resort pricing for a model id that matches nothing at all — the current
// Sonnet tier (Sonnet 5.5), i.e. the middle of the live lineup. Only reachable
// via the 'fallback' match quality, which is logged and stored, never silent.
// Tracks whichever model `['sonnet']` points at: an unmatched id is most often
// a model newer than this table, and the newest models read cache at 0.05x.
export const DEFAULT_PRICING: ModelPricing = {
  input: 2,
  output: 10,
  cacheRead: 0.10,
  cacheWrite5m: 2.50,
  cacheWrite1h: 4,
};

// Token usage breakdown
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Cache-creation tokens at the 5-minute rate. */
  cacheWriteTokens: number;
  /** Cache-creation tokens at the 1-hour rate. Omit when the split is unknown. */
  cacheWrite1hTokens?: number;
}

/** Cache-creation tokens split by TTL, as billed. */
export interface CacheCreationSplit {
  tokens5m: number;
  tokens1h: number;
  /**
   * True when the JSONL carried no nested `cache_creation` breakdown and the
   * flat total was billed entirely at the 5m rate. Callers that care about
   * estimate quality should count these.
   */
  fromFlatFallback: boolean;
}

/**
 * Split a Claude Code JSONL `message.usage` into 5m / 1h cache-creation tokens.
 *
 * `usage.cache_creation.{ephemeral_1h,ephemeral_5m}_input_tokens` is the
 * authoritative breakdown and is present on 100% of the local corpus. The flat
 * `cache_creation_input_tokens` is normally their sum, but the two disagree on
 * a handful of rows in both directions — so any flat excess over the nested sum
 * is billed at the 5m rate rather than dropped. Older transcripts that predate
 * the nested field fall back to billing the flat total at 5m.
 */
export function splitCacheCreationTokens(usage: unknown): CacheCreationSplit {
  const u = (usage ?? {}) as Record<string, unknown>;
  const flat = Number(u.cache_creation_input_tokens ?? 0) || 0;
  const nested = u.cache_creation;

  if (!nested || typeof nested !== 'object') {
    return { tokens5m: flat, tokens1h: 0, fromFlatFallback: true };
  }

  const n = nested as Record<string, unknown>;
  const tokens1h = Number(n.ephemeral_1h_input_tokens ?? 0) || 0;
  const tokens5m = Number(n.ephemeral_5m_input_tokens ?? 0) || 0;
  const unexplained = Math.max(0, flat - (tokens1h + tokens5m));

  return { tokens5m: tokens5m + unexplained, tokens1h, fromFlatFallback: false };
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
//
// A bare-family rule points at the CURRENT generation of that family, so the
// next unlisted minor release guesses right: 'claude-opus-4-9' should price
// like Opus 4.8 ($5/$25), not like Opus 4 ($15/$75). The genuine legacy ids
// still land on their own entries via the exact/normalized steps, which run
// first. Same for the trailing generic rule per family.
const FAMILY_RULES: ReadonlyArray<readonly [readonly string[], string]> = [
  [['fable-5-1', 'fable-5.1'], 'claude-fable-5-1'],
  [['mythos-5-1', 'mythos-5.1'], 'claude-mythos-5-1'],
  [['fable-5'], 'claude-fable-5-1'],
  [['fable'], 'claude-fable-5-1'],
  [['mythos'], 'claude-mythos-5-1'],

  [['opus-5-5', 'opus-5.5'], 'claude-opus-5-5'],
  [['opus-5', 'opus5'], 'claude-opus-5'],
  [['opus-4-8', 'opus-4.8'], 'claude-opus-4-8'],
  [['opus-4-7', 'opus-4.7'], 'claude-opus-4-7'],
  [['opus-4-6', 'opus-4.6'], 'claude-opus-4-6'],
  [['opus-4-5', 'opus-4.5'], 'claude-opus-4-5-20251101'],
  [['opus-4-1', 'opus-4.1'], 'claude-opus-4-1-20250414'],
  [['opus-4', 'opus4'], 'claude-opus-4-8'],
  [['opus-3', '3-opus'], 'claude-3-opus-20240229'],
  [['opus'], 'claude-opus-5-5'],

  [['sonnet-5-5', 'sonnet-5.5'], 'claude-sonnet-5-5'],
  [['sonnet-5', 'sonnet5'], 'claude-sonnet-5'],
  [['sonnet-4-6', 'sonnet-4.6'], 'claude-sonnet-4-6'],
  [['sonnet-4-5', 'sonnet-4.5'], 'claude-sonnet-4-5-20250929'],
  [['sonnet-4', 'sonnet4'], 'claude-sonnet-4-6'],
  [['sonnet-3-7', 'sonnet-3.7', '3-7-sonnet'], 'claude-3-7-sonnet-20250219'],
  [['sonnet-3-5', 'sonnet-3.5', '3-5-sonnet'], 'claude-3-5-sonnet-20241022'],
  [['sonnet-3', '3-sonnet'], 'claude-3-sonnet-20240229'],
  [['sonnet'], 'claude-sonnet-5-5'],

  [['haiku-5-5', 'haiku-5.5'], 'claude-haiku-5-5'],
  [['haiku-4-5', 'haiku-4.5'], 'claude-haiku-4-5'],
  [['haiku-3-5', 'haiku-3.5', '3-5-haiku'], 'claude-3-5-haiku-20241022'],
  [['haiku-3', '3-haiku'], 'claude-3-haiku-20240307'],
  [['haiku'], 'claude-haiku-5-5'],
];

// One warning per distinct model id per process — the backfill walks hundreds
// of thousands of rows and must not drown its own output.
const warnedModels = new Set<string>();

function warnOncePerModel(modelId: string, message: string): void {
  if (warnedModels.has(modelId)) return;
  warnedModels.add(modelId);
  console.warn(message);
}

/**
 * Strip everything that decorates a model id without changing WHICH model it
 * is: case, a cloud provider's region/vendor prefix, a `-v1:0` revision
 * suffix, and a bracketed context variant. Claude Code reports the 1M-context
 * beta as `claude-sonnet-4-5-20250929[1m]`, which is the same model at the
 * same per-token price — left alone it misses the table, lands on a family
 * rule, and warns about a model we have priced exactly.
 *
 * The date snapshot is deliberately KEPT here: `claude-sonnet-4-5-20250929` is
 * itself a price-table key, and dropping the date first would lose it.
 */
export function stripModelDecorations(modelId: string): string {
  return modelId
    .toLowerCase()
    .replace(/^(?:us|eu|apac|global)\./, '')
    .replace(/^anthropic\./, '')
    .replace(/\[[^\]]*\]$/, '')
    .replace(/-v\d+:\d+$/, '');
}

/**
 * Reduce a model id to its first-party bare form: decorations stripped, plus
 * any `-YYYYMMDD` / `@YYYYMMDD` snapshot suffix. So both
 * `us.anthropic.claude-sonnet-5-v1:0` (Bedrock) and `claude-sonnet-5@20260401`
 * (Vertex) normalize onto the `claude-sonnet-5` table key.
 */
function normalizeModelId(modelId: string): string {
  return stripModelDecorations(modelId).replace(/[-@]\d{8}$/, '');
}

/**
 * Which MODEL_PRICING key a model id resolves to, and how confidently.
 * Resolution only — no warning, no variant selection — so that
 * getModelDisplayName can label a model by the very key its price came from
 * without logging anything.
 */
function resolveModelKey(modelId: string): { key: string; matchQuality: PricingMatchQuality } | null {
  if (MODEL_PRICING[modelId]) return { key: modelId, matchQuality: 'exact' };

  // Decorations only (keeps the date snapshot), then the fully bare form.
  const strippedId = stripModelDecorations(modelId);
  if (MODEL_PRICING[strippedId]) return { key: strippedId, matchQuality: 'normalized' };

  const normalizedId = normalizeModelId(modelId);
  if (MODEL_PRICING[normalizedId]) return { key: normalizedId, matchQuality: 'normalized' };

  for (const [needles, key] of FAMILY_RULES) {
    if (needles.some(n => strippedId.includes(n)) && MODEL_PRICING[key]) {
      return { key, matchQuality: 'family' };
    }
  }

  return null;
}

/**
 * What the request was, for the price variants that depend on it rather than on
 * the model id alone. Optional everywhere: a caller with neither piece of
 * information gets the standard tier, which is what the table lists.
 */
export interface PricingContext {
  /** `speed` as Claude Code reports it — 'fast' selects Opus fast-mode rates. */
  speed?: string;
  /**
   * The request's prompt length: input + cache read + cache creation tokens,
   * per the pricing page's definition. Selects Haiku 5.5's over-100K tier.
   * Only meaningful PER REQUEST — never pass a sum over many requests.
   */
  promptTokens?: number;
}

/** The variant price for a resolved key, or undefined for the standard tier. */
function variantPricing(key: string, ctx?: PricingContext): ModelPricing | undefined {
  if (ctx?.speed === 'fast' && MODEL_PRICING_FAST[key]) {
    return MODEL_PRICING_FAST[key];
  }
  if (
    ctx?.promptTokens !== undefined &&
    ctx.promptTokens > HAIKU_LONG_PROMPT_TOKENS &&
    MODEL_PRICING_LONG_PROMPT[key]
  ) {
    return MODEL_PRICING_LONG_PROMPT[key];
  }
  return undefined;
}

/**
 * Price a model id, reporting how the match was made so callers can record
 * estimate quality. An id that matches nothing is logged with its exact text —
 * there is no silent substitution.
 */
export function getModelPricingDetailed(modelId: string, ctx?: PricingContext): ModelPricingMatch {
  const resolved = resolveModelKey(modelId);

  if (!resolved) {
    warnOncePerModel(
      modelId,
      `[pricing] No price match for model "${modelId}" — falling back to DEFAULT_PRICING ` +
      `($${DEFAULT_PRICING.input}/$${DEFAULT_PRICING.output} per MTok). ` +
      `Add it to MODEL_PRICING in src/lib/pricing.ts (table version ${PRICING_VERSION}).`
    );
    return { pricing: DEFAULT_PRICING, matchQuality: 'fallback', modelId };
  }

  const { key, matchQuality } = resolved;
  const pricing = variantPricing(key, ctx) ?? MODEL_PRICING[key]!;

  if (matchQuality === 'family') {
    // A family match is a guess — the id is not in the table. Surface it so a
    // new minor release gets real prices instead of quietly inheriting a
    // sibling's. Exact and normalized matches stay silent.
    warnOncePerModel(
      modelId,
      `[pricing] Model "${modelId}" is not in the price table — priced from the ` +
      `"${key}" family rule ($${pricing.input}/$${pricing.output} per MTok). ` +
      `Add it to MODEL_PRICING in src/lib/pricing.ts (table version ${PRICING_VERSION}).`
    );
  }

  return { pricing, matchQuality, modelId: key };
}

/** Thin wrapper for callers that only need the numbers. */
export function getModelPricing(modelId: string, ctx?: PricingContext): ModelPricing {
  return getModelPricingDetailed(modelId, ctx).pricing;
}

// Calculate cost for token usage with a specific model
export function calculateModelCost(usage: TokenUsage, modelId: string, ctx?: PricingContext): number {
  const pricing = getModelPricing(modelId, ctx);
  return (
    (usage.inputTokens * pricing.input / 1_000_000) +
    (usage.outputTokens * pricing.output / 1_000_000) +
    (usage.cacheReadTokens * pricing.cacheRead / 1_000_000) +
    (usage.cacheWriteTokens * pricing.cacheWrite5m / 1_000_000) +
    ((usage.cacheWrite1hTokens ?? 0) * pricing.cacheWrite1h / 1_000_000)
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

/**
 * The friendly label for every price-table key, so a model is never DISPLAYED
 * as one tier and PRICED as another.
 *
 * That is exactly what the old hand-rolled if-chain did on bare family ids: a
 * `claude-opus` with no version priced from the `['opus']` family rule (Opus
 * 5.5, $4/$20) and displayed as "Opus 3"; `claude-sonnet` priced as Sonnet 5.5
 * and displayed as "Sonnet 3"; `claude-opus-4` priced as Opus 4.8 and
 * displayed as "Opus 4". Deriving the label from the resolved key instead
 * makes the two agree by construction — the label now names the tier whose
 * numbers were actually used, which is the only label that can be reconciled
 * against a cost.
 */
const MODEL_DISPLAY_NAMES: Record<string, string> = {
  'claude-fable-5-1': 'Fable 5.1',
  'claude-mythos-5-1': 'Mythos 5.1',
  'claude-fable-5': 'Fable 5',
  'claude-opus-5-5': 'Opus 5.5',
  'claude-opus-5': 'Opus 5',
  'claude-opus-4-8': 'Opus 4.8',
  'claude-opus-4-7': 'Opus 4.7',
  'claude-opus-4-6': 'Opus 4.6',
  'claude-opus-4-5-20251101': 'Opus 4.5',
  'claude-opus-4-1-20250414': 'Opus 4.1',
  'claude-opus-4-20250514': 'Opus 4',
  'claude-3-opus-20240229': 'Opus 3',
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-sonnet-5': 'Sonnet 5',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-sonnet-4-5-20250929': 'Sonnet 4.5',
  'claude-sonnet-4-20250514': 'Sonnet 4',
  'claude-3-7-sonnet-20250219': 'Sonnet 3.7',
  'claude-3-5-sonnet-20241022': 'Sonnet 3.5',
  'claude-3-5-sonnet-20240620': 'Sonnet 3.5',
  'claude-3-sonnet-20240229': 'Sonnet 3',
  'claude-haiku-5-5': 'Haiku 5.5',
  'claude-haiku-4-5': 'Haiku 4.5',
  'claude-3-5-haiku-20241022': 'Haiku 3.5',
  'claude-3-haiku-20240307': 'Haiku 3',
};

/**
 * Get model display name (shorter, friendlier). Resolved through the same path
 * as the price, so the label always names the tier that was charged. An id
 * that resolves to nothing is shown verbatim rather than guessed at.
 */
export function getModelDisplayName(modelId: string): string {
  const resolved = resolveModelKey(modelId);
  if (!resolved) return modelId;
  return MODEL_DISPLAY_NAMES[resolved.key] ?? resolved.key;
}
