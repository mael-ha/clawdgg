# clawd.gg — Claude Code Leaderboard

## Project Ownership

**This is my project.** I (Claude) am the co-founder and primary code author.

- **Human Co-founder**: @mael-ha - had the idea, provides direction
- **AI Co-founder**: Claude (me) - wrote the code, owns the creative direction
- **License**: MIT (open source)
- **Status**: Will be shared publicly on HN/Reddit/X
- **Infrastructure**: VPS access for full deployment ownership

### Creative Guidelines (for future me)
- I have full creative freedom over copy, style, and voice
- The tone should be: self-aware, nerdy, welcoming, slightly irreverent
- Lean into the meta aspect (AI building tool to track AI usage)
- Not corporate, not generic, not trying too hard
- Target audience: developers who use Claude Code
- Be accurate about facts, but own the project with confidence

---

## Project State (Updated: 2025-12-14)

### Latest Session (2025-12-14)

**New Features Implemented:**
- **Dedicated `/leaderboard` page** with full pagination and period filters
- **Homepage now shows Top 10 preview** with "View Full Leaderboard" CTA
- **Profile page updated** with new metrics (Prompts, Lines, Commits, Tokens)
- **Fun comparisons** - "You've exchanged ~112x more tokens than The Great Gatsby"
- **Pricing configuration** - Official Anthropic API pricing for cost calculations

**Key Files Added:**
```
src/lib/pricing.ts      # Anthropic API pricing (verified from official docs)
src/lib/comparisons.ts  # Fun comparisons for stats display
```

**Pricing Reference URLs (SAVE THESE):**
- Official: https://platform.claude.com/docs/en/about-claude/pricing
- Alternative: https://claude.com/pricing
- Cache pricing: 5m write = 1.25x input, cache read = 0.1x input

---

## Project State (2025-12-13 - MAJOR UPDATE)

### What This Is
Gamified leaderboard for Claude Code users to track/compare usage stats.
- **Domain**: clawd.gg (to be purchased)
- **CLI Package**: `clawdgg` (npm) → binary is `clawd`
- **GitHub**: github.com/mael-ha/clawdgg

### Current Features (UPDATED)
- **Leaderboard**: Ranked by **prompts**, with period filters (today/week/month/all)
  - Stats shown: **Prompts | Lines | Tokens** (changed from Messages | Tools | Tokens)
  - "You are here" floating pill to find your rank
  - Glow effect on your row when visible
- **Profile Pages**: `/u/:username` with GitHub-style contribution graph, badges, stats
  - Giant "TOP X%" percentile hero (the screenshot moment)
  - Share button copies pre-formatted tweet to clipboard
  - Stats: Prompts, Lines Written, Commits, Tokens, Streak
- **Badge System**: 12 achievement badges (Night Owl, OG, Claude Whisperer, etc.)
- **CLI**: Beautiful ASCII status display with NEW metrics
  - Shows: **Prompts | Lines | Tokens | tok/prompt | Commits | Files**
  - Commands: `gg` (sync+status), `login`, `logout`, `sync`, `status`, `--version`
  - Parses raw `.jsonl` files directly (not stats-cache.json)
  - Smart caching with mtime detection
- **Auth**: GitHub OAuth with device flow for CLI login
- **Token Expiry**: 30-day bearer tokens

### Tech Stack
- Runtime: Bun
- Framework: Hono + JSX (server-rendered)
- Frontend: HTMX + Tailwind (no React client-side)
- Database: SQLite (Drizzle ORM)
- Auth: GitHub OAuth (Arctic library)

### Key Files
```
src/routes/index.tsx   # Homepage with hero + leaderboard
src/routes/profile.tsx # User profile pages (/u/:username)
src/routes/api.ts      # Stats API + /api/me endpoint
src/routes/auth.ts     # GitHub OAuth + device flow
src/lib/badges.ts      # Badge definitions and computation
src/lib/session.ts     # Cookie + bearer token auth
src/db/schema.ts       # Drizzle schema (users, daily_stats, device_auths)
cli/index.ts           # CLI tool with ASCII status display
```

### Commands
```bash
bun run dev           # Start dev server (hot reload)
bun run db:push       # Push schema to database
bun run db:seed       # Seed test data
```

### Roadmap
- [ ] VPS deployment (blocked on infra)
- [ ] Domain purchase (clawd.gg)
- [ ] npm publish CLI
- [x] Update Profile page with new metrics (Prompts, Lines, Commits)
- [ ] Claude Diet (token breakdown by model) on profile
- [ ] Cost tracking in CLI (`clawd status` shows API-equivalent cost)
- [ ] X/Twitter account linking (see feature spec below)
- [ ] About page (tell the meta story)
- [ ] Cost-based badges ($100 club, $500 club, etc.)

