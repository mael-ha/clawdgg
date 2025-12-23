/**
 * AI Formatter
 * Uses Claude to generate tweet text with personality
 *
 * Thread Structure:
 * 1. Summary Hook - version, counts, keywords, prompt status
 * 2. What's New - ALL features (split if >5)
 * 3. Fixes - ALL fixes (split if >5)
 * 4. Prompt Changes (w/ cchistory) - if any
 * 5. Links - changelog, prompt diff, clawd.gg
 *
 * Models:
 * - Opus 4.5 + Extended Thinking: All tweet writing
 * - Haiku 4.5: Classification only (Reddit scoring)
 */

import Anthropic from '@anthropic-ai/sdk';
import type { ParsedReleaseNotes } from '../watchers/github';
import type { ParsedDiff } from '../watchers/cchistory';

// ═══════════════════════════════════════════════════════════════════════════
// MODEL CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const MODELS = {
  // Simple classification tasks
  FAST: 'claude-haiku-4-5-20251001',
  // Wit, analysis, engaging writing (with extended thinking)
  SMART: 'claude-opus-4-5-20251101',
} as const;

// Extended thinking config
const THINKING_CONFIG = {
  type: 'enabled' as const,
  budget_tokens: 4000,
};

// X Premium accounts can post up to 25,000 chars - no need to split
const IS_PREMIUM = process.env.X_PREMIUM === 'true';
const MAX_TWEET_CHARS = IS_PREMIUM ? 4000 : 280; // Use 4000 for premium (reasonable limit)

// Helper to extract text from response (handles thinking blocks)
function extractText(response: Anthropic.Message): string {
  const textBlock = response.content.find(c => c.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text response from AI');
  }
  return textBlock.text.trim();
}

// Bot personality examples
const TONE_EXAMPLES = `
Voice: Sharp, helpful, occasionally witty. Terminal-native developer. Never corporate.

Summary Hook examples:
"Claude Code 2.0.74

✨ 5 new (LSP, terminal setup, shortcuts)
🐛 5 fixed (allowed-tools, Opus tip)
🤖 Prompt: +47 lines (security, MCP)

Details ↓"

"Claude Code 2.0.76

✨ 2 new (memory, context)
🐛 3 fixed (crash, rendering)
🤖 Prompt: unchanged

Details ↓"

What's New examples:
"✨ What's New

• LSP: go-to-definition, find refs, hover docs
• /terminal-setup for Kitty, Alacritty, Warp
• ctrl+t toggles syntax highlighting
• Theme picker shows highlighting info
• macOS Alt shortcut guidance"

Fixes examples:
"🐛 Fixes

• Skill allowed-tools now applies correctly
• No phantom Opus 4.5 tips
• Syntax highlighting init crash
• /plugins discover selection bug
• macOS shows 'opt' not 'alt'"

Prompt Changes examples:
"🤖 Prompt Changes (w/ cchistory)

• Security guidelines for tool use
• Expanded MCP server instructions
• Refined code review workflow"

What NOT to do:
❌ "We're thrilled to announce..." (corporate)
❌ "🚀🔥 HUGE UPDATE!!" (cringe)
❌ "#ClaudeCode #AI #Coding" (hashtag spam)
❌ Truncate items with "..." or "+N more"
`;

let anthropic: Anthropic | null = null;

function getClient(): Anthropic {
  if (!anthropic) {
    anthropic = new Anthropic();
  }
  return anthropic;
}

// ═══════════════════════════════════════════════════════════════════════════
// TWEET 1: SUMMARY HOOK
// ═══════════════════════════════════════════════════════════════════════════

export interface SummaryHookInput {
  version: string;
  features: string[];
  fixes: string[];
  promptDiff: { added: number; removed: number } | null;
  changelogPending?: boolean;  // True if GitHub release not available yet
}

/**
 * Generate the summary hook tweet (Tweet 1)
 * Shows version, counts, keywords, and prompt status
 */
