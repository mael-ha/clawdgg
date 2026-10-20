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
import { fetchProfileUser, type ProfileUser } from '../lib/profile-data';
import { shareCardFrom } from '../lib/share-card';
import { cardPng } from '../lib/card-png';
import { ShareCard } from '../components/profile/ShareCard';
import { TtlCache } from '../lib/ttl-cache';
import { recordSnapshotAge } from '../lib/request-timing';

const og = new Hono();

/**
 * Kept until replaced, for up to a day.
 *
 * A popular link pasted into a busy channel can be fetched many times in a
 * second, and X's unfurler gives up long before a cold card.png is drawn (8.1 s
 * measured on prod) — what it caches then is the failure. So a card that has
 * been asked for is kept, and rebuilt by src/jobs/refresh-pages.ts when the
 * owner's data changes, rather than expiring and making the next crawler wait.
 * The day is a safety net for a change nobody marked; an owner hiding a section
 * evicts this cache outright (evictCardCache), and the HTTP max-age below stays
 * at a minute for everyone else's copies.
 */
const CARD_MAX_AGE_MS = 24 * 60 * 60_000;
const cardCache = new TtlCache<string>(CARD_MAX_AGE_MS, 500);

/** How long after its last request a card is still rebuilt when its data changes. */
const CARD_REQUESTED_MS = 24 * 60 * 60_000;

/**
 * When each user's card.png was last asked for. The SVG cache knows when the
 * card was read, but not in which encoding, and rasterising a PNG nobody
 * fetches is the most expensive thing a refresh could do for nothing.
 */
const pngRequestedAt = new Map<string, number>();

/**
 * Rasterised cards, keyed by the SVG that produced them rather than by user.
 *
 * The SVG is a pure function of the visibility-filtered payload, so its hash
 * is that payload's hash: a card that has not changed is not rasterised
 * again, and one that has cannot be served from a stale entry. A throw is
 * never cached — TtlCache only remembers what resolves — so a failed render
 * is retried rather than pinned.
 *
 * A content-addressed key cannot go stale — there is nothing to revalidate
 * against — so the only question is how long to keep them. A day, with a
 * tighter entry budget than the default because these are PNGs rather than
 * strings.
 */
const pngCache = new TtlCache<Uint8Array>(CARD_MAX_AGE_MS, 200);

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
 * The card's SVG for a user, through the cache.
 *
 * Throws if the fingerprint cannot be built, which the routes turn into a
 * 503 — see the note on the placeholder below.
 */
async function cardSvgFor(
  user: ProfileUser,
  rebuild = false
): Promise<{ svg: string; key: string }> {
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
  const svg = rebuild ? await cardCache.refresh(key, build) : await cardCache.remember(key, build);
  return { svg, key };
}

/** The PNG cache's key: the hash of the drawing, not the user. */
function pngKey(svg: string): string {
  return Bun.hash(svg).toString(36);
}

/**
 * Rebuild one user's card now, through the routes' own builds and keys — if it
 * has been asked for in the last day. For src/jobs/refresh-pages.ts, after the
 * user's rows changed: a card has to be current BEFORE the next crawler
 * fetches it, because the crawler will not wait for it to be drawn.
 *
 * The PNG only if card.png itself was asked for. `pngCache` is keyed by the
 * hash of the markup it rasterised, so an unchanged card costs nothing there.
 */
export async function refreshCard(user: ProfileUser): Promise<void> {
  const hidden = await hiddenFor(user.id);
  const key = `${user.id}|${hidden.join(',')}`;
  const now = Date.now();
  const pngAt = pngRequestedAt.get(user.id);
  const wantsPng = pngAt !== undefined && now - pngAt <= CARD_REQUESTED_MS;
  if (pngAt !== undefined && !wantsPng) pngRequestedAt.delete(user.id);
  if (!wantsPng && !cardCache.readWithin(key, CARD_REQUESTED_MS)) return;

  const { svg } = await cardSvgFor(user, true);
  if (wantsPng) await pngCache.remember(pngKey(svg), async () => cardPng(svg));
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
 * the burst a pasted link causes (and the in-process cache behind it absorbs
 * the fan-out), while bounding that window to a minute.
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
    const user = await fetchProfileUser(username);
    if (!user) return c.text('No such user', 404);

    const { svg, key } = await cardSvgFor(user);
    recordSnapshotAge(cardCache.ageMs(key) ?? 0);

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
    const user = await fetchProfileUser(username);
    if (!user) return c.text('No such user', 404);

    pngRequestedAt.set(user.id, Date.now());
    const { svg, key } = await cardSvgFor(user);
    recordSnapshotAge(cardCache.ageMs(key) ?? 0);
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
