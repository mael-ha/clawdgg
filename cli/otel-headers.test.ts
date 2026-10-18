import { describe, expect, it } from 'bun:test';
import { isWellFormedToken, MISSING_TOKEN_MESSAGE, otelHeadersLine } from './otel-headers';

// A real token is sign(JSON.stringify({userId, iat, gen})) = `<payload>.<hex>`.
const REAL_SHAPE =
  '{"userId":"github_1","iat":1790000000,"gen":4}.' + 'a'.repeat(64);

describe('isWellFormedToken', () => {
  it('accepts a signed token', () => {
    expect(isWellFormedToken(REAL_SHAPE)).toBe(true);
  });

  it('rejects everything that would make the exporter 401 in silence', () => {
    expect(isWellFormedToken(undefined)).toBe(false);
    expect(isWellFormedToken('')).toBe(false);
    expect(isWellFormedToken('no-dot-at-all')).toBe(false);
    expect(isWellFormedToken('payload.')).toBe(false);
    expect(isWellFormedToken('.' + 'a'.repeat(64))).toBe(false);
    expect(isWellFormedToken('payload.tooshort')).toBe(false);
    expect(isWellFormedToken('payload.' + 'Z'.repeat(64))).toBe(false);
    expect(isWellFormedToken(12345)).toBe(false);
  });
});

describe('otelHeadersLine', () => {
  it('prints exactly the flat JSON object the docs require', () => {
    const line = otelHeadersLine(REAL_SHAPE);

    expect(line.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(line);
    expect(Object.keys(parsed)).toEqual(['Authorization']);
    expect(parsed.Authorization).toBe(`Bearer ${REAL_SHAPE}`);
    // Every value must be a string — Claude Code rejects anything else.
    for (const value of Object.values(parsed)) expect(typeof value).toBe('string');
  });

  it('says what to do when there is no token', () => {
    expect(MISSING_TOKEN_MESSAGE).toContain('clawdgg login');
  });
});