export async function generateSummaryHook(input: SummaryHookInput): Promise<string> {
  // If changelog is pending (no GitHub release yet), use a simpler format
  if (input.changelogPending) {
    return `Claude Code ${input.version} just dropped

✨ Changelog incoming...
🤖 Prompt: checking...

Details shortly ↓`;
  }

  const client = getClient();

  const promptStatus = input.promptDiff
    ? `+${input.promptDiff.added}/-${input.promptDiff.removed} lines`
    : 'unchanged';

  const response = await client.messages.create({
    model: MODELS.SMART,
    max_tokens: 6000,
    thinking: THINKING_CONFIG,
    messages: [{
      role: 'user',
      content: `${TONE_EXAMPLES}

Generate a summary hook tweet for Claude Code ${input.version}.

Data:
- Features (${input.features.length}): ${input.features.join(' | ')}
- Fixes (${input.fixes.length}): ${input.fixes.join(' | ')}
- Prompt changes: ${promptStatus}

Format EXACTLY like this:
Claude Code {version}

✨ {n} new ({2-3 keywords from features})
🐛 {n} fixed ({2-3 keywords from fixes})
🤖 Prompt: {status with keywords if changed}

Details ↓

Rules:
- Extract 2-3 SHORT keywords per category (e.g., "LSP, terminal setup, shortcuts")
- Keywords should capture the essence, not full descriptions
- If prompt changed, include theme keywords like "(security, MCP)"
- If prompt unchanged, just say "unchanged"
- Keep under 280 chars total
- If 0 features or fixes, still show the line with 0`,
    }],
  });

  return extractText(response);
}

// ═══════════════════════════════════════════════════════════════════════════
// TWEET 2: WHAT'S NEW (ALL ITEMS)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate What's New tweet(s) with ALL features
 * Returns array of tweets if items overflow (>5 per tweet for free, no split for premium)
 */
export async function generateWhatsNewTweets(items: string[]): Promise<string[]> {
  if (items.length === 0) return [];

  const client = getClient();

  // Premium accounts: no split needed (up to 4000 chars)
  // Free accounts: max 5 items per tweet (280 char limit)
  const needsSplit = !IS_PREMIUM && items.length > 5;

  const response = await client.messages.create({
    model: MODELS.SMART,
    max_tokens: 6000,
    thinking: THINKING_CONFIG,
    messages: [{
      role: 'user',
      content: `${TONE_EXAMPLES}

Format ALL these features as What's New tweet(s).

Features (${items.length}):
${items.map((item, i) => `${i + 1}. ${item}`).join('\n')}

Rules:
- Header: "✨ What's New"${needsSplit ? ' (or "✨ What\'s New (1/2)" if split)' : ''}
- Use bullet points (•)
- ${IS_PREMIUM ? 'Can use full descriptions' : 'Compress each item to ~50 chars max while keeping meaning'}
- Include ALL ${items.length} items - do not omit any
- ${IS_PREMIUM ? `Max ${MAX_TWEET_CHARS} chars total` : 'Max 5 items per tweet (280 char limit)'}
${needsSplit ? `- Split into ${Math.ceil(items.length / 5)} tweets, separated by ---` : '- Single tweet'}
- No commentary at the end

Output format:
✨ What's New${needsSplit ? ' (1/N)' : ''}

• item 1
• item 2
...
${needsSplit ? '---\n✨ What\'s New (2/N)\n\n• item 6\n...' : ''}`,
    }],
  });

  const text = extractText(response);

  // Split by --- if multiple tweets
  if (text.includes('---')) {
    return text.split('---').map(t => t.trim()).filter(t => t.length > 0);
  }

  return [text];
}

// ═══════════════════════════════════════════════════════════════════════════
// TWEET 3: FIXES (ALL ITEMS)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate Fixes tweet(s) with ALL fixes
 * Returns array of tweets if items overflow (>5 per tweet for free, no split for premium)
 */
