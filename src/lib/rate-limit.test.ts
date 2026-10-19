/**
 * Whose budget is this request spending?
 *
 * The answer used to be "whichever address the client put first in
 * X-Forwarded-For", which is a header anyone can send. Caddy APPENDS the peer
 * it is talking to, so the first entry is the claim and the last one is the
 * measurement — and a limiter keyed on the claim is not a weaker limit, it is
 * no limit: one fabricated hop per request and every request is a new key.
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { clientIp, createRateLimit, rateLimitStore } from './rate-limit';

beforeEach(() => {
  rateLimitStore.clear();
});

/** One app per test, so a budget cannot leak between them. */
function limited(max: number, scope = 'test') {
  const app = new Hono();
  app.use('*', createRateLimit({ scope, max }));
  app.get('/', (c) => c.text('ok'));
  return (headers: Record<string, string> = {}) =>
    app.request('http://localhost/', { headers });
}

function ipApp() {
  const app = new Hono();
  app.get('/', (c) => c.text(clientIp(c)));
  return async (headers: Record<string, string> = {}) =>
    (await app.request('http://localhost/', { headers })).text();
}

describe('clientIp', () => {
  const read = ipApp();

  it('takes the LAST X-Forwarded-For hop — the one our proxy wrote', async () => {
    expect(await read({ 'x-forwarded-for': '203.0.113.7' })).toBe('203.0.113.7');
    // The client claimed 1.1.1.1; Caddy appended what it actually saw.
    expect(await read({ 'x-forwarded-for': '1.1.1.1, 203.0.113.7' })).toBe('203.0.113.7');
    expect(await read({ 'x-forwarded-for': '1.1.1.1,  2.2.2.2 , 203.0.113.7 ' })).toBe(
      '203.0.113.7'
    );
  });

  it('falls back to X-Real-IP, which Caddy writes as one address', async () => {
    expect(await read({ 'x-real-ip': '198.51.100.4' })).toBe('198.51.100.4');
  });

  it('is a single bucket when there is nothing to read', async () => {
    expect(await read()).toBe('unknown');
    expect(await read({ 'x-forwarded-for': '' })).toBe('unknown');
    expect(await read({ 'x-forwarded-for': ' , ' })).toBe('unknown');
  });
});

describe('createRateLimit', () => {
  it('counts a window and then refuses', async () => {
    const request = limited(3);
    const headers = { 'x-forwarded-for': '203.0.113.7' };

    for (let i = 1; i <= 3; i++) {
      const response = await request(headers);
      expect(response.status).toBe(200);
      expect(response.headers.get('X-RateLimit-Remaining')).toBe(String(3 - i));
    }

    const refused = await request(headers);
    expect(refused.status).toBe(429);
    expect(refused.headers.get('Retry-After')).not.toBeNull();
    expect(await refused.json()).toMatchObject({ error: 'Too many requests' });
  });

  /** The whole point of reading the last hop and not the first. */
  it('cannot be escaped by claiming a different address', async () => {
    const request = limited(2);

    expect((await request({ 'x-forwarded-for': 'spoofed-1, 203.0.113.7' })).status).toBe(200);
    expect((await request({ 'x-forwarded-for': 'spoofed-2, 203.0.113.7' })).status).toBe(200);
    // A third claim, the same real peer — refused.
    expect((await request({ 'x-forwarded-for': 'spoofed-3, 203.0.113.7' })).status).toBe(429);
  });

  it('gives a different address its own budget', async () => {
    const request = limited(1);
    expect((await request({ 'x-forwarded-for': '203.0.113.7' })).status).toBe(200);
    expect((await request({ 'x-forwarded-for': '203.0.113.7' })).status).toBe(429);
    expect((await request({ 'x-forwarded-for': '198.51.100.4' })).status).toBe(200);
  });

  it('gives each scope its own budget', async () => {
    const api = limited(1, 'api-ish');
    const pages = limited(1, 'u-ish');
    const headers = { 'x-forwarded-for': '203.0.113.7' };

    expect((await api(headers)).status).toBe(200);
    expect((await api(headers)).status).toBe(429);
    // The same client, the other surface: untouched.
    expect((await pages(headers)).status).toBe(200);
  });

  it('starts a fresh window once the old one has passed', async () => {
    const app = new Hono();
    app.use('*', createRateLimit({ scope: 'short', max: 1, windowMs: 1 }));
    app.get('/', (c) => c.text('ok'));
    const headers = { 'x-forwarded-for': '203.0.113.7' };

    expect((await app.request('http://localhost/', { headers })).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await app.request('http://localhost/', { headers })).status).toBe(200);
  });
});
