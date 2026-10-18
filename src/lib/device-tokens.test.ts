import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { eq } from 'drizzle-orm';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as schema from '../db/schema';
import { deviceTokens, users } from '../db/schema';
import {
  createDeviceToken,
  formatDeviceToken,
  hashTokenSecret,
  LAST_USED_THROTTLE_MS,
  listDeviceTokens,
  normalizeDeviceName,
  parseDeviceToken,
  renameDeviceToken,
  revokeAllDeviceTokens,
  revokeDeviceToken,
  secretMatchesHash,
  shouldTouchLastUsed,
  UNNAMED_DEVICE,
  verifyBearerTokenDetailed,
} from './session';

const REPO_ROOT = new URL('../..', import.meta.url).pathname;

// Every DB test runs against a temp SQLite file. Nothing here may touch
// data/clawd.db — which is what src/db/index.ts opens on import.
let dir: string;
let sqlite: Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

/**
 * The real migration is the schema under test: reading it here is what keeps
 * drizzle/0009_add_device_tokens.sql and src/db/schema.ts from drifting apart.
 */
async function applySchema(database: Database): Promise<void> {
  database.exec(`CREATE TABLE users (
    id text PRIMARY KEY NOT NULL,
    github_id text,
    github_username text,
    avatar_url text,
    token_gen integer NOT NULL DEFAULT 1,
    created_at integer NOT NULL DEFAULT (unixepoch()),
    updated_at integer NOT NULL DEFAULT (unixepoch())
  )`);

  const migration = await readFile(
    join(REPO_ROOT, 'drizzle/0009_add_device_tokens.sql'),
    'utf-8'
  );
  for (const statement of migration.split('--> statement-breakpoint')) {
    if (statement.trim()) database.exec(statement);
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'clawdgg-device-tokens-'));
  sqlite = new Database(join(dir, 'test.db'), { create: true });
  sqlite.exec('PRAGMA foreign_keys = ON');
  await applySchema(sqlite);
  db = drizzle(sqlite, { schema });

  // Raw SQL, not a drizzle insert: the fixture carries only the `users`
  // columns this module reads, and drizzle would emit all of them.
  sqlite.exec(`INSERT INTO users (id, github_id, github_username) VALUES
    ('github_1', '1', 'alice'), ('github_2', '2', 'bob')`);
});

afterEach(async () => {
  sqlite.close();
  await rm(dir, { recursive: true, force: true });
});

describe('token format', () => {
  it('round-trips an id and a secret', () => {
    const id = 'a'.repeat(32);
    const secret = 'b'.repeat(64);
    expect(parseDeviceToken(formatDeviceToken(id, secret))).toEqual({ id, secret });
  });

  it('rejects everything that is not one', () => {
    expect(parseDeviceToken(undefined)).toBeNull();
    expect(parseDeviceToken('')).toBeNull();
    expect(parseDeviceToken(`cgt_${'a'.repeat(32)}`)).toBeNull();
    expect(parseDeviceToken(`cgt_.${'b'.repeat(64)}`)).toBeNull();
    // Right shape, wrong lengths.
    expect(parseDeviceToken(`cgt_${'a'.repeat(31)}.${'b'.repeat(64)}`)).toBeNull();
    expect(parseDeviceToken(`cgt_${'a'.repeat(32)}.${'b'.repeat(63)}`)).toBeNull();
    // Non-hex can't be a real id or secret, and must never reach a query.
    expect(parseDeviceToken(`cgt_${'A'.repeat(32)}.${'b'.repeat(64)}`)).toBeNull();
    // A legacy signed token is not a device token.
    expect(parseDeviceToken(`{"userId":"github_1","gen":4}.${'a'.repeat(64)}`)).toBeNull();
  });
});

describe('secretMatchesHash', () => {
  it('accepts the right secret and nothing else', () => {
    const hash = hashTokenSecret('s3cret');
    expect(secretMatchesHash('s3cret', hash)).toBe(true);
    expect(secretMatchesHash('s3cres', hash)).toBe(false);
    expect(secretMatchesHash('', hash)).toBe(false);
  });

  it('answers false for a stored hash of the wrong shape instead of throwing', () => {
    // timingSafeEqual throws on a length mismatch; a corrupt row must not 500.
    expect(secretMatchesHash('s3cret', '')).toBe(false);
    expect(secretMatchesHash('s3cret', 'not-a-hash')).toBe(false);
  });
});

