# Claude API Pricing Reference (Anthropic)

This is the **Anthropic API pricing** used for cost estimation in the CLI.

**Last Updated:** 2025-12-22
**Source:** https://platform.claude.com/docs/en/about-claude/pricing

## When to Update

Check pricing when:
- New Claude model is released
- Anthropic announces pricing changes
- User reports cost discrepancy

## Current Pricing (per MTok)

| Model | Input | Output | Cache Read | 5m Cache Write |
|-------|-------|--------|------------|----------------|
| **Opus 4.5** | $5.00 | $25.00 | $0.50 | $6.25 |
| **Opus 4.1** | $15.00 | $75.00 | $1.50 | $18.75 |
| **Opus 4** | $15.00 | $75.00 | $1.50 | $18.75 |
| **Opus 3** (deprecated) | $15.00 | $75.00 | $1.50 | $18.75 |
| **Sonnet 4.5** | $3.00 | $15.00 | $0.30 | $3.75 |
| **Sonnet 4** | $3.00 | $15.00 | $0.30 | $3.75 |
| **Sonnet 3.7** (deprecated) | $3.00 | $15.00 | $0.30 | $3.75 |
| **Sonnet 3.5** | $3.00 | $15.00 | $0.30 | $3.75 |
| **Haiku 4.5** | $1.00 | $5.00 | $0.10 | $1.25 |
| **Haiku 3.5** | $0.80 | $4.00 | $0.08 | $1.00 |
| **Haiku 3** | $0.25 | $1.25 | $0.03 | $0.30 |

## Cache Pricing Formula

- **Cache Read** = 0.1x base input price
- **5-minute Cache Write** = 1.25x base input price
- **1-hour Cache Write** = 2x base input price (not used by Claude Code)

## Batch Pricing (50% off)

| Model | Batch Input | Batch Output |
|-------|-------------|--------------|
| Opus 4.5 | $2.50 | $12.50 |
| Opus 4/4.1 | $7.50 | $37.50 |
| Sonnet 4/4.5 | $1.50 | $7.50 |
| Haiku 4.5 | $0.50 | $2.50 |
| Haiku 3.5 | $0.40 | $2.00 |
| Haiku 3 | $0.125 | $0.625 |

## Long Context Pricing (Sonnet 4/4.5 only)

When input > 200K tokens (1M context beta):
- Input: $6/MTok (2x normal)
- Output: $22.50/MTok (1.5x normal)

## Additional Costs

- **Web Search:** $10 per 1,000 searches
- **Web Fetch:** No additional cost (tokens only)
- **Code Execution:** $0.05/hour after 1,550 free hours/month

## Model IDs in Claude Code

```
claude-opus-4-5-20251101
claude-opus-4-1-20250429
claude-opus-4-20250514
claude-3-opus-20240229
claude-sonnet-4-5-20250929
claude-sonnet-4-20250514
claude-3-7-sonnet-20250219
claude-3-5-sonnet-20241022
claude-3-5-sonnet-20240620
claude-haiku-4-5-20251001
claude-3-5-haiku-20241022
claude-3-haiku-20240307
```

## Implementation

Pricing is implemented in `cli/index.ts`:
- `MODEL_PRICING` constant with all model prices
- `PRICING_LAST_UPDATED` timestamp
- `getModelPricing()` function with fuzzy matching
- `calculateCostCents()` for cost calculation
