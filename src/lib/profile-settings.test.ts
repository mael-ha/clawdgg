import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as schema from '../db/schema';
import { FINGERPRINT_SECTIONS } from './fingerprint';
import {
  SECTION_COLUMNS,
  defaultVisibility,
  getVisibility,
  hiddenSections,
  parseVisibilityPatch,
  setVisibility,
  visibilityOf,
} from './profile-settings';

const REPO_ROOT = new URL('../..', import.meta.url).pathname;

describe('SECTION_COLUMNS', () => {
  it('covers every section exactly once', () => {
    expect(Object.keys(SECTION_COLUMNS).sort()).toEqual([...FINGERPRINT_SECTIONS].sort());
    const columns = Object.values(SECTION_COLUMNS);
    expect(new Set(columns).size).toBe(columns.length);
  });
});

describe('defaultVisibility', () => {
  // The product rule: a profile is public and the toggles take sections DOWN.
  it('is everything on', () => {
    const visibility = defaultVisibility();
    expect(Object.values(visibility).every((v) => v === true)).toBe(true);
    expect(Object.keys(visibility).length).toBe(FINGERPRINT_SECTIONS.length);
  });
});

describe('visibilityOf', () => {
  // Most users will never open the settings page. A missing row must not read
  // as a blank profile.
  it('treats no row as everything visible', () => {
    expect(visibilityOf(undefined)).toEqual(defaultVisibility());
    expect(visibilityOf(null)).toEqual(defaultVisibility());
  });

  it('hides only what the row says false', () => {
    const row = { ...fullRow(), showClass: false, showUltrathink: false };
    const visibility = visibilityOf(row);
    expect(visibility.class).toBe(false);
    expect(visibility.ultrathink).toBe(false);
    expect(visibility.value).toBe(true);
  });

  // A column added ahead of its backfill reads null. That is "visible" — the
  // alternative is a release that silently blanks part of every profile.
  it('treats a null column as visible', () => {
    const row = { ...fullRow(), showRings: null as unknown as boolean };
    expect(visibilityOf(row).rings).toBe(true);
  });
});

describe('hiddenSections', () => {
  it('is empty for a user who has changed nothing', () => {
    expect(hiddenSections(undefined)).toEqual([]);
  });

  it('lists exactly what was turned off', () => {
    expect(hiddenSections({ ...fullRow(), showMilestones: false, showPlan: false })).toEqual([
      'milestones',
      'plan',
    ]);
  });
});

describe('parseVisibilityPatch', () => {
  it('accepts a partial patch of known sections', () => {
    expect(parseVisibilityPatch({ class: false, value: true })).toEqual({
      patch: { class: false, value: true },
    });
  });

  /**
   * An unknown key is a 400, not an ignored field. A settings page that posts
   * `{ rigns: false }` and gets a 200 shows the user a toggle that does
   * nothing, and they walk away believing a section is hidden when it is not.
   */
  it('refuses an unknown section rather than ignoring it', () => {
    const result = parseVisibilityPatch({ rigns: false });
    expect(result).toHaveProperty('error');
    if ('error' in result) expect(result.error).toContain('rigns');
  });

  it('refuses a non-boolean, including the strings that look like one', () => {
    for (const value of ['false', 0, 1, null, undefined, {}]) {
      expect(parseVisibilityPatch({ class: value })).toHaveProperty('error');
    }
  });

  it.each([[null], [undefined], [[]], ['class'], [42], [{}]])(
    'refuses %p as a body',
    (body: unknown) => {
      expect(parseVisibilityPatch(body)).toHaveProperty('error');
    }
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Against a real database
// ═══════════════════════════════════════════════════════════════════════════

let dir: string;
let sqlite: Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

async function applySchema(database: Database): Promise<void> {
  database.exec(`CREATE TABLE users (
    id text PRIMARY KEY NOT NULL,
    github_id text,
    github_username text
  )`);
  // The real migration IS the schema under test.
  const migration = await readFile(
    join(REPO_ROOT, 'drizzle/0012_add_profile_settings.sql'),
    'utf-8'
  );
  for (const statement of migration.split('--> statement-breakpoint')) {
    if (statement.trim()) database.exec(statement);
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'clawdgg-profile-settings-'));
  sqlite = new Database(join(dir, 'test.db'), { create: true });
  sqlite.exec('PRAGMA foreign_keys = ON');
  await applySchema(sqlite);
  db = drizzle(sqlite, { schema });
  sqlite.exec(`INSERT INTO users (id, github_id, github_username) VALUES ('u1', '1', 'ann')`);
});

afterEach(async () => {
  sqlite.close();
  await rm(dir, { recursive: true, force: true });
});

describe('getVisibility / setVisibility', () => {
  // No row is written for a signup: the default is already the default, and a
  // row of all-true is a write for nothing.
  it('defaults to everything on with no row written', async () => {
    expect(await getVisibility('u1', db)).toEqual(defaultVisibility());
    expect(db.select().from(schema.profileSettings).all()).toEqual([]);
  });

  it('creates the row on the first change, and leaves the rest on', async () => {
    const after = await setVisibility('u1', { class: false }, db);
    expect(after.class).toBe(false);
    expect(after.value).toBe(true);
    expect(db.select().from(schema.profileSettings).all().length).toBe(1);
  });

  it('merges a later patch instead of replacing the row', async () => {
    await setVisibility('u1', { class: false }, db);
    const after = await setVisibility('u1', { ultrathink: false }, db);

    expect(after.class).toBe(false); // still off
    expect(after.ultrathink).toBe(false);
    expect(db.select().from(schema.profileSettings).all().length).toBe(1);
  });

  it('turns a section back on', async () => {
    await setVisibility('u1', { rings: false }, db);
    expect((await setVisibility('u1', { rings: true }, db)).rings).toBe(true);
    expect(await hiddenSectionsFor('u1')).toEqual([]);
  });

  it('can hide everything, and still answers', async () => {
    const all = Object.fromEntries(FINGERPRINT_SECTIONS.map((s) => [s, false]));
    const after = await setVisibility('u1', all, db);
    expect(Object.values(after).every((v) => v === false)).toBe(true);
    expect(await hiddenSectionsFor('u1')).toEqual([...FINGERPRINT_SECTIONS]);
  });

  it("keeps one user's settings out of another's", async () => {
    sqlite.exec(`INSERT INTO users (id, github_id, github_username) VALUES ('u2', '2', 'mel')`);
    await setVisibility('u1', { class: false }, db);
    expect((await getVisibility('u2', db)).class).toBe(true);
  });
});

async function hiddenSectionsFor(userId: string) {
  const row = db
    .select()
    .from(schema.profileSettings)
    .all()
    .find((r) => r.userId === userId);
  return hiddenSections(row);
}

/** A row with every section on, as the table's defaults produce. */
function fullRow(): schema.ProfileSettings {
  return {
    userId: 'u1',
    showValue: true,
    showAnatomy: true,
    showConversation: true,
    showRings: true,
    showClass: true,
    showMilestones: true,
    showCurve: true,
    showYear: true,
    showUltrathink: true,
    showPlan: true,
    updatedAt: new Date(),
  };
}
