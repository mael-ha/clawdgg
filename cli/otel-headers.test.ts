import { describe, expect, it } from 'bun:test';
import {
  deviceTokenId,
  isDeviceToken,
  isLegacySignedToken,
  isOurStaticAuthHeader,
  isWellFormedToken,
  MISSING_TOKEN_MESSAGE,
  otelHeadersLine,
  REVOKED_TOKEN_MESSAGE,
} from './otel-headers';

// The pre-2.0 token was sign(JSON.stringify({userId, iat, gen})) = `<payload>.<hex>`.
const REAL_SHAPE =
  '{"userId":"github_1","iat":1790000000,"gen":4}.' + 'a'.repeat(64);

// A per-device token: cgt_<32 hex>.<64 hex>.
const DEVICE_TOKEN = `cgt_${'0123456789abcdef'.repeat(2)}.${'f'.repeat(64)}`;

describe('isWellFormedToken', () => {
  it('accepts both formats', () => {
    expect(isWellFormedToken(REAL_SHAPE)).toBe(true);
    expect(isWellFormedToken(DEVICE_TOKEN)).toBe(true);
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

describe('isDeviceToken', () => {
  it('tells the two formats apart — `doctor` nudges legacy holders to re-login', () => {
    expect(isDeviceToken(DEVICE_TOKEN)).toBe(true);
    expect(isDeviceToken(REAL_SHAPE)).toBe(false);
    expect(isLegacySignedToken(REAL_SHAPE)).toBe(true);
    expect(isLegacySignedToken(DEVICE_TOKEN)).toBe(false);
  });

  it('rejects a truncated device token', () => {
    expect(isDeviceToken(`cgt_${'a'.repeat(32)}.${'f'.repeat(63)}`)).toBe(false);
    expect(isDeviceToken(`cgt_${'a'.repeat(31)}.${'f'.repeat(64)}`)).toBe(false);
    expect(isDeviceToken('cgt_')).toBe(false);
  });

  it('extracts the device id, which is how `devices` marks this machine', () => {
    expect(deviceTokenId(DEVICE_TOKEN)).toBe('0123456789abcdef'.repeat(2));
    expect(deviceTokenId(REAL_SHAPE)).toBeNull();
    expect(deviceTokenId(undefined)).toBeNull();
  });
});

describe('isOurStaticAuthHeader', () => {
  it('recognises the static bearer the pre-2.0 CLI wrote', () => {
    expect(isOurStaticAuthHeader(`Authorization=Bearer ${REAL_SHAPE}`)).toBe(true);
    // That is how it was actually written: percent-encoded space.
    expect(isOurStaticAuthHeader(`Authorization=Bearer%20${REAL_SHAPE}`)).toBe(true);
    expect(isOurStaticAuthHeader(`authorization=Bearer ${DEVICE_TOKEN}`)).toBe(true);
    expect(isOurStaticAuthHeader(`x-tenant=acme,Authorization=Bearer ${DEVICE_TOKEN}`)).toBe(true);
  });

  it('refuses to claim a header that is not ours', () => {
    // Deleting one of these would break someone else's collector; "restoring"
    // it later would point our Authorization at a third party.
    expect(isOurStaticAuthHeader('Authorization=Bearer sk-ant-not-our-token')).toBe(false);
    expect(isOurStaticAuthHeader('x-honeycomb-team=abc123')).toBe(false);
    expect(isOurStaticAuthHeader('Authorization=Basic dXNlcjpwYXNz')).toBe(false);
    expect(isOurStaticAuthHeader('')).toBe(false);
    expect(isOurStaticAuthHeader(undefined)).toBe(false);
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

  it('says what to do when there is no token, or when it was revoked', () => {
    expect(MISSING_TOKEN_MESSAGE).toContain('clawdgg login');
    expect(REVOKED_TOKEN_MESSAGE).toContain('clawdgg login');
    expect(REVOKED_TOKEN_MESSAGE).toContain('revoked');
  });
});
