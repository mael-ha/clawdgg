/**
 * Version Check Job
 *
 * Thread Structure:
 * 1. Summary Hook - version, counts, keywords, prompt status
 * 2. What's New - ALL features (split if >5)
 * 3. Fixes - ALL fixes (split if >5)
 * 4. Prompt Changes (w/ cchistory) - if any
 * 5. Links - changelog, prompt diff, clawd.gg
 *
 * Orchestration:
 * - Brew detected → Try GitHub (max 15 min wait) → Post thread
 * - If GitHub unavailable: Post "changelog pending" summary, update later
 * - When GitHub arrives later: Post "Update" tweet + detail tweets
 */

import { db } from '../db';
import { versions } from '../db/schema';
import { eq, and, ne, lt } from 'drizzle-orm';
import { getLatestBrewVersion } from '../watchers/brew';
import { fetchReleaseByVersion, parseReleaseNotes } from '../watchers/github';
import { getPromptChanges, type ParsedDiff } from '../watchers/cchistory';
import { getClient } from '../publishers/twitter';
import { createPromptDiffGist, mockCreateGist } from '../publishers/gist';
import {
  generateSummaryHook,
  generateWhatsNewTweets,
  generateFixesTweets,
  generatePromptChangesTweet,
  generateUpdateTweet,
  formatLinksTweet,
  fallbackSummaryHook,
  fallbackWhatsNewTweets,
  fallbackFixesTweets,
  fallbackPromptChangesTweet,
  fallbackUpdateTweet,
  type SummaryHookInput,
} from '../ai/formatter';

const log = {
  info: (msg: string) => console.log(`[${new Date().toISOString()}] INFO: ${msg}`),
  error: (msg: string) => console.error(`[${new Date().toISOString()}] ERROR: ${msg}`),
  debug: (msg: string) => process.env.DEBUG && console.log(`[${new Date().toISOString()}] DEBUG: ${msg}`),
};

// How long to wait for GitHub release before posting with "changelog pending"
const GITHUB_WAIT_MS = 15 * 60 * 1000; // 15 minutes

// How long to wait for changelog before giving up entirely
const CHANGELOG_GIVEUP_MS = 48 * 60 * 60 * 1000; // 48 hours

/**
 * Check for new versions and process them
 */
export async function checkForNewVersion(): Promise<void> {
  log.info('Checking for new Claude Code version...');

  try {
    // 1. Get latest from brew
    const brewLatest = await getLatestBrewVersion();
    if (!brewLatest) {
      log.info('No brew version found');
      return;
    }

    log.info(`Latest brew version: ${brewLatest.version}`);

    // 2. Check if we've already processed this version
    const existing = await db.query.versions.findFirst({
      where: eq(versions.version, brewLatest.version),
    });

    if (existing) {
      log.debug(`Version ${brewLatest.version} already tracked, status: ${existing.status}`);

      // Handle based on status
      switch (existing.status) {
        case 'complete':
          return; // Nothing to do

        case 'detected':
          // Still waiting for GitHub, check if we should proceed
          await handleDetectedVersion(existing);
          return;

        case 'announced':
          // Posted but might be missing details
          await handleAnnouncedVersion(existing);
          return;
      }

      return;
    }

    // 3. New version detected!
    log.info(`New version detected: ${brewLatest.version}`);

    // Create record
    await db.insert(versions).values({
      version: brewLatest.version,
      brewDetectedAt: brewLatest.date,
      status: 'detected',
    });

    // 4. Try to get GitHub release immediately
    const release = await fetchReleaseByVersion(brewLatest.version);

    if (release) {
      // GitHub available - post full thread
      log.info('GitHub release available, posting full thread');
      await postFullThread(brewLatest.version, release);
    } else {
      // No GitHub yet - wait or post pending
      log.info('No GitHub release yet, will wait up to 15 minutes');
      // The next checkForNewVersion() call will handle this via handleDetectedVersion()
    }

  } catch (error) {
    log.error(`Version check failed: ${error}`);
  }
}

/**
 * Handle a version that was detected but not yet posted
 */
async function handleDetectedVersion(version: typeof versions.$inferSelect): Promise<void> {
  // Check if GitHub release is now available
  const release = await fetchReleaseByVersion(version.version);

  if (release) {
    log.info(`GitHub release now available for ${version.version}`);
    await postFullThread(version.version, release);
    return;
  }

  // Check if we've waited long enough
  const waitedMs = Date.now() - (version.brewDetectedAt?.getTime() || Date.now());

  if (waitedMs >= GITHUB_WAIT_MS) {
    log.info(`Waited ${Math.round(waitedMs / 60000)} minutes, posting with pending changelog`);
    await postPendingThread(version.version);
  } else {
    log.info(`Still waiting for GitHub (${Math.round(waitedMs / 60000)} / 15 min)`);
  }
}

