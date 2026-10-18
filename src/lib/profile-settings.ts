/**
 * Which parts of their profile a user shows.
 *
 * PUBLIC BY DEFAULT. Every section is on until the owner turns it off — the
 * toggles exist so someone can take a section down, not so they have to opt in
 * to existing. A new section added later is therefore visible on every existing
 * profile, which is the behaviour the column defaults give us for free.
 *
 * A hidden section is OMITTED from the payload rather than zeroed. A zero is a
 * claim about the data ("this person has written no code"); an absent section
 * is a claim about the owner's choice, and only one of those is true.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db';
import { profileSettings, type ProfileSettings } from '../db/schema';
import { FINGERPRINT_SECTIONS, type FingerprintSection } from './fingerprint';

type AppDb = typeof db;

/**
 * The boolean columns only — `userId` and `updatedAt` are not toggles, and
 * leaving them in the key type lets a typo write a boolean into one.
 */
type SectionColumn = {
  [K in keyof ProfileSettings]: ProfileSettings[K] extends boolean ? K : never;
}[keyof ProfileSettings];

/**
 * Section name → the column that hides it.
 *
 * Typed against both sides, so a section added to FINGERPRINT_SECTIONS without
 * a column (or vice versa) is a compile error rather than a section that
 * silently cannot be hidden.
 */
export const SECTION_COLUMNS: Record<FingerprintSection, SectionColumn> = {
  value: 'showValue',
  anatomy: 'showAnatomy',
  conversation: 'showConversation',
  rings: 'showRings',
  class: 'showClass',
  milestones: 'showMilestones',
  curve: 'showCurve',
  year: 'showYear',
  ultrathink: 'showUltrathink',
  plan: 'showPlan',
};

export type Visibility = Record<FingerprintSection, boolean>;

/** Everything on — what a user with no row has, and what a new row gets. */
export function defaultVisibility(): Visibility {
  return Object.fromEntries(FINGERPRINT_SECTIONS.map((s) => [s, true])) as Visibility;
}

/**
 * A stored row as a per-section verdict. NO ROW MEANS EVERYTHING VISIBLE: most
 * users will never touch these settings, and a missing row must not read as a
 * blank profile.
 */
export function visibilityOf(row: ProfileSettings | undefined | null): Visibility {
  const visibility = defaultVisibility();
  if (!row) return visibility;
  for (const section of FINGERPRINT_SECTIONS) {
    // A null from a column added before its backfill is "visible", not hidden.
    const stored = row[SECTION_COLUMNS[section]];
    if (stored === false) visibility[section] = false;
  }
  return visibility;
}

/** The sections to leave out for a viewer who is not the owner. */
export function hiddenSections(row: ProfileSettings | undefined | null): FingerprintSection[] {
  const visibility = visibilityOf(row);
  return FINGERPRINT_SECTIONS.filter((section) => !visibility[section]);
}

export interface VisibilityPatch {
  patch: Partial<Visibility>;
}

export interface VisibilityPatchError {
  error: string;
}

/**
 * Validate a PUT body into a patch.
 *
 * Strict about keys AND values: an unknown section or a non-boolean is a 400
 * rather than an ignored field. A settings page that sends `{ rigns: false }`
 * and gets a 200 would show the user a toggle that does nothing, and they
 * would believe a section was hidden when it is not.
 */
export function parseVisibilityPatch(body: unknown): VisibilityPatch | VisibilityPatchError {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Expected an object of section → boolean' };
  }

  const known = new Set<string>(FINGERPRINT_SECTIONS);
  const patch: Partial<Visibility> = {};

  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (!known.has(key)) {
      return { error: `Unknown section '${key}'. Known: ${FINGERPRINT_SECTIONS.join(', ')}` };
    }
    if (typeof value !== 'boolean') {
      return { error: `Section '${key}' must be true or false` };
    }
    patch[key as FingerprintSection] = value;
  }

  if (Object.keys(patch).length === 0) return { error: 'Nothing to change' };
  return { patch };
}

/** The owner's current settings, defaulted when they have never set any. */
export async function getVisibility(userId: string, database: AppDb = db): Promise<Visibility> {
  const row = await database
    .select()
    .from(profileSettings)
    .where(eq(profileSettings.userId, userId))
    .get();
  return visibilityOf(row);
}

/**
 * Apply a patch and return the settings as they now stand.
 *
 * An upsert, because the row is created lazily: the common case is a user who
 * has never opened the settings page, and giving every signup a row of defaults
 * would be a write for a value that is already the default.
 */
export async function setVisibility(
  userId: string,
  patch: Partial<Visibility>,
  database: AppDb = db
): Promise<Visibility> {
  const columns: Partial<Record<SectionColumn, boolean>> = {};
  for (const [section, visible] of Object.entries(patch) as [FingerprintSection, boolean][]) {
    columns[SECTION_COLUMNS[section]] = visible;
  }

  await database
    .insert(profileSettings)
    .values({ userId, ...columns, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: profileSettings.userId,
      set: { ...columns, updatedAt: new Date() },
    });

  return getVisibility(userId, database);
}