describe('shouldTouchLastUsed', () => {
  const now = 1_790_000_000_000;

  it('writes the first time, then not again inside the window', () => {
    expect(shouldTouchLastUsed(null, undefined, now)).toBe(true);
    expect(shouldTouchLastUsed(new Date(now - 1000), undefined, now)).toBe(false);
    expect(shouldTouchLastUsed(null, now - 1000, now)).toBe(false);
  });

  it('writes again once the window has passed', () => {
    expect(shouldTouchLastUsed(new Date(now - LAST_USED_THROTTLE_MS), undefined, now)).toBe(true);
  });
});

describe('normalizeDeviceName', () => {
  it('falls back, collapses whitespace and truncates', () => {
    expect(normalizeDeviceName(undefined)).toBe(UNNAMED_DEVICE);
    expect(normalizeDeviceName('   ')).toBe(UNNAMED_DEVICE);
    expect(normalizeDeviceName('  my   laptop \n')).toBe('my laptop');
    expect(normalizeDeviceName('x'.repeat(200))).toHaveLength(64);
  });

  it('strips control characters that would corrupt the device list', () => {
    expect(normalizeDeviceName('ok\u001b[31mred')).toBe('ok [31mred');
  });
});

describe('createDeviceToken', () => {
  it('stores only a hash of the secret', async () => {
    const issued = await createDeviceToken('github_1', 'laptop', db);
    const parsed = parseDeviceToken(issued.token)!;

    const row = await db
      .select()
      .from(deviceTokens)
      .where(eq(deviceTokens.id, issued.tokenId))
      .get();

    expect(row!.deviceName).toBe('laptop');
    expect(row!.secretHash).toBe(hashTokenSecret(parsed.secret));
    expect(row!.secretHash).not.toContain(parsed.secret);
    expect(JSON.stringify(row)).not.toContain(parsed.secret);
  });

  it('refuses to mint a token for a user that does not exist', async () => {
    await expect(createDeviceToken('github_nope', 'laptop', db)).rejects.toThrow('not found');
  });

  it('issues distinct ids and secrets', async () => {
    const a = await createDeviceToken('github_1', 'a', db);
    const b = await createDeviceToken('github_1', 'b', db);
    expect(a.tokenId).not.toBe(b.tokenId);
    expect(a.token).not.toBe(b.token);
  });
});

describe('verifyBearerTokenDetailed', () => {
  it('a login on machine B does not revoke machine A', async () => {
    // This is the whole point of the table. Under the token_gen scheme the
    // second login silently killed the first machine's telemetry.
    const a = await createDeviceToken('github_1', 'machine-a', db);
    const b = await createDeviceToken('github_1', 'machine-b', db);

    expect(await verifyBearerTokenDetailed(a.token, db)).toEqual({
      userId: 'github_1',
      kind: 'device',
      tokenId: a.tokenId,
    });
    expect(await verifyBearerTokenDetailed(b.token, db)).toEqual({
      userId: 'github_1',
      kind: 'device',
      tokenId: b.tokenId,
    });

    // And it did not touch users.token_gen either.
    const user = await db.select({ gen: users.tokenGen }).from(users).where(eq(users.id, 'github_1')).get();
    expect(user!.gen).toBe(1);
  });

  it('rejects a revoked token', async () => {
    const issued = await createDeviceToken('github_1', 'laptop', db);
    expect(await revokeDeviceToken('github_1', issued.tokenId, db)).toBe(true);
    expect(await verifyBearerTokenDetailed(issued.token, db)).toBeNull();
  });

  it('rejects a real id with the wrong secret', async () => {
    const issued = await createDeviceToken('github_1', 'laptop', db);
    const forged = formatDeviceToken(issued.tokenId, 'f'.repeat(64));
    expect(await verifyBearerTokenDetailed(forged, db)).toBeNull();
  });

  it('rejects an id that was never issued', async () => {
    expect(
      await verifyBearerTokenDetailed(formatDeviceToken('0'.repeat(32), 'f'.repeat(64)), db)
    ).toBeNull();
  });

  it('records last_used_at', async () => {
    const issued = await createDeviceToken('github_1', 'laptop', db);
    expect(
      (await db.select().from(deviceTokens).where(eq(deviceTokens.id, issued.tokenId)).get())!
        .lastUsedAt
    ).toBeNull();

    await verifyBearerTokenDetailed(issued.token, db);

    const row = await db
      .select()
      .from(deviceTokens)
      .where(eq(deviceTokens.id, issued.tokenId))
      .get();
    expect(row!.lastUsedAt).not.toBeNull();
  });
});