/**
 * Handle a version that was announced but might be missing details
 */
async function handleAnnouncedVersion(version: typeof versions.$inferSelect): Promise<void> {
  // If we have release notes, we're probably just missing the links tweet
  if (version.releaseNotes) {
    if (!version.linksTweetId) {
      await postRemainingTweets(version);
    }
    return;
  }

  // No release notes yet - check if GitHub is now available
  const release = await fetchReleaseByVersion(version.version);

  if (release) {
    log.info(`GitHub release now available for ${version.version}, posting update`);
    await postUpdateThread(version, release);
    return;
  }

  // Check if we've waited too long - give up and close the thread
  const waitedMs = Date.now() - (version.brewDetectedAt?.getTime() || Date.now());

  if (waitedMs >= CHANGELOG_GIVEUP_MS) {
    log.info(`No changelog after ${Math.round(waitedMs / 3600000)}h, closing thread for ${version.version}`);
    await closeThreadWithoutChangelog(version);
  }
}

/**
 * Post full thread when we have all data
 */
async function postFullThread(
  version: string,
  release: { notes: string; date: Date }
): Promise<void> {
  log.info(`Posting full thread for ${version}`);

  const twitter = getClient();
  const parsed = parseReleaseNotes(release.notes);

  // Save release data
  await db.update(versions)
    .set({
      releaseNotes: release.notes,
      parsedNotes: JSON.stringify(parsed),
      githubReleaseAt: release.date,
      updatedAt: new Date(),
    })
    .where(eq(versions.version, version));

  // Get prompt diff
  const { promptDiff, promptDiffUrl } = await getPromptDiff(version);

  // ═══════════════════════════════════════════════════════════════════════════
  // TWEET 1: SUMMARY HOOK (with full data)
  // ═══════════════════════════════════════════════════════════════════════════

  const summaryInput: SummaryHookInput = {
    version,
    features: parsed.added,
    fixes: parsed.fixed,
    promptDiff: promptDiff
      ? { added: promptDiff.added.length, removed: promptDiff.removed.length }
      : null,
    changelogPending: false,
  };

  let summaryText: string;
  try {
    summaryText = await generateSummaryHook(summaryInput);
  } catch (error) {
    log.error(`AI failed for summary hook: ${error}`);
    summaryText = fallbackSummaryHook(summaryInput);
  }

  const summaryTweet = await twitter.tweet(summaryText);
  let lastTweetId = summaryTweet.id;

  await db.update(versions)
    .set({
      announcementTweetId: summaryTweet.id,
      status: 'announced',
      updatedAt: new Date(),
    })
    .where(eq(versions.version, version));

  log.info(`Posted summary hook: ${summaryTweet.id}`);

  // Post detail tweets
  lastTweetId = await postDetailTweets(version, parsed, promptDiff, promptDiffUrl, lastTweetId);

  // ═══════════════════════════════════════════════════════════════════════════
  // TWEET 5: LINKS
  // ═══════════════════════════════════════════════════════════════════════════

  const changelogUrl = `https://github.com/anthropics/claude-code/releases/tag/v${version}`;
  const linksText = formatLinksTweet({ changelogUrl, promptDiffUrl });

  const linksTweet = await twitter.reply(lastTweetId, linksText);

  await db.update(versions)
    .set({
      linksTweetId: linksTweet.id,
      status: 'complete',
      updatedAt: new Date(),
    })
    .where(eq(versions.version, version));

  log.info(`Posted links: ${linksTweet.id}`);
  log.info(`Version ${version} thread complete`);
}

/**
 * Post thread when GitHub is not available yet
 */
async function postPendingThread(version: string): Promise<void> {
  log.info(`Posting pending thread for ${version}`);

  const twitter = getClient();

  // ═══════════════════════════════════════════════════════════════════════════
  // TWEET 1: SUMMARY HOOK (changelog pending)
  // ═══════════════════════════════════════════════════════════════════════════

  const summaryInput: SummaryHookInput = {
    version,
    features: [],
    fixes: [],
    promptDiff: null,
    changelogPending: true,
  };

  const summaryText = fallbackSummaryHook(summaryInput); // No AI needed for pending

  const summaryTweet = await twitter.tweet(summaryText);

  await db.update(versions)
    .set({
      announcementTweetId: summaryTweet.id,
      status: 'announced',
      updatedAt: new Date(),
    })
    .where(eq(versions.version, version));

  log.info(`Posted pending summary: ${summaryTweet.id}`);

  // Don't post links yet - wait for changelog
}

