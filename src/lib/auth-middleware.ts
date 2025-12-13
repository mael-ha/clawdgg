import type { Context, Next } from 'hono';
import { createMiddleware } from 'hono/factory';
import { getSession, verifyBearerToken } from './session';
import { db } from '../db';
import { users } from '../db/schema';
import { eq } from 'drizzle-orm';
import type { SessionUser } from '../types';

// Extend Hono context to include user
declare module 'hono' {
  interface ContextVariableMap {
    user: SessionUser | null;
  }
}

// Get user from bearer token (for CLI/API access)
async function getUserFromBearerToken(c: Context): Promise<SessionUser | null> {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.slice(7);
  const userId = await verifyBearerToken(token);
  if (!userId) {
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
    .where(eq(users.id, userId))
    .limit(1);

  if (result.length === 0) {
    return null;
  }

  return result[0];
}

// Optional auth middleware - attaches user to context if authenticated
export const optionalAuth = createMiddleware(async (c: Context, next: Next) => {
  // Try cookie session first, then bearer token
  let user = await getSession(c);
  if (!user) {
    user = await getUserFromBearerToken(c);
  }
  c.set('user', user);
  await next();
});

// Required auth middleware - requires authentication
export const requireAuth = createMiddleware(async (c: Context, next: Next) => {
  // Try cookie session first, then bearer token
  let user = await getSession(c);
  if (!user) {
    user = await getUserFromBearerToken(c);
  }

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  c.set('user', user);
  await next();
});