describe('revocation', () => {
  it('revokes one device and leaves the others', async () => {
    const a = await createDeviceToken('github_1', 'a', db);
    const b = await createDeviceToken('github_1', 'b', db);

    expect(await revokeDeviceToken('github_1', a.tokenId, db)).toBe(true);
    expect(await verifyBearerTokenDetailed(a.token, db)).toBeNull();
    expect(await verifyBearerTokenDetailed(b.token, db)).not.toBeNull();
  });

  it('will not revoke someone else\'s device', async () => {
    const mine = await createDeviceToken('github_1', 'a', db);
    expect(await revokeDeviceToken('github_2', mine.tokenId, db)).toBe(false);
    expect(await verifyBearerTokenDetailed(mine.token, db)).not.toBeNull();
  });

  it('is not fooled twice by the same id', async () => {
    const a = await createDeviceToken('github_1', 'a', db);
    expect(await revokeDeviceToken('github_1', a.tokenId, db)).toBe(true);
    expect(await revokeDeviceToken('github_1', a.tokenId, db)).toBe(false);
  });

  it('revoke-all kills every device AND bumps token_gen for legacy bearers', async () => {
    const a = await createDeviceToken('github_1', 'a', db);
    const b = await createDeviceToken('github_1', 'b', db);
    const other = await createDeviceToken('github_2', 'c', db);

    expect(await revokeAllDeviceTokens('github_1', db)).toBe(2);
    expect(await verifyBearerTokenDetailed(a.token, db)).toBeNull();
    expect(await verifyBearerTokenDetailed(b.token, db)).toBeNull();
    // Another user is untouched.
    expect(await verifyBearerTokenDetailed(other.token, db)).not.toBeNull();

    // A pre-2.0 token has no row here, so only the gen bump can kill it.
    const user = await db.select({ gen: users.tokenGen }).from(users).where(eq(users.id, 'github_1')).get();
    expect(user!.gen).toBe(2);
  });
});

describe('listDeviceTokens', () => {
  it('lists live devices before revoked ones', async () => {
    const a = await createDeviceToken('github_1', 'a', db);
    await createDeviceToken('github_1', 'b', db);
    await revokeDeviceToken('github_1', a.tokenId, db);

    const listed = await listDeviceTokens('github_1', db);
    expect(listed.map((d) => d.name)).toEqual(['b', 'a']);
    expect(listed[0]!.revokedAt).toBeNull();
    expect(listed[1]!.revokedAt).toBeString();
    // The secret hash is not part of the listing.
    expect(JSON.stringify(listed)).not.toContain('secretHash');
  });

  it('never leaks another user\'s devices', async () => {
    await createDeviceToken('github_1', 'mine', db);
    await createDeviceToken('github_2', 'theirs', db);
    expect((await listDeviceTokens('github_1', db)).map((d) => d.name)).toEqual(['mine']);
  });
});

describe('renameDeviceToken', () => {
  it('renames our own and refuses someone else\'s', async () => {
    const issued = await createDeviceToken('github_1', 'old', db);
    expect(await renameDeviceToken('github_1', issued.tokenId, ' new name ', db)).toBe(true);
    expect((await listDeviceTokens('github_1', db))[0]!.name).toBe('new name');
    expect(await renameDeviceToken('github_2', issued.tokenId, 'hijacked', db)).toBe(false);
    expect((await listDeviceTokens('github_1', db))[0]!.name).toBe('new name');
  });
});
