import type { Context } from 'hono';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { db } from '../db';
import { deviceTokens, users } from '../db/schema';
import type { SessionUser } from '../types';

/**
 * The drizzle handle every function here takes. Defaulted to the app's, and
 * injectable so the tests can run against a temp SQLite file instead of
 * data/clawd.db.
 */
type AppDb = typeof db;

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

// ═══════════════════════════════════════════════════════════════════════════
// Per-device CLI tokens
// ═══════════════════════════════════════════════════════════════════════════
//
// A CLI bearer is `cgt_<id>.<secret>`:
//   id      32 hex chars — the public half, a primary key into device_tokens
//   secret  64 hex chars — never stored; only sha256(secret) is
//
// Issuing one touches nothing else, so logging in on a second machine leaves
// the first one working. Revoking one row logs out exactly that machine.
//
// The token carries no expiry on purpose: the OTel SDK has no refresh hook, so
// the Authorization header `otelHeadersHelper` prints has to stay valid for the
// life of the Claude Code process. Long-lived + individually revocable is the
// trade we take, and the CLI turns a 401 into a loud local failure rather than
// the silent exporter drop that cost us months of data in May 2026.

export const DEVICE_TOKEN_PREFIX = 'cgt_';
const DEVICE_TOKEN_ID_RE = /^[0-9a-f]{32}$/;
const DEVICE_TOKEN_SECRET_RE = /^[0-9a-f]{64}$/;

/** Fallback name for a token issued before the CLI reports its hostname. */
export const UNNAMED_DEVICE = 'unnamed device';
const MAX_DEVICE_NAME_LENGTH = 64;

/**
 * How stale `last_used_at` is allowed to get. The OTLP ingest path verifies a
 * token on every exported batch (every few seconds under load), so writing the
 * column each time would turn a read into a write for no extra information.
 */
export const LAST_USED_THROTTLE_MS = 5 * 60 * 1000;

/** Collapse whatever the client sent into something printable. */
export function normalizeDeviceName(name: unknown): string {
  const cleaned = String(name ?? '')
    // Control characters would corrupt `clawdgg devices` output.
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DEVICE_NAME_LENGTH);
  return cleaned || UNNAMED_DEVICE;
}

export function hashTokenSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Constant-time comparison of the presented secret against a stored hash. */
export function secretMatchesHash(secret: string, storedHash: string): boolean {
  const presented = Buffer.from(hashTokenSecret(secret), 'hex');
  // A stored hash of the wrong length can never match, and timingSafeEqual
  // throws on a length mismatch — so answer without calling it.
  if (!DEVICE_TOKEN_SECRET_RE.test(storedHash)) return false;
  return timingSafeEqual(presented, Buffer.from(storedHash, 'hex'));
}

export interface ParsedDeviceToken {
  id: string;
  secret: string;
}

/** Split `cgt_<id>.<secret>`, or null when it isn't one. */
export function parseDeviceToken(token: unknown): ParsedDeviceToken | null {
  if (typeof token !== 'string' || !token.startsWith(DEVICE_TOKEN_PREFIX)) return null;
  const rest = token.slice(DEVICE_TOKEN_PREFIX.length);
  const dot = rest.indexOf('.');
  if (dot <= 0) return null;
  const id = rest.slice(0, dot);
  const secret = rest.slice(dot + 1);
  if (!DEVICE_TOKEN_ID_RE.test(id) || !DEVICE_TOKEN_SECRET_RE.test(secret)) return null;
  return { id, secret };
}

export function formatDeviceToken(id: string, secret: string): string {
  return `${DEVICE_TOKEN_PREFIX}${id}.${secret}`;
}

export interface IssuedDeviceToken {
  /** The only time the full bearer exists server-side. */
  token: string;
  tokenId: string;
  deviceName: string;
}

/**
 * Issue a token for one device. Does NOT revoke anything: that was the bug in
 * the token_gen scheme, where `clawdgg login` on a laptop silently killed
 * telemetry on the desktop.
 */
export async function createDeviceToken(
  userId: string,
  deviceName: unknown = UNNAMED_DEVICE,
  database: AppDb = db
): Promise<IssuedDeviceToken> {
  const owner = await database
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  if (!owner) throw new Error(`Cannot issue bearer token: user ${userId} not found`);

  const tokenId = randomBytes(16).toString('hex');
  const secret = randomBytes(32).toString('hex');
  const name = normalizeDeviceName(deviceName);

  await database.insert(deviceTokens).values({
    id: tokenId,
    userId,
    deviceName: name,
    secretHash: hashTokenSecret(secret),
    createdAt: new Date(),
  });

  return { token: formatDeviceToken(tokenId, secret), tokenId, deviceName: name };
}

/**
 * Issue a CLI bearer token. Kept under its old name and signature because
 * src/routes/auth.ts's device flow calls it; the CLI renames the device to its
 * hostname right after login.
 */
export async function createBearerToken(userId: string): Promise<string> {
  const { token } = await createDeviceToken(userId);
  return token;
}

export type TokenKind = 'device' | 'legacy';

export interface VerifiedBearer {
  userId: string;
  kind: TokenKind;
  /** device_tokens.id, or null for a legacy token_gen-signed bearer. */
  tokenId: string | null;
}

/** In-process throttle for last_used_at. Key: device token id. */
const lastUsedWrites = new Map<string, number>();

export function shouldTouchLastUsed(
  storedLastUsed: Date | null | undefined,
  lastWriteMs: number | undefined,
  nowMs: number
): boolean {
  const seen = Math.max(storedLastUsed ? storedLastUsed.getTime() : 0, lastWriteMs ?? 0);
  return nowMs - seen >= LAST_USED_THROTTLE_MS;
}

