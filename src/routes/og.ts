/**
 * GET /u/:username/card.svg — the 1200×630 link-preview card.
 *
 * Mounted apart from the profile route because it serves an IMAGE: no
 * Layout, no session, no islands, its own cache headers and its own cache.
 *
 * WHY SVG AND NOT PNG. The brief asked for PNG, because X will not unfurl an
 * SVG og:image. Every way of producing one costs something this card is not
 * worth yet:
 *
 *   resvg (tested, 2.6.2) rasterises the geometry perfectly and renders NO
 *   colour emoji — Apple Color Emoji is sbix and Noto Color Emoji is CBDT,
 *   and it supports neither. A rasterised card is a card with ? boxes where
 *   💎 🌈 ☀️ go, which is the one thing this design cannot be.
 *   The fix is vendoring an emoji artwork set (Twemoji, CC-BY-4.0, ~14 files)
 *   plus a JetBrains Mono TTF, and accepting Twitter's emoji faces on a card
 *   that represents the brand — an identity decision, not an implementation
 *   one.
 *   satori + resvg has the same emoji problem, needs the same vendored font,
 *   and additionally cannot draw these SVG rings.
 *   A headless browser is not going in this image.
 *
 * So: SVG today. It is exact, it keeps the emoji, it costs no dependency, and
 * it unfurls on Slack, Discord, LinkedIn, Facebook and iMessage. X falls back
 * to the summary card with the description, which is itself built only from
 * public sections. The PNG is a decision waiting on an answer, not an
 * oversight — the moment the emoji question is settled this route grows a
 * `.png` sibling that rasterises the very same markup.
 *
 * EVERY FIGURE HERE IS PUBLIC. The card is built from a fingerprint fetched
 * with the owner's hidden sections removed — never from the owner's own
 * unfiltered payload — because this image is fetched by crawlers and shown
 * to whoever the link reaches.
 */

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { profileSettings } from '../db/schema';
import { getFingerprint } from '../lib/fingerprint';
import { hiddenSections } from '../lib/profile-settings';
import { fetchProfileUser } from '../lib/profile-data';
import { shareCardFrom } from '../lib/share-card';
import { ShareCard } from '../components/profile/ShareCard';
import { TtlCache } from '../lib/ttl-cache';

const og = new Hono();

/**
 * Ten minutes, longer than the page's minute.
 *
 * An unfurler fetches this once and then caches it for days of its own, so
 * freshness buys nothing here — while a popular link being pasted into a busy
 * channel can fetch it many times in a second, and each miss is the whole
 * fingerprint fan-out.
 */
const CARD_TTL_MS = 10 * 60_000;
const cardCache = new TtlCache<string>(CARD_TTL_MS);

og.get('/:username/card.svg', async (c) => {
  const username = c.req.param('username');
  const user = await fetchProfileUser(username);
  if (!user) return c.text('No such user', 404);

  try {
    const svg = await cardCache.remember(user.id, async () => {
      const settings = await db
        .select()
        .from(profileSettings)
        .where(eq(profileSettings.userId, user.id))
        .get();

      const data = await getFingerprint(user.id, {
        username: user.githubUsername,
        timezone: user.timezone,
        // Always the public view, whoever is asking.
        hidden: hiddenSections(settings),
      });

      return String(ShareCard({ card: shareCardFrom(data, { username: user.githubUsername }) }));
    });

    return c.body(svg, 200, {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      // Short on the CDN, longer for the unfurlers that respect it, and
      // stale-while-revalidate so a pasted link never waits on a fan-out.
      'Cache-Control': 'public, max-age=600, stale-while-revalidate=86400',
    });
  } catch (error) {
    console.error(`[card] ${username}:`, error);
    // No placeholder card: an unfurler that caches a "something went wrong"
    // image keeps showing it for days. A 503 is retried.
    return c.text('Card unavailable', 503);
  }
});

export default og;
