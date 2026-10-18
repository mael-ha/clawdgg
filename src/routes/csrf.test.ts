/**
 * The two write paths a page on somebody else's domain could reach.
 *
 * Every cookie-accepting write in this app is a POST or a PUT, and the session
 * cookie is `SameSite=Lax` — which sends it on a cross-site top-level GET
 * navigation and on nothing else. So a cross-site POST/PUT arrives with no
 * cookie and 401s before any handler runs, and the whole class is closed by the
 * cookie rather than by per-route checks.
 *
 * That reasoning fails for exactly one shape: a state change on a GET. There is
 * one, `GET /auth/logout`, and Lax is no help precisely there — `<a href>` to it
 * from any page IS a top-level GET navigation, cookie included. `Sec-Fetch-Site`
 * is what closes it, and this asserts that it does.
 *
 * Driven through the real routers, because what is being tested is which
 * requests the router lets through, and a source assertion would pass on a
 * handler that reads the header and ignores it.
 */

import { describe, expect, it } from 'bun:test';
import auth from './auth';
import api from './api';

const LOGOUT = 'http://localhost/logout';

function logout(site?: string) {
  return auth.request(LOGOUT, {
    method: 'GET',
    headers: {
      cookie: 'session=whatever',
      ...(site ? { 'Sec-Fetch-Site': site } : {}),
    },
    redirect: 'manual',
  });
}

describe('GET /auth/logout', () => {
  it('refuses a request another site caused', async () => {
    for (const site of ['cross-site', 'same-site']) {
      const response = await logout(site);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: 'Cross-site logout refused' });
    }
  });

  it('allows our own pages and the address bar', async () => {
    // 'none' is a user-initiated navigation — a bookmark or a typed URL — and a
    // page cannot produce it. Browsers set this header themselves.
    for (const site of ['same-origin', 'none']) {
      const response = await logout(site);
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/');
    }
  });

  it('allows a client that sends no Sec-Fetch-Site at all', async () => {
    // curl, or a browser too old to have the header. Its absence is not
    // evidence of anything, and refusing it would break logging out for a
    // client that cannot be attacked this way either.
    const response = await logout();
    expect(response.status).toBe(302);
  });

  it('clears the session when it does log out', async () => {
    const response = await logout('same-origin');
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^session=;/);
    expect(cookie).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
  });
});

describe('POST /api/plan-usage', () => {
  /**
   * BEARER ONLY. The figures come from the rate limits Claude Code hands the
   * status line on the user's own machine; a browser does not have them and
   * cannot get them, so a cookie session writing here could only ever be
   * something lying. It used to be accepted.
   */
  it('refuses a cookie session and says what it wants instead', async () => {
    const response = await api.request('http://localhost/plan-usage', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'session=whatever' },
      body: JSON.stringify({ rate_limits: {} }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      message: expect.stringContaining('bearer token'),
    });
  });
});
