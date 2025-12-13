import type { Context } from 'hono';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
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

  setCookie(c, SESSION_COOKIE_NAME, signedSession, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
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

// Create a bearer token for API access (CLI auth)
export async function createBearerToken(userId: string): Promise<string> {
  const payload = JSON.stringify({ userId, iat: Date.now() });
  return sign(payload);
}

// Verify a bearer token and return the user ID
export async function verifyBearerToken(token: string): Promise<string | null> {
  const payload = await unsign(token);
  if (!payload) return null;

  try {
    const { userId } = JSON.parse(payload);
    return userId || null;
  } catch {
    return null;
  }
}

// Export the session secret getter for other modules that need it
export const SESSION_SECRET = getSessionSecret;