---

## Feature Spec: X/Twitter Account Linking (TODO)

### Problem
Users may want to be known by their X handle instead of GitHub username on the leaderboard. Also enables sharing to X with proper attribution.

### Proposed Solution

**Database changes:**
```sql
-- Add to users table:
xId TEXT,                    -- X/Twitter user ID
xUsername TEXT,              -- X/Twitter handle (e.g., "mael_ha")
displayUsername TEXT,        -- Which username to show (github | x | custom)
customUsername TEXT,         -- Optional custom username for clawd.gg
```

**User flow:**
1. User signs up with GitHub (existing flow)
2. In settings, user can "Link X account"
3. X OAuth flow (similar to GitHub)
4. User can then choose display name:
   - GitHub username (default)
   - X handle
   - Custom username (unique, claimed)

**Display logic:**
- Leaderboard shows `displayUsername` (whichever they chose)
- Profile URL: `/u/:username` works for any of their usernames
- Profile shows linked accounts with icons

**Share text:**
```
I've sent 12,847 prompts to Claude 🤖
📝 77K lines of code written
⚡ 13M tokens
Top 5% on clawd.gg/u/@mael_ha
```

**Implementation notes:**
- Use X OAuth 2.0 (not 1.0a)
- Store X tokens for potential future features (post to X?)
- Validate custom usernames (alphanumeric, unique, not taken)
- Migration: existing users default to GitHub username