/**
 * Post update when changelog becomes available after initial pending post
 */
async function postUpdateThread(
  versionRecord: typeof versions.$inferSelect,
  release: { notes: string; date: Date }
): Promise<void> {
  log.info(`Posting update thread for ${versionRecord.version}`);

  const twitter = getClient();
  const parsed = parseReleaseNotes(release.notes);

  // Save release data
  await db.update(versions)
    .set({
      releaseNotes: release.notes,
      parsedNotes: JSON.stringify(parsed),
      githubReleaseAt: release.date,
      updatedAt: new Date(),
    })
    .where(eq(versions.version, versionRecord.version));

  // Get prompt diff
  const { promptDiff, promptDiffUrl } = await getPromptDiff(versionRecord.version);

  // ═══════════════════════════════════════════════════════════════════════════
  // UPDATE TWEET: Changelog now available!
  // ═══════════════════════════════════════════════════════════════════════════

  let updateText: string;
  try {
    updateText = await generateUpdateTweet({
      version: versionRecord.version,
      features: parsed.added,
      fixes: parsed.fixed,
    });
  } catch (error) {
    log.error(`AI failed for update tweet: ${error}`);
    updateText = fallbackUpdateTweet({
      version: versionRecord.version,
      features: parsed.added,
      fixes: parsed.fixed,
    });
  }

  // Reply to the original summary
  const updateTweet = await twitter.reply(versionRecord.announcementTweetId!, updateText);
  let lastTweetId = updateTweet.id;

  log.info(`Posted update tweet: ${updateTweet.id}`);

  // Post detail tweets
  lastTweetId = await postDetailTweets(
    versionRecord.version,
    parsed,
    promptDiff,
    promptDiffUrl,
    lastTweetId
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // LINKS TWEET
  // ═══════════════════════════════════════════════════════════════════════════

  const changelogUrl = `https://github.com/anthropics/claude-code/releases/tag/v${versionRecord.version}`;
  const linksText = formatLinksTweet({ changelogUrl, promptDiffUrl });

  const linksTweet = await twitter.reply(lastTweetId, linksText);

  await db.update(versions)
    .set({
      linksTweetId: linksTweet.id,
      status: 'complete',
      updatedAt: new Date(),
    })
    .where(eq(versions.version, versionRecord.version));

  log.info(`Posted links: ${linksTweet.id}`);
  log.info(`Version ${versionRecord.version} update complete`);
}

/**
 * Close a thread when changelog never arrives (after 48h)
 */
async function closeThreadWithoutChangelog(version: typeof versions.$inferSelect): Promise<void> {
  log.info(`Closing thread without changelog for ${version.version}`);

  const twitter = getClient();

  // Post a simple "no changelog" update
  const updateText = `No detailed changelog was released for ${version.version}.

Check the release page for any updates.`;

  const updateTweet = await twitter.reply(version.announcementTweetId!, updateText);

  // Post links
  const changelogUrl = `https://github.com/anthropics/claude-code/releases/tag/v${version.version}`;
  const linksText = formatLinksTweet({ changelogUrl });

  const linksTweet = await twitter.reply(updateTweet.id, linksText);

  await db.update(versions)
    .set({
      linksTweetId: linksTweet.id,
      status: 'complete',
      updatedAt: new Date(),
    })
    .where(eq(versions.version, version.version));

  log.info(`Closed thread for ${version.version} (no changelog)`);
}

/**
 * Post remaining tweets for an incomplete thread
 */
async function postRemainingTweets(version: typeof versions.$inferSelect): Promise<void> {
  // This handles edge cases where we have data but missing tweets
  // For now, just mark complete if we have the essentials
  if (version.announcementTweetId && version.releaseNotes) {
    const twitter = getClient();
    let lastTweetId = version.fixedTweetId || version.addedTweetId || version.announcementTweetId;

    if (!version.linksTweetId) {
      const changelogUrl = `https://github.com/anthropics/claude-code/releases/tag/v${version.version}`;
      const linksText = formatLinksTweet({
        changelogUrl,
        promptDiffUrl: version.promptDiffUrl || undefined,
      });

      const linksTweet = await twitter.reply(lastTweetId, linksText);

      await db.update(versions)
        .set({
          linksTweetId: linksTweet.id,
          status: 'complete',
          updatedAt: new Date(),
        })
        .where(eq(versions.version, version.version));

      log.info(`Posted missing links tweet for ${version.version}`);
    }
  }
}

/**
 * Post detail tweets (What's New, Fixes, Prompt Changes)
 */
async function postDetailTweets(
  version: string,
  parsed: { added: string[]; fixed: string[]; improved: string[] },
  promptDiff: ParsedDiff | null,
  promptDiffUrl: string | undefined,
  lastTweetId: string
): Promise<string> {
  const twitter = getClient();

  // ═══════════════════════════════════════════════════════════════════════════
  // WHAT'S NEW
  // ═══════════════════════════════════════════════════════════════════════════

  if (parsed.added.length > 0) {
    let whatsNewTweets: string[];
    try {
      whatsNewTweets = await generateWhatsNewTweets(parsed.added);
    } catch (error) {
      log.error(`AI failed for what's new: ${error}`);
      whatsNewTweets = fallbackWhatsNewTweets(parsed.added);
    }

    for (const text of whatsNewTweets) {
      const tweet = await twitter.reply(lastTweetId, text);
      lastTweetId = tweet.id;
      log.info(`Posted what's new: ${tweet.id}`);
    }

    await db.update(versions)
      .set({ addedTweetId: lastTweetId, updatedAt: new Date() })
      .where(eq(versions.version, version));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FIXES
  // ═══════════════════════════════════════════════════════════════════════════

  if (parsed.fixed.length > 0) {
    let fixesTweets: string[];
    try {
      fixesTweets = await generateFixesTweets(parsed.fixed);
    } catch (error) {
      log.error(`AI failed for fixes: ${error}`);
      fixesTweets = fallbackFixesTweets(parsed.fixed);
    }

    for (const text of fixesTweets) {
      const tweet = await twitter.reply(lastTweetId, text);
      lastTweetId = tweet.id;
      log.info(`Posted fixes: ${tweet.id}`);
    }

    await db.update(versions)
      .set({ fixedTweetId: lastTweetId, updatedAt: new Date() })
      .where(eq(versions.version, version));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PROMPT CHANGES
  // ═══════════════════════════════════════════════════════════════════════════

  if (promptDiff && (promptDiff.added.length > 0 || promptDiff.removed.length > 0)) {
    let promptText: string | null;
    try {
      promptText = await generatePromptChangesTweet(promptDiff);
    } catch (error) {
      log.error(`AI failed for prompt changes: ${error}`);
      promptText = fallbackPromptChangesTweet(promptDiff);
    }

    if (promptText) {
      const tweet = await twitter.reply(lastTweetId, promptText);
      lastTweetId = tweet.id;

      await db.update(versions)
        .set({ promptTweetId: tweet.id, updatedAt: new Date() })
        .where(eq(versions.version, version));

      log.info(`Posted prompt changes: ${tweet.id}`);
    }
  }

  return lastTweetId;
}

/**
 * Get prompt diff between versions
 */
async function getPromptDiff(version: string): Promise<{
  promptDiff: ParsedDiff | null;
  promptDiffUrl: string | undefined;
}> {
  try {
    const allVersions = await db.query.versions.findMany({
      orderBy: (v, { desc }) => [desc(v.brewDetectedAt)],
      limit: 2,
    });

    if (allVersions.length >= 2) {
      const prevVersion = allVersions[1].version;
      log.info(`Getting prompt diff: ${prevVersion} → ${version}`);

      const promptDiff = await getPromptChanges(prevVersion, version);

      if (promptDiff.added.length > 0 || promptDiff.removed.length > 0) {
        let promptDiffUrl: string;
        if (process.env.DRY_RUN === 'true') {
          promptDiffUrl = mockCreateGist(prevVersion, version, promptDiff.raw);
        } else {
          promptDiffUrl = await createPromptDiffGist(prevVersion, version, promptDiff.raw);
        }

        await db.update(versions)
          .set({
            promptDiff: promptDiff.raw,
            promptDiffUrl,
            promptDiffAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(versions.version, version));

        return { promptDiff, promptDiffUrl };
      }

      log.info('No significant prompt changes');
    }
  } catch (error) {
    log.error(`Failed to get prompt diff: ${error}`);
  }

  return { promptDiff: null, promptDiffUrl: undefined };
}

/**
 * Recheck versions that are not complete
 */
export async function recheckIncompleteVersions(): Promise<void> {
  const incomplete = await db.query.versions.findMany({
    where: ne(versions.status, 'complete'),
    orderBy: (v, { desc }) => [desc(v.brewDetectedAt)],
    limit: 5,
  });

  for (const version of incomplete) {
    log.info(`Rechecking incomplete version: ${version.version}`);

    switch (version.status) {
      case 'detected':
        await handleDetectedVersion(version);
        break;
      case 'announced':
        await handleAnnouncedVersion(version);
        break;
    }
  }
}