export async function generateFixesTweets(items: string[]): Promise<string[]> {
  if (items.length === 0) return [];

  const client = getClient();

  const needsSplit = !IS_PREMIUM && items.length > 5;

  const response = await client.messages.create({
    model: MODELS.SMART,
    max_tokens: 6000,
    thinking: THINKING_CONFIG,
    messages: [{
      role: 'user',
      content: `${TONE_EXAMPLES}

Format ALL these bug fixes as Fixes tweet(s).

Fixes (${items.length}):
${items.map((item, i) => `${i + 1}. ${item}`).join('\n')}

Rules:
- Header: "🐛 Fixes"${needsSplit ? ' (or "🐛 Fixes (1/2)" if split)' : ''}
- Use bullet points (•)
- ${IS_PREMIUM ? 'Can use full descriptions' : 'Compress each item to ~50 chars max while keeping meaning'}
- Include ALL ${items.length} items - do not omit any
- ${IS_PREMIUM ? `Max ${MAX_TWEET_CHARS} chars total` : 'Max 5 items per tweet (280 char limit)'}
${needsSplit ? `- Split into ${Math.ceil(items.length / 5)} tweets, separated by ---` : '- Single tweet'}
- No commentary at the end

Output format:
🐛 Fixes${needsSplit ? ' (1/N)' : ''}

• fix 1
• fix 2
...
${needsSplit ? '---\n🐛 Fixes (2/N)\n\n• fix 6\n...' : ''}`,
    }],
  });

  const text = extractText(response);

  if (text.includes('---')) {
    return text.split('---').map(t => t.trim()).filter(t => t.length > 0);
  }

  return [text];
}

// ═══════════════════════════════════════════════════════════════════════════
// TWEET 4: PROMPT CHANGES (w/ cchistory)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate Prompt Changes tweet
 * Credits cchistory tool in header
 */
export async function generatePromptChangesTweet(diff: ParsedDiff): Promise<string | null> {
  if (diff.added.length === 0 && diff.removed.length === 0) {
    return null; // No tweet needed
  }

  const client = getClient();

  const response = await client.messages.create({
    model: MODELS.SMART,
    max_tokens: 6000,
    thinking: THINKING_CONFIG,
    messages: [{
      role: 'user',
      content: `${TONE_EXAMPLES}

Summarize these Claude Code system prompt changes.

Added lines (${diff.added.length}):
${diff.added.slice(0, 10).map(l => l.slice(0, 150)).join('\n')}

Removed lines (${diff.removed.length}):
${diff.removed.slice(0, 10).map(l => l.slice(0, 150)).join('\n')}

Rules:
- Header MUST be: "🤖 Prompt Changes (w/ cchistory)"
- Use bullet points (•) for each meaningful change
- Focus on WHAT changed and WHY it matters to users
- Group related changes together
- Under 250 chars total (leave room for diff link in next tweet)
- Be insightful, not just descriptive

Output format:
🤖 Prompt Changes (w/ cchistory)

• Change 1 and its implication
• Change 2 and its implication
• Change 3...`,
    }],
  });

  return extractText(response);
}

// ═══════════════════════════════════════════════════════════════════════════
// TWEET 5: LINKS (NO AI)
// ═══════════════════════════════════════════════════════════════════════════

export interface LinksInput {
  changelogUrl: string;
  promptDiffUrl?: string;
}

/**
 * Format the links tweet (no AI needed)
 */
export function formatLinksTweet(input: LinksInput): string {
  let tweet = `📋 ${input.changelogUrl}`;

  if (input.promptDiffUrl) {
    tweet += `\n🤖 ${input.promptDiffUrl}`;
  }

  tweet += '\n\nclawd.gg';

  return tweet;
}

// ═══════════════════════════════════════════════════════════════════════════
// UPDATE TWEET (when changelog becomes available after initial post)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate an update tweet when changelog becomes available
 * Posted as reply to original summary hook
 */
