/**
 * What the 1200×630 link-preview card says.
 *
 * Shaped from the PUBLIC fingerprint and nothing else. The card is the most
 * widely seen thing on the site — it goes wherever the link is pasted — so it
 * is built from a payload that has already had the owner's hidden sections
 * removed, and every part of it is optional: a section that is not in the
 * payload is not on the card, and the layout closes up around the gap.
 */

import type { FingerprintData } from './fingerprint';
import { className, type ClassName } from '../components/profile/palette';
import { group, money, perPrompt } from '../components/profile/format';
import {
  hoursRing,
  languagesRing,
  modelsRing,
  weekRing,
  type Ring,
} from '../components/profile/geometry';

export interface ShareCard {
  username: string;
  /** Two letters, because an avatar URL cannot be fetched from inside an
   *  <img>-loaded SVG — see the note in ShareCard.tsx. */
  initials: string;
  userClass: ClassName | null;
  /** Up to four rings, in the order they appear on the profile. */
  rings: Ring[];
  value: string | null;
  /** "170 chars → 9.6 tools → 36 lines", or null without an anatomy. */
  anatomy: string | null;
  ultrathinks: string | null;
}

export function shareCardFrom(
  data: FingerprintData,
  identity: { username: string }
): ShareCard {
  const rings: Ring[] = [];
  if (data.rings) {
    const r = data.rings;
    for (const ring of [
      hoursRing(r.hours, r.peakHour?.hour ?? null),
      weekRing(r.weekdays, r.busiestDay, r.weekdayShare),
      languagesRing(r.languages, r.topLanguage),
      modelsRing(r.models, r.topModel),
    ]) {
      // An empty dial on a share card is a dial nobody can read. The card
      // carries the rings that have something in them and centres the rest.
      if (!ring.empty) rings.push(ring);
    }
  }

  const figures = data.anatomy?.allTime;

  return {
    username: identity.username,
    initials: identity.username.slice(0, 2).toUpperCase(),
    userClass: className(data.class?.rhythm ?? null, data.class?.style ?? null),
    rings,
    // "$0" is noise, not a headline. A profile with nothing in it gets a
    // card with a handle on it, which is the honest version.
    value: data.value && data.value.allTime > 0 ? money(data.value.allTime) : null,
    anatomy:
      figures && figures.prompts > 0
        ? `${group(figures.medianPromptChars)} chars → ` +
          `${perPrompt(figures.toolCallsPerPrompt)} tools → ` +
          `${perPrompt(figures.linesPerPrompt)} lines`
        : null,
    ultrathinks:
      data.ultrathink && data.ultrathink.count > 0
        ? `🌈 ${group(data.ultrathink.count)} ultrathinks`
        : null,
  };
}
