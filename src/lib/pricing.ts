// Anthropic API Pricing Configuration
// Last updated: December 2025
// Source: https://www.anthropic.com/pricing, https://docs.claude.com/en/docs/about-claude/pricing

export const PRICING_VERSION = '2025-12';
export const PRICING_LAST_UPDATED = '2025-12-14';

// Pricing per million tokens (MTok)
// Cache pricing: cache_read = 0.1x base input, cache_write = 1.25x base input
export interface ModelPricing {
  input: number;      // Fresh input tokens
  output: number;     // Output tokens
  cacheRead: number;  // Cache read tokens (0.1x input)
  cacheWrite: number; // Cache write tokens (1.25x input)
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Claude Opus 4.5 - CHEAPER than Opus 4!
  'claude-opus-4-5-20251101': {
    input: 5,
    output: 25,
    cacheRead: 0.5,      // 0.1x input
    cacheWrite: 6.25,    // 1.25x input
  },
  // Claude Opus 4
  'claude-opus-4-20250514': {
    input: 15,
    output: 75,
    cacheRead: 1.5,      // 0.1x input
    cacheWrite: 18.75,   // 1.25x input
  },
  // Claude Opus 4.1
  'claude-opus-4-1-20250414': {
    input: 15,
    output: 75,
    cacheRead: 1.5,
    cacheWrite: 18.75,
  },
  // Claude Sonnet 4.5
  // Note: Long context (>200K input) has premium pricing: $6/$22.50/$7.50/$0.60
  // We use standard pricing here; long context is edge case for most users
  'claude-sonnet-4-5-20250514': {
    input: 3,
    output: 15,
    cacheRead: 0.30,
    cacheWrite: 3.75,
  },
  // Claude Sonnet 4
  'claude-sonnet-4-20250514': {
    input: 3,
    output: 15,
    cacheRead: 0.30,
    cacheWrite: 3.75,
  },
  // Claude Sonnet 3.7
  'claude-sonnet-3-7-20250219': {
    input: 3,
    output: 15,
    cacheRead: 0.30,
    cacheWrite: 3.75,
  },
  // Claude 3.5 Sonnet
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
  // Claude Haiku 4.5
  'claude-haiku-4-5-20251101': {
    input: 1,
    output: 5,
    cacheRead: 0.10,
    cacheWrite: 1.25,
  },
  // Claude 3.5 Haiku
  'claude-3-5-haiku-20241022': {
    input: 0.80,
    output: 4,
    cacheRead: 0.08,
    cacheWrite: 1.00,
  },
  // Claude 3 Opus
  'claude-3-opus-20240229': {
    input: 15,
    output: 75,
    cacheRead: 1.5,
    cacheWrite: 18.75,
  },
  // Claude 3 Sonnet
  'claude-3-sonnet-20240229': {
    input: 3,
    output: 15,
    cacheRead: 0.30,
    cacheWrite: 3.75,
  },
  // Claude 3 Haiku
  'claude-3-haiku-20240307': {
    input: 0.25,
    output: 1.25,
    cacheRead: 0.025,
    cacheWrite: 0.3125,
  },
};

// Default pricing for unknown models (use Sonnet pricing as safe middle ground)
export const DEFAULT_PRICING: ModelPricing = {
  input: 3,
  output: 15,
  cacheRead: 0.30,
  cacheWrite: 3.75,
};

// Token usage breakdown
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

// Get pricing for a model (with fuzzy matching for model ID variations)
export function getModelPricing(modelId: string): ModelPricing {
  // Direct match
  if (MODEL_PRICING[modelId]) {
    return MODEL_PRICING[modelId];
  }

  // Fuzzy match - try to find a matching model
  const lowerModelId = modelId.toLowerCase();

  if (lowerModelId.includes('opus-4-5') || lowerModelId.includes('opus-4.5')) {
    return MODEL_PRICING['claude-opus-4-5-20251101'];
  }
  if (lowerModelId.includes('opus-4-1') || lowerModelId.includes('opus-4.1')) {
    return MODEL_PRICING['claude-opus-4-1-20250414'];
  }
  if (lowerModelId.includes('opus-4') || lowerModelId.includes('opus4')) {
    return MODEL_PRICING['claude-opus-4-20250514'];
  }
  if (lowerModelId.includes('opus')) {
    return MODEL_PRICING['claude-3-opus-20240229'];
  }
  if (lowerModelId.includes('sonnet-4-5') || lowerModelId.includes('sonnet-4.5')) {
    return MODEL_PRICING['claude-sonnet-4-5-20250514'];
  }
  if (lowerModelId.includes('sonnet-4') || lowerModelId.includes('sonnet4')) {
    return MODEL_PRICING['claude-sonnet-4-20250514'];
  }
  if (lowerModelId.includes('3-5-sonnet') || lowerModelId.includes('3.5-sonnet')) {
    return MODEL_PRICING['claude-3-5-sonnet-20241022'];
  }
  if (lowerModelId.includes('sonnet')) {
    return MODEL_PRICING['claude-3-sonnet-20240229'];
  }
  if (lowerModelId.includes('3-5-haiku') || lowerModelId.includes('3.5-haiku')) {
    return MODEL_PRICING['claude-3-5-haiku-20241022'];
  }
  if (lowerModelId.includes('haiku')) {
    return MODEL_PRICING['claude-3-haiku-20240307'];
  }

  return DEFAULT_PRICING;
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

  if (lowerModelId.includes('opus-4-5') || lowerModelId.includes('opus-4.5')) return 'Opus 4.5';
  if (lowerModelId.includes('opus-4-1') || lowerModelId.includes('opus-4.1')) return 'Opus 4.1';
  if (lowerModelId.includes('opus-4')) return 'Opus 4';
  if (lowerModelId.includes('opus')) return 'Opus 3';
  if (lowerModelId.includes('sonnet-4-5') || lowerModelId.includes('sonnet-4.5')) return 'Sonnet 4.5';
  if (lowerModelId.includes('sonnet-4')) return 'Sonnet 4';
  if (lowerModelId.includes('3-5-sonnet') || lowerModelId.includes('3.5-sonnet')) return 'Sonnet 3.5';
  if (lowerModelId.includes('sonnet')) return 'Sonnet 3';
  if (lowerModelId.includes('3-5-haiku') || lowerModelId.includes('3.5-haiku')) return 'Haiku 3.5';
  if (lowerModelId.includes('haiku')) return 'Haiku 3';

  return modelId;
}