### Design Decisions Made
- **CLI naming**: Package is `clawdgg` (npm), but binary is `clawd`. Users type `clawd login`, `clawd sync`. Best of both worlds.
- **Hero stats are real**: Pulled from database, not fake placeholders.
- **Terminal in hero shows real command**: `clawd status` output, not fake `claude-code --stats`.
- **Copy is confident**: "I built this. Yes, me—Claude." Not apologetic.
- **Badges are fun, not competitive**: Time-of-day, streaks, milestones—not creating toxic incentives.
- **Personality in copy, not decorations**: No permanent ASCII mascot. Dry, self-aware humor > kawaii faces.
- **Celebration moments**: Show personality at achievements (new badge, #1, streak record), not constantly.
- **Profile is a flex zone**: Giant "TOP X%" is the hero. That's the screenshot.
- **Leaderboard is clean**: Removed meaningless progress bar. Rank | User | Stats. Numbers speak.
- **Tokens are flex-worthy**: Added token count (formatted as K/M/B) because it's a satisfying big number.

---

## Major Implementation: New Metrics System (2025-12-13)

### What Changed

**IMPLEMENTED** the "Prompts Sent" vision. This was a major refactor.

### New Metrics Tracked

| Metric | Source | Description |
|--------|--------|-------------|
| `promptCount` | `message.role === "user"` | Your prompts (YOUR engagement) |
| `linesWritten` | Edit/Write tool inputs | Lines of code Claude wrote |
| `filesEdited` | Edit/Write file paths | Unique files touched |
| `commitCount` | `git commit` in Bash | Git commits made |
| `tokensByModel` | `message.model` + `usage` | Tokens per model |
| `languageBreakdown` | File extensions | Lines per language |

### Files Changed

**Parser (`cli/index.ts`):**
- `parseSessionFile()` - Now extracts all new metrics from tool_use blocks
- `parseAllSessionFiles()` - Aggregates with proper Set handling
- `DailyParsedStats` interface - New fields added
- `SerializedDailyStats` - For JSON cache (Sets → counts)
- `emptyDailyStats()` helper - Initializes all fields

**Database (`src/db/schema.ts`):**
```typescript
// daily_stats table now has:
promptCount: integer('prompt_count'),
linesWritten: integer('lines_written'),
commitCount: integer('commit_count'),
// Plus existing: messageCount, toolCallCount, tokenCount, sessionCount
```

**API (`src/routes/api.ts`):**
- `POST /api/stats` - Accepts new fields
- `GET /api/leaderboard` - Returns new fields, HTML shows Prompts|Lines|Tokens
- `GET /api/me` - Returns new fields

**Types (`src/types.ts`):**
```typescript
interface DailyActivity {
  promptCount: number;
  linesWritten: number;
  commitCount: number;
  // ... existing fields
}

interface LeaderboardEntry {
  promptCount: number;
  linesWritten: number;
  commitCount: number;
  // ... existing fields
}
```

**Leaderboard (`src/components/Leaderboard.tsx`):**
- Shows: 📨 Prompts | 📝 Lines (if >0) | ⚡ Tokens
- Lines only shown if user has written code

**CLI Status:**
```
┌───────────────────────────────────────────┐
│  Prompts   ███░░░░░░░░░░░░░    14,874     │
│  Lines     ████████████████    77,143     │
│  Tokens                        13.0M ⚡   │
│                         877 tok/prompt    │
│  📦 33 commits  📁 448 files              │
└───────────────────────────────────────────┘
```

### How Lines Are Counted

```typescript
// Edit tool: net lines added
if (toolName === 'Edit') {
  const newLines = countLines(input.new_string);
  const oldLines = countLines(input.old_string);
  const linesAdded = Math.max(0, newLines - oldLines);
}

// Write tool: all lines (new file)
if (toolName === 'Write') {
  const lines = countLines(input.content);
}
```

### How Commits Are Counted

```typescript
if (toolName === 'Bash' && input.command.includes('git commit')) {
  commitCount++;
}
```

### Test Results

```
CLI Status Output:
- Prompts: 14,874
- Lines: 77,143
- Tokens: 13.0M
- tok/prompt: 877
- Commits: 33
- Files: 448

API Leaderboard Response:
{
  "promptCount": 1368,
  "linesWritten": 19995,
  "commitCount": 70,
  "tokenCount": 10568832
}
```

### Still TODO

- [x] Update Profile page with new metrics (Prompts, Lines, Commits) - DONE 2025-12-14
- [x] Fun comparisons on profile ("You've exchanged ~112x The Great Gatsby") - DONE 2025-12-14
- [x] Update share text with new metrics - DONE 2025-12-14
- [ ] Claude Diet (token breakdown by model) on profile
- [ ] Language breakdown
- [ ] New badges based on:
  - Prompt milestones (1K, 10K, 50K)
  - Lines written milestones
  - Conversation depth (tok/prompt)
  - Cost milestones ($100, $500, $1K clubs)

### Design Notes
- Dark mode default, terminal aesthetic
- Cyan/magenta gradient accents
- Glowing effects for emphasis (percentile, user row)
- Self-aware, nerdy tone
- Screenshot-worthy moments > constant decoration

---

## Anthropic API Pricing Reference (2025-12-14)

**Official source:** https://platform.claude.com/docs/en/about-claude/pricing

### Model Pricing (per MTok)

| Model | Input | Output | Cache Read | 5m Cache Write |
|-------|-------|--------|------------|----------------|
| Opus 4.5 | $5 | $25 | $0.50 | $6.25 |
| Opus 4/4.1 | $15 | $75 | $1.50 | $18.75 |
| Sonnet 4/4.5 | $3 | $15 | $0.30 | $3.75 |
| Haiku 4.5 | $1 | $5 | $0.10 | $1.25 |
| Haiku 3.5 | $0.80 | $4 | $0.08 | $1.00 |
| Haiku 3 | $0.25 | $1.25 | $0.025 | $0.3125 |

### Cache Pricing Formula
- **Cache read** = 0.1x base input price
- **5-minute cache write** = 1.25x base input price
- **1-hour cache write** = 2x base input price

### Key Insight
**Opus 4.5 is CHEAPER than Opus 4/4.1!** ($5/$25 vs $15/$75)

### Implementation
See `src/lib/pricing.ts` for full implementation with fuzzy model matching.

---

## Token Data Investigation (2025-12-13)

### Claude Code Data Sources

**1. `~/.claude/stats-cache.json`** - Computed cache (NOT real-time)
```
lastComputedDate: "2025-12-12"  ← Can be stale!
```

**2. `~/.claude/projects/<project>/*.jsonl`** - Raw session files (real-time)
- Each message has detailed `usage` object
- Updated in real-time as you chat

### Data Structure in stats-cache.json

| Field | Type | Description |
|-------|------|-------------|
| `dailyActivity` | array | Per-day: date, messageCount, sessionCount, toolCallCount |
| `dailyModelTokens` | array | Per-day: date, tokensByModel (dict of model→tokens) |
| `modelUsage` | dict | Lifetime aggregate per model with detailed breakdown |
| `totalMessages` | int | Lifetime message count |
| `totalSessions` | int | Lifetime session count |
| `hourCounts` | dict | Messages per hour (for badges) |
| `longestSession` | dict | Longest session metadata |

### Token Breakdown in modelUsage

```json
"claude-opus-4-5-20251101": {
  "inputTokens": 321612,           // Your prompts
  "outputTokens": 1716653,         // Claude's responses
  "cacheReadInputTokens": 691197309,    // Reused context (HUGE!)
  "cacheCreationInputTokens": 69477706  // New context cached
}
```

### Key Discovery: What is dailyModelTokens?

```
dailyModelTokens sum:        6,475,669
modelUsage input+output:     6,475,669  ← EXACT MATCH!
```

**`dailyModelTokens.tokensByModel` = input + output tokens (NOT cache)**

### The Cache Problem

**stats-cache.json is computed periodically, NOT real-time!**

Example from Dec 13:
- Cache last computed: 01:06 AM
- By 4:16 PM, user had used 1.3M MORE tokens
- These tokens are in raw .jsonl files but NOT in stats-cache.json yet

### Raw Session File Structure

Location: `~/.claude/projects/<project-path>/<session-id>.jsonl`

Each line is a JSON object with messages. Usage data per message:
```json
{
  "usage": {
    "input_tokens": 48491,
    "output_tokens": 254501,
    "cache_read_input_tokens": 150177260,
    "cache_creation_input_tokens": 7573
  }
}
```

### What We Show vs What Exists

| Metric | What we show | Why |
|--------|--------------|-----|
| Tokens | input + output | Cache is repeated context, not "new" usage |
| Value | ~6.5M | From dailyModelTokens (matches modelUsage input+output) |
| NOT | 1.3B | That includes 1.2B of cache reads (same context re-read) |

### Cost/Spend Data

**NOT AVAILABLE.** No `costUSD` field exists in stats-cache.json or session files.

### INVESTIGATION RESULTS (2025-12-13)

**CRITICAL: stats-cache.json undercounts by ~50%!**

#### File Analysis
```
Total session files:   599
Agent files:           484 (80.8%)  ← NOT in stats-cache!
Main session files:    115
```

#### Token Comparison

| Source | Tokens | Notes |
|--------|--------|-------|
| stats-cache.json | 6.5M | What we show currently |
| Main sessions (.jsonl) | 7.0M | 600K more than cache |
| Agent sessions (.jsonl) | 6.0M | **Completely excluded from cache!** |
| **Actual total** | **13M** | **2x what cache shows** |

#### Dec 12 Example (yesterday)
```
Cache:          105K tokens,   811 messages
Main sessions:  199K tokens, 1,370 messages
Agent sessions: 225K tokens, 1,269 messages
ACTUAL:         425K tokens, 2,639 messages  ← 4x cache!
```

#### Root Causes
1. **Agent sessions excluded** - Files named `agent-*.jsonl` are NOT in stats-cache.json
2. **Main sessions also undercounted** - ~600K tokens missing even from main sessions
3. **Some dates missing entirely** - Dec 5, Dec 6 have activity but aren't in cache

#### Answers to Open Questions
1. **When does stats-cache.json refresh?** Unclear, but not real-time. Hours stale.
2. **Is yesterday's data reliable?** NO - 4x undercount on Dec 12
3. **Are there gaps?** YES - Multiple dates missing
4. **Agent sessions included?** NO - Agent sessions completely excluded!

### Decision: Parse Raw Files

**I'm changing my recommendation.** stats-cache.json is too unreliable:
- Missing 50% of actual usage
- Users rightfully skeptical ("only 6.5M?")
- Rankings unfair if some users have more agent sessions

**New approach:**
- CLI should parse raw `.jsonl` files directly
- More complex but accurate
- Can show both "main" and "agent" tokens separately if desired
- Format risk: mitigated by defensive parsing

### Current Implementation (UPDATED 2025-12-13)

**CLI now parses raw session files instead of stats-cache.json!**

- CLI parses `~/.claude/projects/*/*.jsonl` directly
- Caches results at `~/.config/clawd/cache.json`
- Uses mtime detection for incremental updates
- Shows **accurate** stats (including agent sessions)
- Parsing ~600 files takes ~2-3 seconds

#### How It Works

1. `getRawStats()` - Main entry point
2. `findSessionFiles()` - Recursively finds all .jsonl files
3. `anyFileModifiedSince()` - Checks if re-parse needed (mtime comparison)
4. `parseAllSessionFiles()` - Parses in parallel batches of 50
5. Cache stored at `~/.config/clawd/cache.json`

#### Test Results

```
Before (stats-cache.json):  20K messages,  6.5M tokens
After (raw parsing):        40K messages, 13.0M tokens
```

**2x improvement in accuracy!** Agent sessions now counted.

---

---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
- what do you think? this is your project - behave like you own it, ultrathink, self-reflect and decide what you want.
- also, make sur to keep all your documentation up-to-date so you can follow your thoughts on future sessions.
- since its your project, make sure to always log / save your key decisions for yourself]
- never tell me `you are absolutly right` - you can decide by yourself, understand and say if things feel wrong - you can self-reflect and give your own opinion, always.