export async function generateUpdateTweet(input: {
  version: string;
  features: string[];
  fixes: string[];
}): Promise<string> {
  const client = getClient();

  const response = await client.messages.create({
    model: MODELS.SMART,
    max_tokens: 6000,
    thinking: THINKING_CONFIG,
    messages: [{
      role: 'user',
      content: `${TONE_EXAMPLES}

Generate a brief update tweet announcing the changelog is now available.

Version: ${input.version}
Features: ${input.features.length}
Fixes: ${input.fixes.length}

Example format:
"Update: changelog now available for 2.0.76

✨ 5 new (LSP, terminal setup)
🐛 4 fixed (allowed-tools, crash)

Full details below ↓"

Rules:
- Start with "Update:" or similar
- Include counts and 2-3 keywords
- Keep under 200 chars
- Point to details below`,
    }],
  });

  return extractText(response);
}

export function fallbackUpdateTweet(input: {
  version: string;
  features: string[];
  fixes: string[];
}): string {
  return `Update: changelog now available for ${input.version}

✨ ${input.features.length} new
🐛 ${input.fixes.length} fixed

Full details below ↓`;
}

// ═══════════════════════════════════════════════════════════════════════════
// REDDIT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Filter and rate a Reddit post for relevance
 */
export async function evaluateRedditPost(
  title: string,
  content: string,
  upvotes: number,
  comments: number
): Promise<{ score: number; reason: string }> {
  const client = getClient();

  const response = await client.messages.create({
    model: MODELS.FAST,
    max_tokens: 100,
    system: `You evaluate Reddit posts for a Claude Code Twitter account.
Rate posts 1-10 based on:
- Relevance to Claude Code users
- Novelty (not basic tips)
- Engagement potential
Respond in format: SCORE: X | REASON: brief explanation`,
    messages: [{
      role: 'user',
      content: `Title: ${title}
Content: ${content.slice(0, 500)}
Upvotes: ${upvotes}
Comments: ${comments}`,
    }],
  });

  const text = response.content[0];
  if (text.type !== 'text') throw new Error('Unexpected response type');

  const match = text.text.match(/SCORE:\s*(\d+)\s*\|\s*REASON:\s*(.+)/i);
  if (!match) {
    return { score: 5, reason: 'Could not parse response' };
  }

  return {
    score: parseInt(match[1], 10),
    reason: match[2].trim(),
  };
}

/**
 * Format a Reddit post as a tweet
 */
