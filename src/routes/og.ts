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
import { hiddenFor } from '../lib/profile-settings';
import { publicFingerprint } from '../lib/public-fingerprint';
import { fetchProfileUser } from '../lib/profile-data';
import { shareCardFrom } from '../lib/share-card';
import { cardPng } from '../lib/card-png';
import { ShareCard } from '../components/profile/ShareCard';
import { TtlCache } from '../lib/ttl-cache';

const og = new Hono();

/**
 * Ten minutes fresh, then a DAY of stale window.
 *
 * A popular link pasted into a busy channel can be fetched many times in a
 * second and each miss is the whole fingerprint fan-out, while nothing on the
 * card moves in ten minutes. Longer than the HTTP max-age below on purpose:
 * this one is OURS to evict when the owner changes a toggle (evictCardCache),
 * and the header's is not.
 *
 * The day behind it is about ONE crawler in particular. A cold card.png was
 * 8.1 s measured on prod, and X's unfurler gives up long before that — so a
 * link posted ten minutes after the last fetch unfurled with no image at all.
 * Inside the window the crawler is answered from the last build immediately
 * and the rebuild happens behind it. A day is long because an image that is a
 * few hours old is the correct trade against an unfurl that never renders;
 * what it is NOT is a licence for anyone else to hold it that long — see
 * CARD_CACHE_CONTROL, which stays at a minute — and an owner hiding a section
 * evicts this cache outright (TtlCache.delete drops the stale value too).
 */
const CARD_TTL_MS = 10 * 60_000;
const CARD_STALE_MS = 24 * 60 * 60_000;
const cardCache = new TtlCache<string>(CARD_TTL_MS, 500, {
  staleMs: CARD_STALE_MS,
  name: 'card',
});

/**
 * Rasterised cards, keyed by the SVG that produced them rather than by user.
 *
 * The SVG is a pure function of the visibility-filtered payload, so its hash
 * is that payload's hash: a card that has not changed is not rasterised
 * again, and one that has cannot be served from a stale entry. A throw is
 * never cached — TtlCache only remembers what resolves — so a failed render
 * is retried rather than pinned.
 *
 * Which is also why this one gets a plain day-long TTL and NO stale window.
 * A content-addressed key cannot go stale — there is nothing to revalidate
 * against, and a stale-serve here would re-rasterise identical bytes — so the
 * only question is how long to keep them. A day, with a tighter entry budget
 * than the default because these are PNGs rather than strings.
 */
const pngCache = new TtlCache<Uint8Array>(CARD_TTL_MS + CARD_STALE_MS, 200);

/**
 * Forget the card this user's settings produced.
 *
 * Called by PUT /api/me/profile-settings. `pngCache` needs no eviction: it is
 * keyed by the hash of the SVG it rasterised, so a changed card is a changed
 * key and a stale entry is unreachable rather than stale.
 */
export function evictCardCache(userId: string): void {
  cardCache.deletePrefix(`${userId}|`);
}

/**
 * The card's SVG for a username, or null if there is no such user.
 *
 * Throws if the fingerprint cannot be built, which the routes turn into a
 * 503 — see the note on the placeholder below.
 */
async function cardSvgFor(username: string, rebuild = false): Promise<string | null> {
  const user = await fetchProfileUser(username);
  if (!user) return null;

  const hidden = await hiddenFor(user.id);

  const build = async () => {
    // The SHARED public fingerprint — the same payload the page and the API
    // serve, so this card costs no fan-out of its own when either has been
    // asked for recently. Always the public view, whoever is asking, which is
    // structural rather than an argument here: src/lib/public-fingerprint.ts
    // takes no owner flag and so keeps the zone name out of this drawing.
    const data = await publicFingerprint(user, hidden);

    return String(ShareCard({ card: shareCardFrom(data, { username: user.githubUsername }) }));
  };

  // The hidden list is IN THE KEY, not just evicted on save — the reason is
  // written out at the fingerprint cache in src/routes/api.ts: eviction alone
  // loses the race against a build that was already in flight when the toggle
  // was saved, and this cache holds the IMAGE that unfurlers go and fetch.
  const key = `${user.id}|${hidden.join(',')}`;
  return rebuild ? cardCache.refresh(key, build) : cardCache.remember(key, build);
}

/** The PNG cache's key: the hash of the drawing, not the user. */
function pngKey(svg: string): string {
  return Bun.hash(svg).toString(36);
}

/**
 * Rebuild one user's card now, through the routes' own builds and keys.
 *
 * For src/lib/warm.ts, and the reason the warmer exists at all: a cold card
 * takes seconds and X's unfurler will not wait for it, so the card has to be
 * warm BEFORE the link is posted rather than one fetch after.
 *
 * The SVG is forced; the PNG is not. `pngCache` is keyed by the hash of the
 * markup it rasterised, so an unchanged card is already there and re-doing it
 * would burn resvg on identical bytes.
 */
export async function warmCard(username: string): Promise<void> {
  const svg = await cardSvgFor(username, true);
  if (svg === null) return;
  await pngCache.remember(pngKey(svg), async () => cardPng(svg));
}

/**
 * A minute, and NO `stale-while-revalidate`.
 *
 * This is the one cache on the card that nobody here can evict: it lives in
 * whatever CDN, proxy or unfurler fetched the image. It used to say
 * `stale-while-revalidate=86400`, which licensed every one of them to keep
 * serving yesterday's card for a day — so an owner who hid 💎 watched the
 * figure they had just taken down go on being unfurled into other people's
 * channels, with nothing on this side able to stop it. A minute still absorbs
 * the burst a pasted link causes (and the ten-minute in-process cache behind
 * it absorbs the fan-out), while bounding that window to a minute.
 */
const CARD_CACHE_CONTROL = 'public, max-age=60';

/**
 * An SVG served from our own origin is a document, not just a picture: it can
 * carry script and it is same-origin with the session cookie. Nothing in
 * ShareCard emits either, so these are the belt to that braces — and the local
 * equivalent of what Caddy adds in production (the Caddyfile sets nosniff
 * site-wide; this route says it whoever is in front of it).
 */
const SVG_SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'",
} as const;

og.get('/:username/card.svg', async (c) => {
  const username = c.req.param('username');

  try {
    const svg = await cardSvgFor(username);
    if (svg === null) return c.text('No such user', 404);

    return c.body(svg, 200, {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': CARD_CACHE_CONTROL,
      ...SVG_SECURITY_HEADERS,
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

    const png = await pngCache.remember(pngKey(svg), async () => cardPng(svg));

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