async function verifyDeviceToken(
  parsed: ParsedDeviceToken,
  database: AppDb
): Promise<VerifiedBearer | null> {
  const row = await database
    .select({
      userId: deviceTokens.userId,
      secretHash: deviceTokens.secretHash,
      revokedAt: deviceTokens.revokedAt,
      lastUsedAt: deviceTokens.lastUsedAt,
    })
    .from(deviceTokens)
    .where(eq(deviceTokens.id, parsed.id))
    .get();

  if (!row) return null;
  if (row.revokedAt) return null;
  if (!secretMatchesHash(parsed.secret, row.secretHash)) return null;

  const now = Date.now();
  if (shouldTouchLastUsed(row.lastUsedAt, lastUsedWrites.get(parsed.id), now)) {
    lastUsedWrites.set(parsed.id, now);
    await database
      .update(deviceTokens)
      .set({ lastUsedAt: new Date(now) })
      .where(eq(deviceTokens.id, parsed.id));
  }

  return { userId: row.userId, kind: 'device', tokenId: parsed.id };
}

/**
 * The pre-2.0 format: sign(JSON.stringify({ userId, iat, gen })), checked
 * against users.token_gen. Still accepted so the one outstanding token keeps
 * working — `clawdgg doctor` tells its holder to re-login and get a per-device
 * one. Remove this path once that has happened (see cli/README.md).
 */
async function verifyLegacyToken(token: string, database: AppDb): Promise<VerifiedBearer | null> {
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
  if (exp !== null && Date.now() > exp) return null;
  if (gen === null) return null;

  const row = await database
    .select({ tokenGen: users.tokenGen })
    .from(users)
    .where(eq(users.id, userId))
    .get();

  if (!row || row.tokenGen !== gen) return null;

  return { userId, kind: 'legacy', tokenId: null };
}

/**
 * The one verifier. Both the /api/* bearer middleware and the OTLP ingest path
 * (src/routes/otel.ts) go through it, so a revoked device is rejected
 * everywhere at once.
 */
export async function verifyBearerTokenDetailed(
  token: string,
  database: AppDb = db
): Promise<VerifiedBearer | null> {
  const parsed = parseDeviceToken(token);
  if (parsed) return verifyDeviceToken(parsed, database);
  return verifyLegacyToken(token, database);
}

/**
 * Verify a bearer token and return the user ID, or null if rejected.
 * Signature unchanged: src/routes/otel.ts calls exactly this.
 */
export async function verifyBearerToken(token: string): Promise<string | null> {
  return (await verifyBearerTokenDetailed(token))?.userId ?? null;
}

export interface DeviceSummary {
  id: string;
  name: string;
  createdAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

const toIso = (value: Date | null | undefined): string | null =>
  value ? new Date(value).toISOString() : null;

/** Live devices first, newest first. Revoked rows are kept for the audit trail. */
export async function listDeviceTokens(
  userId: string,
  database: AppDb = db
): Promise<DeviceSummary[]> {
  const rows = await database
    .select({
      id: deviceTokens.id,
      deviceName: deviceTokens.deviceName,
      createdAt: deviceTokens.createdAt,
      lastUsedAt: deviceTokens.lastUsedAt,
      revokedAt: deviceTokens.revokedAt,
    })
    .from(deviceTokens)
    .where(eq(deviceTokens.userId, userId))
    .all();

  return rows
    .map((row) => ({
      id: row.id,
      name: row.deviceName,
      createdAt: toIso(row.createdAt),
      lastUsedAt: toIso(row.lastUsedAt),
      revokedAt: toIso(row.revokedAt),
    }))
    .sort((a, b) => {
      if (!a.revokedAt !== !b.revokedAt) return a.revokedAt ? 1 : -1;
      return (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
    });
}

/** Revoke one device. False when it isn't this user's, or was already revoked. */
export async function revokeDeviceToken(
  userId: string,
  tokenId: string,
  database: AppDb = db
): Promise<boolean> {
  const result = await database
    .update(deviceTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(deviceTokens.id, tokenId),
        eq(deviceTokens.userId, userId),
        isNull(deviceTokens.revokedAt)
      )
    )
    .returning({ id: deviceTokens.id });

  lastUsedWrites.delete(tokenId);
  return result.length > 0;
}

/**
 * Revoke every device. Also bumps users.token_gen, because a legacy token is
 * not a device_tokens row and would otherwise survive "revoke all".
 */
export async function revokeAllDeviceTokens(
  userId: string,
  database: AppDb = db
): Promise<number> {
  const result = await database
    .update(deviceTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(deviceTokens.userId, userId), isNull(deviceTokens.revokedAt)))
    .returning({ id: deviceTokens.id });

  for (const row of result) lastUsedWrites.delete(row.id);

  await database
    .update(users)
    .set({ tokenGen: sql`${users.tokenGen} + 1`, updatedAt: new Date() })
    .where(eq(users.id, userId));

  return result.length;
}

/** Rename one device. False when it isn't this user's. */
export async function renameDeviceToken(
  userId: string,
  tokenId: string,
  name: unknown,
  database: AppDb = db
): Promise<boolean> {
  const result = await database
    .update(deviceTokens)
    .set({ deviceName: normalizeDeviceName(name) })
    .where(and(eq(deviceTokens.id, tokenId), eq(deviceTokens.userId, userId)))
    .returning({ id: deviceTokens.id });

  return result.length > 0;
}

// Export the session secret getter for other modules that need it
export const SESSION_SECRET = getSessionSecret;
