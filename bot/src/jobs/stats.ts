/**
 * Stats Collection Job
 * Collects npm + brew download stats and posts weekly summaries
 */

import { db } from '../db';
import { downloadStats, versions } from '../db/schema';
import { eq, gte, desc } from 'drizzle-orm';
import { fetchNpmDownloads } from '../watchers/npm';
import { fetchBrewCaskInfo } from '../watchers/brew';
import { getClient } from '../publishers/twitter';
import { generateWeeklySummary } from '../ai/formatter';

const log = {
  info: (msg: string) => console.log(`[${new Date().toISOString()}] INFO: ${msg}`),
  error: (msg: string) => console.error(`[${new Date().toISOString()}] ERROR: ${msg}`),
};

/**
 * Collect today's stats
 */
export async function collectStats(): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  log.info(`Collecting stats for ${today}`);

  try {
    // Fetch npm downloads
    const npm = await fetchNpmDownloads('last-week');
    log.info(`npm downloads (last week): ${npm.downloads}`);

    // Fetch brew stats
    const brew = await fetchBrewCaskInfo();
    log.info(`brew installs (30d): ${brew.installs30d}`);

    // Upsert stats
    const existing = await db.query.downloadStats.findFirst({
      where: eq(downloadStats.date, today),
    });

    if (existing) {
      await db.update(downloadStats)
        .set({
          npmDownloads: npm.downloads,
          brewInstalls30d: brew.installs30d,
          brewInstalls90d: brew.installs90d,
          brewInstalls365d: brew.installs365d,
        })
        .where(eq(downloadStats.date, today));
    } else {
      await db.insert(downloadStats).values({
        date: today,
        npmDownloads: npm.downloads,
        brewInstalls30d: brew.installs30d,
        brewInstalls90d: brew.installs90d,
        brewInstalls365d: brew.installs365d,
      });
    }

    log.info('Stats collected successfully');
  } catch (error) {
    log.error(`Failed to collect stats: ${error}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// WEEKLY SUMMARY
// Posted every Sunday with version bumps, highlights, and download stats
// ═══════════════════════════════════════════════════════════════════════════

export interface WeeklyData {
  dateRange: string;
  // Versions
  versions: {
    version: string;
    highlights: string[];  // Top 3 changes
  }[];
  // Downloads
  npm: {
    current: number;
    previous: number | null;
    change: number | null;  // percentage
  };
  brew: {
    installs30d: number;
    installs90d: number;
  };
}

/**
 * Gather all data for the weekly summary
 */
export async function gatherWeeklyData(): Promise<WeeklyData | null> {
  const today = new Date();
  const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
  const twoWeeksAgo = new Date(today.getTime() - 14 * 24 * 60 * 60 * 1000);

  const todayStr = today.toISOString().split('T')[0];
  const weekAgoStr = weekAgo.toISOString().split('T')[0];

  // Get versions released this week
  const versionsThisWeek = await db.query.versions.findMany({
    where: gte(versions.brewDetectedAt, weekAgo),
    orderBy: desc(versions.brewDetectedAt),
  });

  // Extract highlights from each version's parsed notes
  const versionData = versionsThisWeek.map(v => {
    let highlights: string[] = [];

    if (v.parsedNotes) {
      try {
        const parsed = JSON.parse(v.parsedNotes);
        // Take top 2 from added, top 1 from fixed
        highlights = [
          ...(parsed.added || []).slice(0, 2),
          ...(parsed.fixed || []).slice(0, 1),
        ].slice(0, 3);
      } catch {
        // Ignore parse errors
      }
    }

    return {
      version: v.version,
      highlights,
    };
  });

  // Get download stats
  const thisWeekStats = await db.query.downloadStats.findFirst({
    where: eq(downloadStats.date, todayStr),
  });

  const lastWeekStats = await db.query.downloadStats.findFirst({
    where: eq(downloadStats.date, weekAgoStr),
  });

  if (!thisWeekStats) {
    // Try to fetch fresh stats
    await collectStats();
    return gatherWeeklyData();  // Retry once
  }

  // Calculate npm change
  let npmChange: number | null = null;
  if (lastWeekStats?.npmDownloads && thisWeekStats.npmDownloads) {
    npmChange = ((thisWeekStats.npmDownloads - lastWeekStats.npmDownloads) / lastWeekStats.npmDownloads) * 100;
  }

  return {
    dateRange: `${weekAgoStr.slice(5)} - ${todayStr.slice(5)}`,
    versions: versionData,
    npm: {
      current: thisWeekStats.npmDownloads || 0,
      previous: lastWeekStats?.npmDownloads || null,
      change: npmChange,
    },
    brew: {
      installs30d: thisWeekStats.brewInstalls30d || 0,
      installs90d: thisWeekStats.brewInstalls90d || 0,
    },
  };
}

/**
 * Post weekly stats summary as a thread
 */
export async function postWeeklyStats(): Promise<void> {
  log.info('Posting weekly summary');

  try {
    const data = await gatherWeeklyData();
    if (!data) {
      log.info('No data for weekly summary');
      return;
    }

    const twitter = getClient();
    const tweets: string[] = [];

    // ─────────────────────────────────────────────────────────────────────────
    // Tweet 1: Header + Downloads
    // ─────────────────────────────────────────────────────────────────────────
    let header = `📊 Claude Code Weekly (${data.dateRange})\n\n`;

    // npm with change
    header += `npm: ${formatNumber(data.npm.current)}`;
    if (data.npm.change !== null) {
      const sign = data.npm.change >= 0 ? '+' : '';
      const arrow = data.npm.change >= 0 ? '↑' : '↓';
      header += ` (${sign}${data.npm.change.toFixed(1)}% ${arrow})`;
    }
    header += '\n';

    // brew
    header += `brew: ${formatNumber(data.brew.installs30d)} (30d)\n\n`;

    // Version count
    if (data.versions.length > 0) {
      header += `${data.versions.length} version${data.versions.length > 1 ? 's' : ''} released`;
      if (data.versions.length <= 3) {
        header += `: ${data.versions.map(v => v.version).join(', ')}`;
      }
    } else {
      header += 'No new versions this week';
    }

    tweets.push(header);

    // ─────────────────────────────────────────────────────────────────────────
    // Tweet 2: Top Highlights (if we have versions with changes)
    // ─────────────────────────────────────────────────────────────────────────
    const allHighlights = data.versions
      .flatMap(v => v.highlights)
      .filter(h => h.length > 0)
      .slice(0, 5);

    if (allHighlights.length > 0) {
      let highlights = '✨ Highlights\n\n';

      for (const h of allHighlights) {
        const bullet = `• ${h.slice(0, 70)}${h.length > 70 ? '...' : ''}\n`;
        if (highlights.length + bullet.length > 270) break;
        highlights += bullet;
      }

      tweets.push(highlights.trim());
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Tweet 3: AI-generated summary (optional, if significant changes)
    // ─────────────────────────────────────────────────────────────────────────
    if (allHighlights.length >= 3) {
      try {
        const summary = await generateWeeklySummary(data);
        if (summary && summary.length > 20) {
          tweets.push(summary);
        }
      } catch (error) {
        log.info('AI summary skipped: ' + error);
        // Non-critical, continue without AI summary
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Tweet 4: CTA
    // ─────────────────────────────────────────────────────────────────────────
    tweets.push(`Track your Claude Code usage: clawd.gg\n\nFull changelog: github.com/anthropics/claude-code/releases`);

    // Post thread
    const posted = await twitter.thread(tweets);
    log.info(`Weekly summary posted: ${posted.length} tweets, first: ${posted[0]?.id}`);

  } catch (error) {
    log.error(`Failed to post weekly summary: ${error}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function formatChange(current: number, previous: number): string {
  const diff = current - previous;
  const pct = ((diff / previous) * 100).toFixed(1);
  const sign = diff >= 0 ? '+' : '';
  const arrow = diff >= 0 ? '↑' : '↓';
  return `${sign}${pct}% ${arrow}`;
}