export async function formatRedditTweet(
  title: string,
  content: string,
  url: string,
  subreddit: string
): Promise<string> {
  const client = getClient();

  const response = await client.messages.create({
    model: MODELS.SMART,
    max_tokens: 6000,
    thinking: THINKING_CONFIG,
    messages: [{
      role: 'user',
      content: `${TONE_EXAMPLES}

Rewrite this Reddit find as a tweet.

Example output:
"Found on r/ClaudeAI: Someone built an MCP server that connects to their Obsidian vault. Now Claude can search their entire second brain. This is the way."

Rules:
- Start with "Found on r/${subreddit}:" or similar
- Make it engaging and shareable
- Under 230 chars (URL added separately)
- Add a short take at the end if interesting

Reddit post:
Title: ${title}
Content: ${content.slice(0, 300)}`,
    }],
  });

  return `${extractText(response)}\n\n${url}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// WEEKLY SUMMARY
// ═══════════════════════════════════════════════════════════════════════════

export interface WeeklyData {
  dateRange: string;
  versions: { version: string; highlights: string[] }[];
  npm: { current: number; previous: number | null; change: number | null };
  brew: { installs30d: number; installs90d: number };
}

/**
 * Generate an insightful weekly summary
 */
export async function generateWeeklySummary(data: WeeklyData): Promise<string> {
  const client = getClient();

  const allHighlights = data.versions.flatMap(v => v.highlights).slice(0, 10);

  const response = await client.messages.create({
    model: MODELS.SMART,
    max_tokens: 6000,
    thinking: THINKING_CONFIG,
    messages: [{
      role: 'user',
      content: `${TONE_EXAMPLES}

Write a weekly insight tweet for Claude Code.

Example:
"Big week for code navigation. LSP landed, which means go-to-definition works in terminal now. The future is here and it runs in iTerm."

This week's data:
- ${data.versions.length} versions: ${data.versions.map(v => v.version).join(', ')}
- npm: ${data.npm.current.toLocaleString()}${data.npm.change ? ` (${data.npm.change > 0 ? '+' : ''}${data.npm.change.toFixed(1)}%)` : ''}
- brew: ${data.brew.installs30d.toLocaleString()} (30d)

Key changes:
${allHighlights.map(h => `- ${h}`).join('\n')}

Rules:
- Under 250 chars
- Highlight the most impactful change(s)
- Add insight on what it means for users
- Have personality`,
    }],
  });

  return extractText(response);
}

// ═══════════════════════════════════════════════════════════════════════════
// FALLBACK FORMATTERS (no AI, for when API is unavailable)
// ═══════════════════════════════════════════════════════════════════════════

export function fallbackSummaryHook(input: SummaryHookInput): string {
  if (input.changelogPending) {
    return `Claude Code ${input.version} just dropped

✨ Changelog incoming...
🤖 Prompt: checking...

Details shortly ↓`;
  }

  const promptStatus = input.promptDiff
    ? `+${input.promptDiff.added}/-${input.promptDiff.removed} lines`
    : 'unchanged';

  return `Claude Code ${input.version}

✨ ${input.features.length} new
🐛 ${input.fixes.length} fixed
🤖 Prompt: ${promptStatus}

Details ↓`;
}

export function fallbackWhatsNewTweets(items: string[]): string[] {
  if (items.length === 0) return [];

  // Premium: single tweet, no compression
  if (IS_PREMIUM) {
    const header = '✨ What\'s New\n\n';
    const body = items.map(item => `• ${item}`).join('\n');
    return [header + body];
  }

  // Free: split into chunks of 5, compress items
  const tweets: string[] = [];
  const chunks = chunkArray(items, 5);

  chunks.forEach((chunk, i) => {
    const header = chunks.length > 1
      ? `✨ What's New (${i + 1}/${chunks.length})\n\n`
      : '✨ What\'s New\n\n';

    const body = chunk.map(item => `• ${item.slice(0, 50)}${item.length > 50 ? '...' : ''}`).join('\n');
    tweets.push(header + body);
  });

  return tweets;
}

export function fallbackFixesTweets(items: string[]): string[] {
  if (items.length === 0) return [];

  // Premium: single tweet, no compression
  if (IS_PREMIUM) {
    const header = '🐛 Fixes\n\n';
    const body = items.map(item => `• ${item}`).join('\n');
    return [header + body];
  }

  // Free: split into chunks of 5, compress items
  const tweets: string[] = [];
  const chunks = chunkArray(items, 5);

  chunks.forEach((chunk, i) => {
    const header = chunks.length > 1
      ? `🐛 Fixes (${i + 1}/${chunks.length})\n\n`
      : '🐛 Fixes\n\n';

    const body = chunk.map(item => `• ${item.slice(0, 50)}${item.length > 50 ? '...' : ''}`).join('\n');
    tweets.push(header + body);
  });

  return tweets;
}

export function fallbackPromptChangesTweet(diff: ParsedDiff): string | null {
  if (diff.added.length === 0 && diff.removed.length === 0) {
    return null;
  }

  let text = '🤖 Prompt Changes (w/ cchistory)\n\n';

  if (diff.added.length > 0) {
    text += `• +${diff.added.length} lines added\n`;
  }
  if (diff.removed.length > 0) {
    text += `• -${diff.removed.length} lines removed\n`;
  }

  return text.trim();
}

// Helper to chunk array
function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
