import type { Context, Next } from 'hono';
import { createMiddleware } from 'hono/factory';
import { getSession, verifyBearerTokenDetailed, type TokenKind } from './session';
import { db } from '../db';
import { users } from '../db/schema';
import { eq } from 'drizzle-orm';
import type { SessionUser } from '../types';

// Extend Hono context to include user
declare module 'hono' {
  interface ContextVariableMap {
    user: SessionUser | null;
    /** device_tokens.id of the bearer that authenticated this request. */
    deviceTokenId: string | null;
    /** Which bearer format authenticated it, for the "re-login to upgrade" nudge. */
    tokenKind: TokenKind | null;
  }
}

interface BearerIdentity {
  user: SessionUser;
  tokenId: string | null;
  kind: TokenKind;
}

// Get user from bearer token (for CLI/API access)
async function identifyByBearerToken(c: Context): Promise<BearerIdentity | null> {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.slice(7);
  const verified = await verifyBearerTokenDetailed(token);
  if (!verified) {
    return null;
  }

  // Look up user in database
  const result = await db
    .select({
      id: users.id,
      githubUsername: users.githubUsername,
      avatarUrl: users.avatarUrl,
    })
    .from(users)
    .where(eq(users.id, verified.userId))
    .limit(1);

  if (result.length === 0) {
    return null;
  }

  return { user: result[0]!, tokenId: verified.tokenId, kind: verified.kind };
}

function setIdentity(c: Context, identity: BearerIdentity | null): void {
  c.set('user', identity?.user ?? null);
  c.set('deviceTokenId', identity?.tokenId ?? null);
  c.set('tokenKind', identity?.kind ?? null);
}

// Optional auth middleware - attaches user to context if authenticated
export const optionalAuth = createMiddleware(async (c: Context, next: Next) => {
  // Try cookie session first, then bearer token
  const session = await getSession(c);
  if (session) {
    c.set('user', session);
    c.set('deviceTokenId', null);
    c.set('tokenKind', null);
  } else {
    setIdentity(c, await identifyByBearerToken(c));
  }
  await next();
});

// Required auth middleware - requires authentication
export const requireAuth = createMiddleware(async (c: Context, next: Next) => {
  // Try cookie session first, then bearer token
  const session = await getSession(c);
  if (session) {
    c.set('user', session);
    c.set('deviceTokenId', null);
    c.set('tokenKind', null);
    await next();
    return;
  }

  const identity = await identifyByBearerToken(c);
  if (!identity) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  setIdentity(c, identity);
  await next();
});

/**
 * Bearer-only auth, for /api/cli/*.
 *
 * A cookie session must NOT reach these endpoints: they are called by a local
 * binary that holds a token, never from a page, so accepting the session cookie
 * would make every one of them a CSRF target (any site could POST a browser
 * into revoking the user's devices or importing junk history). Rejecting the
 * cookie outright is what closes that, and it costs nothing — the CLI always
 * has a bearer.
 */
export const requireBearerAuth = createMiddleware(async (c: Context, next: Next) => {
  const identity = await identifyByBearerToken(c);
  if (!identity) {
    setIdentity(c, null);
    return c.json(
      {
        error: 'Unauthorized',
        message: 'This endpoint requires a clawdgg bearer token. Run `clawdgg login`.',
      },
      401
    );
  }

  setIdentity(c, identity);
  await next();
});
