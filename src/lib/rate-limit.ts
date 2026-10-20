/**
 * Fixed-window rate limiting, in process.
 *
 * Two budgets, and they are separate on purpose (see the exports at the
 * bottom): a tight one for `/api/*`, and a looser one for the public profile
 * surface under `/u/*`, where one reader's visit is a page, a card and a chart
 * fetch per click rather than one request.
 *
 * In-process means per server instance and lost on restart, which is right for
 * what this is: a brake on one client's bursts, not a quota. Nothing here is a
 * security boundary — the budgets are keyed on an identity the client partly
 * controls (see clientIp) and a distributed caller gets a budget per address.
 */

import type { Context, MiddlewareHandler, Next } from 'hono';
import { createMiddleware } from 'hono/factory';

/** One window per key, in one store — the scope is part of the key. */
const rateLimitStore = new Map<string, { count: number; resetTime: number }>();

const WINDOW_MS = 60 * 1000;
/** `/api/*`: generous enough for the interactive charts, which poll on a click. */
const MAX_REQUESTS = 60;
/**
 * `/u/*`: four times that.
 *
 * One reader opening a profile costs a page, a share card and a curve fetch
 * for every control they touch, and these are PAGES — a human clicking around
 * must never meet a 429. It is still a ceiling: the curve is a ClickHouse scan
 * per uncached view, and this surface used to have no limit at all, so a loop
 * over `?metric=&period=&groupBy=` was an unmetered way to spend the database.
 */
const MAX_PAGE_REQUESTS = 240;

// Clean up expired entries periodically (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of rateLimitStore.entries()) {
    if (now > value.resetTime) {
      rateLimitStore.delete(key);
    }
  }
}, 5 * 60 * 1000);

/**
 * The visitor's address, as our own proxy established it.
 *
 * X-Real-IP first. Caddy SETS it (`header_up X-Real-IP {client_ip}` in the
 * Caddyfile), replacing whatever the request carried, to `{client_ip}`: the
 * CF-Connecting-IP header when the TCP peer is one of Cloudflare's published
 * ranges (`trusted_proxies`), and the peer itself for anyone else. So a visitor
 * behind Cloudflare gets their own budget instead of sharing their edge's, and
 * a request sent straight to the origin with a forged CF-Connecting-IP gets its
 * own peer address. That last guarantee lives in Caddy, not here: this function
 * cannot tell a Cloudflare peer from any other, and it trusts X-Real-IP only
 * because the app is reachable through Caddy alone (port 3000 is loopback).
 *
 * The LAST `X-Forwarded-For` entry is the fallback, for a proxy that does not
 * set X-Real-IP. Caddy APPENDS the immediate peer to whatever the request
 * already carried, so the list is `<whatever the client claimed>, …, <the real
 * peer>`; the FIRST entry is the client's own claim, and keying on it meant one
 * fabricated hop per request bought a fresh budget. Behind Cloudflare the last
 * hop is the edge, which is why it is no longer the first choice.
 *
 * Direct (no proxy, as in `bun run dev`) there is no header and every request
 * shares one bucket.
 */
export function clientIp(c: Context): string {
  const real = c.req.header('x-real-ip')?.trim();
  if (real) return real;
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) {
    const hops = forwarded.split(',');
    const peer = hops[hops.length - 1]?.trim();
    if (peer) return peer;
  }
  return 'unknown';
}

/** Per user when we know who they are, per address when we do not. */
function identify(c: Context, scope: string): string {
  const user = c.get('user');
  if (user?.id) return `${scope}:user:${user.id}`;
  return `${scope}:ip:${clientIp(c)}`;
}

export interface RateLimitOptions {
  /** Namespace for the key, so two budgets never share one window. */
  scope: string;
  max: number;
  windowMs?: number;
}

export function createRateLimit(options: RateLimitOptions): MiddlewareHandler {
  const { scope, max } = options;
  const windowMs = options.windowMs ?? WINDOW_MS;

  return createMiddleware(async (c: Context, next: Next) => {
    const identifier = identify(c, scope);
    const now = Date.now();

    let record = rateLimitStore.get(identifier);
    if (!record || now > record.resetTime) {
      record = { count: 0, resetTime: now + windowMs };
      rateLimitStore.set(identifier, record);
    }
    record.count++;

    c.header('X-RateLimit-Limit', max.toString());
    c.header('X-RateLimit-Remaining', Math.max(0, max - record.count).toString());
    c.header('X-RateLimit-Reset', Math.ceil(record.resetTime / 1000).toString());

    if (record.count > max) {
      const retryAfter = Math.ceil((record.resetTime - now) / 1000);
      c.header('Retry-After', retryAfter.toString());

      return c.json(
        {
          error: 'Too many requests',
          message: `Rate limit exceeded. Please try again in ${retryAfter} seconds.`,
          retryAfter,
        },
        429
      );
    }

    await next();
  });
}

/** `/api/*` — the original budget, unchanged. */
export const rateLimit = createRateLimit({ scope: 'api', max: MAX_REQUESTS });

/**
 * `/u/*` — the profile page, its curve endpoint and its share card.
 *
 * A separate scope as well as a separate ceiling: a reader browsing profiles
 * must not spend the budget their API client is also using, and vice versa.
 */
export const pageRateLimit = createRateLimit({ scope: 'u', max: MAX_PAGE_REQUESTS });

// Export for testing purposes
export { rateLimitStore, WINDOW_MS, MAX_REQUESTS, MAX_PAGE_REQUESTS };
