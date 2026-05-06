import type { Context } from 'hono';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../db/schema';
import type { SessionUser } from '../types';

const SESSION_COOKIE_NAME = 'session';
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

// Get session secret from environment
const getSessionSecret = (): string => {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error('SESSION_SECRET environment variable is required');
  }
  return secret;
};

// Sign a value using HMAC-SHA256
async function sign(value: string): Promise<string> {
  const secret = getSessionSecret();
  const encoder = new TextEncoder();
  const data = encoder.encode(value);
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, data);
  const signatureHex = Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return `${value}.${signatureHex}`;
}

// Verify and unsign a value
async function unsign(signedValue: string): Promise<string | null> {
  const lastDotIndex = signedValue.lastIndexOf('.');
  if (lastDotIndex === -1) return null;

  const value = signedValue.slice(0, lastDotIndex);
  const providedSignature = signedValue.slice(lastDotIndex + 1);

  const expectedSigned = await sign(value);
  const expectedSignature = expectedSigned.slice(expectedSigned.lastIndexOf('.') + 1);

  // Constant-time comparison to prevent timing attacks
  if (providedSignature.length !== expectedSignature.length) return null;

  let mismatch = 0;
  for (let i = 0; i < providedSignature.length; i++) {
    mismatch |= providedSignature.charCodeAt(i) ^ expectedSignature.charCodeAt(i);
  }

  return mismatch === 0 ? value : null;
}

// Create a session for a user
export async function createSession(c: Context, user: SessionUser): Promise<void> {
  const sessionData = JSON.stringify(user);
  const signedSession = await sign(sessionData);

  // Only use secure cookies if APP_URL is HTTPS (not just production mode)
  const isHttps = (process.env.APP_URL || '').startsWith('https://');

  setCookie(c, SESSION_COOKIE_NAME, signedSession, {
    httpOnly: true,
    secure: isHttps,
    sameSite: 'Lax',
    maxAge: SESSION_MAX_AGE,
    path: '/',
  });
}

// Get the current session user
export async function getSession(c: Context): Promise<SessionUser | null> {
  const signedSession = getCookie(c, SESSION_COOKIE_NAME);
  if (!signedSession) return null;

  const sessionData = await unsign(signedSession);
  if (!sessionData) return null;

  try {
    const user = JSON.parse(sessionData) as SessionUser;
    return user;
  } catch {
    return null;
  }
}

// Destroy the current session
export function destroySession(c: Context): void {
  deleteCookie(c, SESSION_COOKIE_NAME, {
    path: '/',
  });
}

// Issue a fresh CLI bearer token. Rotates users.token_gen so every prior
// token for this user is immediately invalid (verifyBearerToken rejects on
// gen mismatch). Tokens carry no `exp` — they're valid until rotated.
//
// The OTel SDK has no refresh hook, so the OTEL_EXPORTER_OTLP_HEADERS value
// must remain valid for the lifetime of the Claude Code process. Long-lived
// + revocable beats short-lived + auto-refresh-daemon for this use case.
export async function createBearerToken(userId: string): Promise<string> {
  const result = await db
    .update(users)
    .set({ tokenGen: sql`${users.tokenGen} + 1` })
    .where(eq(users.id, userId))
    .returning({ gen: users.tokenGen });

  if (result.length === 0) {
    throw new Error(`Cannot issue bearer token: user ${userId} not found`);
  }

  const gen = result[0]!.gen;
  const iat = Date.now();
  const payload = JSON.stringify({ userId, iat, gen });
  return sign(payload);
}

// Verify a bearer token and return the user ID, or null if rejected.
// Reject conditions: malformed payload, bad HMAC signature, missing gen
// claim, gen mismatch with users.token_gen, or (legacy) exp in the past.
export async function verifyBearerToken(token: string): Promise<string | null> {
  const payload = await unsign(token);
  if (!payload) return null;

  let userId: string | null = null;
  let gen: number | null = null;
  let exp: number | null = null;

  try {
    const parsed = JSON.parse(payload);
    userId = typeof parsed.userId === 'string' ? parsed.userId : null;
    gen = typeof parsed.gen === 'number' ? parsed.gen : null;
    exp = typeof parsed.exp === 'number' ? parsed.exp : null;
  } catch {
    return null;
  }

  if (!userId) return null;

  // Honor exp if present (lets us forward-validate hybrid tokens or future
  // formats without weakening the check).
  if (exp !== null && Date.now() > exp) return null;

  // gen is mandatory in the new format. Pre-revocation legacy tokens
  // (which were always exp-bound and have all expired by now) fall here.
  if (gen === null) return null;

  const row = await db
    .select({ tokenGen: users.tokenGen })
    .from(users)
    .where(eq(users.id, userId))
    .get();

  if (!row || row.tokenGen !== gen) return null;

  return userId;
}

// Export the session secret getter for other modules that need it
export const SESSION_SECRET = getSessionSecret;
