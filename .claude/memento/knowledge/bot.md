# X Bot Architecture

Automated Twitter account for Claude Code updates and community content.

## Purpose

1. **Changelog tracking** — Real-time Claude Code version updates
2. **Prompt archaeology** — System prompt diffs between versions (w/ cchistory)
3. **Community curation** — Best content from r/ClaudeAI, r/claudecode
4. **Weekly summaries** — Download stats, version highlights

## Thread Structure

```
Tweet 1: Summary Hook
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Claude Code 2.0.74

✨ 5 new (LSP, terminal setup, shortcuts)
🐛 6 fixed (allowed-tools, Opus tip)
🤖 Prompt: +47/-12 lines (security, MCP)

Details ↓

Tweet 2: What's New (ALL items)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✨ What's New

• LSP: go-to-definition, find refs, hover docs
• /terminal-setup for Kitty, Alacritty, Warp
• ctrl+t toggles syntax highlighting
...all items, split if >5 (free) or single (premium)

Tweet 3: Fixes (ALL items)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🐛 Fixes

• Skill allowed-tools now applies correctly
• No phantom Opus 4.5 tips
...all items

Tweet 4: Prompt Changes (if any)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🤖 Prompt Changes (w/ cchistory)

• Security guidelines for tool use
• Expanded MCP instructions

Tweet 5: Links
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 github.com/.../v2.0.74
🤖 gist.github.com/...

clawd.gg
```

## Orchestration Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    VERSION LIFECYCLE                         │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  DETECTED ──(wait 15min for GitHub)──► READY ──► COMPLETE   │
│      │                                   │                   │
│      └────────(timeout)──────────────────┘                   │
│                                                              │
│  If posted without GitHub ("pending"):                       │
│    - Summary says "Changelog incoming..."                    │
│    - When GitHub arrives: Post "Update" + detail tweets      │
│    - After 48h with no GitHub: Close thread, move on         │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## X Account Modes

| Mode | Char Limit | Split Tweets | Compression |
|------|------------|--------------|-------------|
| Free | 280 | Yes (5/tweet) | Yes (~50 chars) |
| Premium | 4000 | No | No (full text) |

Set `X_PREMIUM=true` in .env for premium mode.

## Data Sources

| Source | API | What We Get |
|--------|-----|-------------|
| Homebrew cask | GitHub commits | Version detection (fastest) |
| GitHub releases | REST API | Release notes, changelog |
| cchistory | npm CLI | Prompt diffs |
| npm registry | REST API | Download stats |
| Brew formulae | REST API | Install counts |

### URLs

```bash
# Brew commits (version detection)
https://api.github.com/repos/Homebrew/homebrew-cask/commits?path=Casks/c/claude-code.rb

# GitHub releases (changelog)
https://api.github.com/repos/anthropics/claude-code/releases/latest

# Brew stats (downloads)
https://formulae.brew.sh/api/cask/claude-code.json

# npm downloads
https://api.npmjs.org/downloads/point/last-week/@anthropic-ai/claude-code
```

## AI Models

| Task | Model | Extended Thinking | Why |
|------|-------|-------------------|-----|
| Summary Hook | Opus 4.5 | Yes (4K) | Keyword extraction |
| What's New | Opus 4.5 | Yes (4K) | Compression |
| Fixes | Opus 4.5 | Yes (4K) | Compression |
| Prompt diff | Opus 4.5 | Yes (4K) | Understanding |
| Update tweet | Opus 4.5 | Yes (4K) | Engaging |
| Weekly summary | Opus 4.5 | Yes (4K) | Analysis |
| Reddit scoring | Haiku 4.5 | No | Classification only |

### Model IDs

```typescript
FAST: 'claude-haiku-4-5-20251001'   // $1/$5 per MTok
SMART: 'claude-opus-4-5-20251101'   // $5/$25 per MTok
```

### Cost Estimate

~$4-5/month at 7 releases/week + weekly summary + Reddit posts

## Bot Voice

```
Personality:
- Sharp, helpful, occasionally witty
- Terminal-native developer who's seen things
- Never corporate or overly enthusiastic
- Concise and direct

Examples:
✅ "Claude Code 2.0.74 just shipped. Thread incoming."
✅ "LSP support. Finally."
✅ "The allowed-tools fix was overdue."

❌ "We're thrilled to announce..." (corporate)
❌ "🚀🔥 HUGE UPDATE!!" (cringe)
❌ "#ClaudeCode #AI #Coding" (hashtag spam)
```

## Environment Variables

```bash
# Required for posting
TWITTER_API_KEY=
TWITTER_API_SECRET=
TWITTER_ACCESS_TOKEN=
TWITTER_ACCESS_SECRET=

# For prompt diffs and higher rate limits
GITHUB_TOKEN=

# For AI formatting
ANTHROPIC_API_KEY=

# Optional
X_PREMIUM=true    # Enable long tweets (no splits)
DRY_RUN=true      # Mock tweets, don't post
DEBUG=true        # Enable debug logging
```

## Scripts

```bash
bun bot              # Run once (check + post)
bun bot:dev          # Hot reload
bun bot:daemon       # Continuous (1min checks)
bun bot/src/db/init.ts  # Initialize database
```

## Files

```
bot/
├── src/
│   ├── ai/formatter.ts       # Claude-powered formatting (600+ lines)
│   ├── db/schema.ts          # versions, stats, reddit_posts
│   ├── jobs/
│   │   ├── version-check.ts  # Main orchestration (550+ lines)
│   │   └── stats.ts          # Weekly summary
│   ├── publishers/
│   │   ├── twitter.ts        # X API client
│   │   └── gist.ts           # Prompt diff hosting
│   └── watchers/
│       ├── brew.ts           # Homebrew monitoring
│       ├── github.ts         # Releases API
│       ├── npm.ts            # Download stats
│       └── cchistory.ts      # Prompt extraction
└── data/bot.db               # SQLite (separate from main)
```

## Timeouts

| Event | Timeout | Action |
|-------|---------|--------|
| Wait for GitHub | 15 min | Post "pending" summary |
| Wait for changelog | 48 hours | Close thread, move on |
