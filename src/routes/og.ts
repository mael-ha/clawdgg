/**
 * GET /u/:username/card.svg and card.png — the 1200×630 link-preview card.
 *
 * Mounted apart from the profile route because it serves an IMAGE: no
 * Layout, no session, no islands, its own cache headers and its own cache.
 *
 * ONE DRAWING, TWO ENCODINGS. The SVG is the source; the PNG is that same
 * markup through resvg. There is no second layout to drift, and no figure
 * that can appear on one and not the other.
 *
 * The PNG exists because X will not unfurl an SVG og:image — it is what the
 * meta tags point at, and what everything else unfurls too. It cost a
 * vendored JetBrains Mono and a vendored set of Twemoji glyphs: resvg has no
 * system fonts in the production image and cannot draw a colour-emoji font in
 * any image, so the card carries its own type and inlines its emoji as
 * artwork (src/assets/og/README.md). The price is Twitter's emoji faces on a
 * card that represents the brand, which is a decision that was taken, not an
 * accident. The SVG stays served for anything that prefers vectors.
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
import { cardPng } from '../lib/card-png';
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

/**
 * Rasterised cards, keyed by the SVG that produced them rather than by user.
 *
 * The SVG is a pure function of the visibility-filtered payload, so its hash
 * is that payload's hash: a card that has not changed is not rasterised
 * again, and one that has cannot be served from a stale entry. A throw is
 * never cached — TtlCache only remembers what resolves — so a failed render
 * is retried rather than pinned for ten minutes.
 */
const pngCache = new TtlCache<Uint8Array>(CARD_TTL_MS);

/**
 * The card's SVG for a username, or null if there is no such user.
 *
 * Throws if the fingerprint cannot be built, which the routes turn into a
 * 503 — see the note on the placeholder below.
 */
async function cardSvgFor(username: string): Promise<string | null> {
  const user = await fetchProfileUser(username);
  if (!user) return null;

  return cardCache.remember(user.id, async () => {
    const settings = await db
      .select()
      .from(profileSettings)
      .where(eq(profileSettings.userId, user.id))
      .get();

    const data = await getFingerprint(user.id, {
      username: user.githubUsername,
      timezone: user.timezone,
      // Always the public view, whoever is asking — which also keeps the
      // zone name out of the payload this card is built from.
      isOwner: false,
      hidden: hiddenSections(settings),
    });

    return String(ShareCard({ card: shareCardFrom(data, { username: user.githubUsername }) }));
  });
}

// Short on the CDN, longer for the unfurlers that respect it, and
// stale-while-revalidate so a pasted link never waits on a fan-out.
const CARD_CACHE_CONTROL = 'public, max-age=600, stale-while-revalidate=86400';

og.get('/:username/card.svg', async (c) => {
  const username = c.req.param('username');

  try {
    const svg = await cardSvgFor(username);
    if (svg === null) return c.text('No such user', 404);

    return c.body(svg, 200, {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': CARD_CACHE_CONTROL,
    });
  } catch (error) {
    console.error(`[card] ${username}:`, error);
    // No placeholder card: an unfurler that caches a "something went wrong"
    // image keeps showing it for days. A 503 is retried.
    return c.text('Card unavailable', 503);
  }
});

og.get('/:username/card.png', async (c) => {
  const username = c.req.param('username');

  try {
    const svg = await cardSvgFor(username);
    if (svg === null) return c.text('No such user', 404);

    const png = await pngCache.remember(Bun.hash(svg).toString(36), async () => cardPng(svg));

    return new Response(png, {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': CARD_CACHE_CONTROL,
      },
    });
  } catch (error) {
    console.error(`[card.png] ${username}:`, error);
    return c.text('Card unavailable', 503);
  }
});

export default og;
