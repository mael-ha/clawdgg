/**
 * Claude Code X Bot
 * Automated Twitter account for Claude Code updates
 *
 * Usage:
 *   bun bot/src/index.ts           # Run once
 *   bun bot/src/index.ts --daemon  # Run as daemon with cron
 *   bun bot/src/index.ts --stats   # Collect stats only
 *   bun bot/src/index.ts --weekly  # Post weekly summary
 */

import { checkForNewVersion, recheckIncompleteVersions } from './jobs/version-check';
import { collectStats, postWeeklyStats } from './jobs/stats';

const log = {
  info: (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`),
  error: (msg: string) => console.error(`[${new Date().toISOString()}] ERROR: ${msg}`),
};

// ═══════════════════════════════════════════════════════════════════════════
// CRON INTERVALS
// ═══════════════════════════════════════════════════════════════════════════

const INTERVALS = {
  VERSION_CHECK: 60 * 1000,        // 1 minute
  INCOMPLETE_RECHECK: 5 * 60 * 1000, // 5 minutes
  STATS_COLLECTION: 60 * 60 * 1000,  // 1 hour
};

// ═══════════════════════════════════════════════════════════════════════════
// DAEMON MODE
// ═══════════════════════════════════════════════════════════════════════════

async function runDaemon(): Promise<void> {
  log.info('Starting Claude Code X Bot daemon...');

  // Initial run
  await runOnce();

  // Set up intervals
  setInterval(async () => {
    try {
      await checkForNewVersion();
    } catch (error) {
      log.error(`Version check failed: ${error}`);
    }
  }, INTERVALS.VERSION_CHECK);

  setInterval(async () => {
    try {
      await recheckIncompleteVersions();
    } catch (error) {
      log.error(`Incomplete recheck failed: ${error}`);
    }
  }, INTERVALS.INCOMPLETE_RECHECK);

  setInterval(async () => {
    try {
      await collectStats();
    } catch (error) {
      log.error(`Stats collection failed: ${error}`);
    }
  }, INTERVALS.STATS_COLLECTION);

  log.info('Daemon running. Press Ctrl+C to stop.');

  // Keep process alive
  await new Promise(() => {});
}

// ═══════════════════════════════════════════════════════════════════════════
// ONE-SHOT MODE
// ═══════════════════════════════════════════════════════════════════════════

async function runOnce(): Promise<void> {
  log.info('Running version check...');
  await checkForNewVersion();

  log.info('Checking incomplete versions...');
  await recheckIncompleteVersions();

  log.info('Collecting stats...');
  await collectStats();

  log.info('Done.');
}

// ═══════════════════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Environment check
  if (!process.env.DRY_RUN && !process.env.TWITTER_API_KEY) {
    log.info('TWITTER_API_KEY not set, running in DRY_RUN mode');
    process.env.DRY_RUN = 'true';
  }

  if (args.includes('--daemon') || args.includes('-d')) {
    await runDaemon();
  } else if (args.includes('--stats')) {
    await collectStats();
  } else if (args.includes('--weekly')) {
    await postWeeklyStats();
  } else if (args.includes('--help') || args.includes('-h')) {
    showHelp();
  } else {
    await runOnce();
  }
}

function showHelp(): void {
  console.log(`
Claude Code X Bot

Usage:
  bun bot/src/index.ts [options]

Options:
  --daemon, -d    Run as daemon with scheduled checks
  --stats         Collect stats only
  --weekly        Post weekly summary
  --help, -h      Show this help

Environment:
  TWITTER_API_KEY       Twitter API key
  TWITTER_API_SECRET    Twitter API secret
  TWITTER_ACCESS_TOKEN  Twitter access token
  TWITTER_ACCESS_SECRET Twitter access secret
  GITHUB_TOKEN          GitHub token (for higher rate limits)
  ANTHROPIC_API_KEY     Anthropic API key (for AI formatting)
  DRY_RUN=true          Don't actually post to Twitter
  DEBUG=true            Enable debug logging

Examples:
  # Test run (dry run mode)
  DRY_RUN=true bun bot/src/index.ts

  # Production daemon
  bun bot/src/index.ts --daemon

  # Post weekly stats manually
  bun bot/src/index.ts --weekly
`);
}

main().catch((error) => {
  log.error(`Fatal error: ${error}`);
  process.exit(1);
});
