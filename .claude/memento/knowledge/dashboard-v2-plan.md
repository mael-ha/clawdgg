# Dashboard V2: The Ultimate Claude Code Profile

> **Status:** Planning Complete, Ready for Implementation
> **Created:** 2024-12-22
> **Last Updated:** 2024-12-22

---

## Table of Contents

1. [Vision & Philosophy](#vision--philosophy)
2. [The Emotional Journey](#the-emotional-journey)
3. [Design System](#design-system)
4. [Archetypes System](#archetypes-system)
5. [Information Architecture](#information-architecture)
6. [Component Designs](#component-designs)
7. [Copy Guidelines](#copy-guidelines)
8. [Data Requirements](#data-requirements)
9. [Technical Implementation](#technical-implementation)
10. [Entry Points & Flows](#entry-points--flows)
11. [Implementation Phases](#implementation-phases)
12. [Anti-Patterns](#anti-patterns)
13. [Success Metrics](#success-metrics)

---

## Vision & Philosophy

### The Core Question

**What do we want someone to feel when they use clawd.gg?**

**Answer:** Quiet pride. Validation. Recognition that their AI partnership matters.

### What clawd.gg IS

- **A mirror, not a scoreboard** — Shows you who you are as a Claude user
- **A portrait of your Claude partnership** — Not a dashboard, not a game
- **Identity-first, numbers-second** — "Who am I?" before "How much?"

### What clawd.gg is NOT

- A gamified achievement system
- A corporate analytics dashboard
- A social network
- A mobile game with levels and rewards

### The One-Line Summary

> clawd.gg makes your invisible AI partnership visible, validated, and shareable.

---

## The Emotional Journey

### Stage 1: Discovery
- **Trigger:** See someone's profile/stats on social media
- **Feel:** Curiosity — "Wait, I can track this?"
- **Action:** Visit clawd.gg

### Stage 2: First Sync
- **Trigger:** Run `clawd sync` for the first time
- **Feel:** Validation rush — "Holy shit, I've done a lot"
- **Key moment:** The numbers appearing in terminal
- **Design goal:** Make this moment LAND

### Stage 3: Profile Revelation
- **Trigger:** View profile for the first time
- **Feel:** Seen — "This system understands me"
- **Key moment:** Archetype reveal
- **Design goal:** Mirror, not label

### Stage 4: Comparison
- **Trigger:** Check leaderboard, see percentile
- **Feel:** Belonging + aspiration — "These are my people"
- **Key moment:** Finding your rank
- **Design goal:** Community, not toxic competition

### Stage 5: Share
- **Trigger:** Screenshot profile, share on social
- **Feel:** Pride — Identity signaling
- **Key moment:** The shareable card
- **Design goal:** Worth screenshotting without prompting

### Stage 6: Return
- **Trigger:** Run `clawd gg` days later
- **Feel:** Momentum — "I'm growing"
- **Key moment:** Streak update, rank change
- **Design goal:** Reason to come back

---

## Design System

### Aesthetic Direction: "Terminal Noir"

The terminal at 2am. Neon on black. Data as art.
Not cute. Not gamified. Cinematic developer aesthetic.

### Color Palette

```css
:root {
  /* Backgrounds */
  --bg-void: #09090b;        /* True black - page bg */
  --bg-surface: #0c0c0f;     /* Card backgrounds */
  --bg-elevated: #131318;    /* Hover states, modals */
  --bg-subtle: #1a1a21;      /* Borders, dividers */

  /* Primary Accent - Electric Cyan (the cursor) */
  --accent-primary: #22d3ee;
  --accent-primary-dim: #0891b2;
  --accent-glow: rgba(34, 211, 238, 0.15);

  /* Model Colors (Semantic) */
  --opus: #f59e0b;           /* Gold - premium */
  --sonnet: #a855f7;         /* Purple - versatile */
  --haiku: #22c55e;          /* Green - efficient */

  /* Status Colors */
  --positive: #22c55e;
  --negative: #ef4444;
  --neutral: #6b7280;

  /* Text Hierarchy */
  --text-primary: #f4f4f5;
  --text-secondary: #a1a1aa;
  --text-tertiary: #52525b;
}
```

### Typography

```css
/* Display - BIG numbers, archetypes */
--font-display: 'Space Mono', monospace;

/* Body - Everything else */
--font-body: 'Geist Mono', 'SF Mono', monospace;

/* Scale */
--text-hero: 4rem;      /* The ONE big number */
--text-stat: 2rem;      /* Key stats */
--text-label: 0.75rem;  /* Labels, hints */
--text-body: 0.875rem;  /* Regular text */
```

### Visual Texture

- **Scanlines:** Faint horizontal lines (like old CRTs)
- **Grain:** Subtle noise overlay (like film)
- **Glow:** Soft cyan glow on key elements (like phosphor)

Creates warmth in darkness. Developer's cockpit at night.

### Motion Principles

- **Fade-ins:** Subtle, staggered on load
- **Number count-ups:** For key stats (satisfying, not cartoonish)
- **Hover states:** Responsive, not bouncy
- **No confetti. No celebrations.** Just smooth, professional motion.

---

## Archetypes System

### Philosophy

An archetype isn't a badge you earn. It's a **mirror** that reflects how you work.
It should make users go: "Yeah... that IS me."

### Archetype Definitions

| Archetype | Meaning | Trigger Condition |
|-----------|---------|-------------------|
| **The Context Maximizer** | You give Claude everything | Highest cache_read / total ratio |
| **The Night Owl** | Best work after dark | 60%+ activity after 8pm |
| **The Early Bird** | First code of the day | 60%+ activity before 9am |
| **The Marathoner** | You go deep | Avg session > 2 hours |
| **The Sprinter** | Quick iterations | Avg session < 30 min |
| **The Opus Connoisseur** | You demand the best | 70%+ Opus usage |
| **The Efficiency Expert** | Max output, min input | Top 10% output/input ratio |
| **The Code Machine** | Less talk, more code | Top 10% lines/token ratio |
| **The Pioneer** | Here from the beginning | Joined during beta |

### Composite Archetypes

Users can have multiple traits. Show as composite:
- "The Night Owl Marathoner"
- "The Opus Connoisseur & Code Machine"

### Archetype Display

```
THE NIGHT OWL MARATHONER
━━━━━━━━━━━━━━━━━━━━━━━━

Your best work happens after dark.
67% of your activity is after 8pm.
Average session: 2h 14m.
```

Stated as fact, not awarded as prize.

### Calculation Logic

```typescript
interface ArchetypeScore {
  archetype: string;
  score: number;  // 0-100 confidence
  trigger: string;  // Human-readable reason
}

function calculateArchetypes(user: UserStats): ArchetypeScore[] {
  const scores: ArchetypeScore[] = [];

  // Night Owl: 60%+ activity after 8pm (hour 20-23, 0-4)
  const nightHours = [20, 21, 22, 23, 0, 1, 2, 3, 4];
  const nightActivity = nightHours.reduce((sum, h) =>
    sum + (user.hourCounts[h] || 0), 0);
  const totalActivity = Object.values(user.hourCounts).reduce((a, b) => a + b, 0);
  const nightPct = totalActivity > 0 ? nightActivity / totalActivity : 0;

  if (nightPct >= 0.6) {
    scores.push({
      archetype: 'Night Owl',
      score: Math.min(100, nightPct * 100),
      trigger: `${Math.round(nightPct * 100)}% of activity after 8pm`
    });
  }

  // Marathoner: Avg session > 2 hours
  // (Need session duration tracking)

  // Opus Connoisseur: 70%+ Opus usage
  const opusPct = user.modelUsage?.opus / user.totalTokens || 0;
  if (opusPct >= 0.7) {
    scores.push({
      archetype: 'Opus Connoisseur',
      score: Math.min(100, opusPct * 100),
      trigger: `${Math.round(opusPct * 100)}% Opus usage`
    });
  }

  // Context Maximizer: High cache read ratio
  const cacheRatio = user.totalCacheReadTokens /
    (user.totalInputTokens + user.totalCacheCreationTokens) || 0;
  if (cacheRatio > 10) {  // 10x more cache reads than fresh input
    scores.push({
      archetype: 'Context Maximizer',
      score: Math.min(100, cacheRatio * 5),
      trigger: `${Math.round(cacheRatio)}x cache reuse ratio`
    });
  }

  // Sort by score, return top 2
  return scores.sort((a, b) => b.score - a.score).slice(0, 2);
}
```

---

## Information Architecture

### Three Tiers of Information

```
TIER 0: THE CARD (3 seconds)
├── Shareable, screenshottable
├── Archetype + hero stat + percentile
└── This is what gets shared on Twitter

TIER 1: THE PROFILE (30 seconds)
├── Scrollable, scannable
├── Key stats with context
├── Activity patterns, model preferences
└── Tells the complete story

TIER 2: THE DETAILS (on-demand)
├── Expandable sections
├── Token breakdowns, efficiency metrics
├── Historical trends, deep data
└── For power users who want to dig
```

### Profile Page Structure

```
┌─────────────────────────────────────────────────────────────────┐
│  HERO CARD (Tier 0)                                             │
│  ───────────────────────────────────────────────────────────────│
│  Archetype • Hero Stat • Percentile • Identity                  │
├─────────────────────────────────────────────────────────────────┤
│  TWO-COLUMN GRID (Tier 1)                                       │
│  ───────────────────────────────────────────────────────────────│
│  ┌─────────────────────┐  ┌─────────────────────┐               │
│  │  YOUR NUMBERS       │  │  YOUR STYLE         │               │
│  │  Tokens, Lines,     │  │  Model preference,  │               │
│  │  Commits, Time      │  │  Peak hours,        │               │
│  │                     │  │  Session style,     │               │
│  │  [Expand details]   │  │  Leverage ratio     │               │
│  └─────────────────────┘  └─────────────────────┘               │
├─────────────────────────────────────────────────────────────────┤
│  ACTIVITY SECTION (Tier 1)                                      │
│  ───────────────────────────────────────────────────────────────│
│  Contribution heatmap (365 days)                                │
│  Streak stats: Current • Best • Active days • Sessions          │
├─────────────────────────────────────────────────────────────────┤
│  EXPANDABLE DETAILS (Tier 2)                                    │
│  ───────────────────────────────────────────────────────────────│
│  Token breakdown (4 types with log-scale bars)                  │
│  Model usage (horizontal bars with cost)                        │
│  Hourly activity chart                                          │
│  Efficiency metrics (derived calculations)                      │
└─────────────────────────────────────────────────────────────────┘
```

---

## Component Designs

### 1. Hero Card (Shareable)

```
╔══════════════════════════════════════════════════════════════════╗
║                                                                  ║
║                                            ┌──────────────────┐  ║
║                                            │  @maelh          │  ║
║   ┌─────────────────────────────────┐      │  [avatar]        │  ║
║   │                                 │      │  Since Nov '24   │  ║
║   │    T H E   C O N T E X T        │      └──────────────────┘  ║
║   │     M A X I M I Z E R           │                            ║
║   │                                 │      Rank #1               ║
║   │           $2,252                │      of 1,247 users        ║
║   │    ─────────────────────        │                            ║
║   │      invested in Claude         │      ┌──────────────────┐  ║
║   │                                 │      │   TOP 0.1%       │  ║
║   └─────────────────────────────────┘      │   ████████████   │  ║
║                                            └──────────────────┘  ║
║                                                                  ║
║   "You've processed more context than 47 copies of War & Peace" ║
║                                                                  ║
║   ──────────────────────────────────────────────────────────────║
║                           clawd.gg                               ║
╚══════════════════════════════════════════════════════════════════╝
```

**Design notes:**
- 1200x630 aspect ratio (Twitter card)
- Centered, symmetric layout
- Archetype in spaced caps
- ONE hero number (cost)
- Subtle scanline texture overlay

### 2. Stat Row Component

```tsx
interface StatRowProps {
  label: string;
  value: string;
  detail?: string;
  percentile?: string;
}

// Visual:
// Tokens          7.5M     Top 2%
// └ label         └ value  └ percentile badge
```

### 3. Token Breakdown (Expandable)

```
TOKEN COMPOSITION                                           [close]
────────────────────────────────────────────────────────────────────

┌──────────────────────────────────────────────────────────────────┐
│ Cache Reads  ████████████████████████████████████████████   2.1B │
│ Output       ████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   6.9M │
│ Cache Write  ██████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   4.2M │
│ Input        █░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   150K │
└──────────────────────────────────────────────────────────────────┘

INSIGHT: Cache reads (2.1B) are 280x your input — you're
extremely efficient at context reuse.

┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│ Cache Efficiency│  │ Output Leverage │  │ Context Reuse   │
│      85%        │  │      46x        │  │     97.3%       │
│  ▲ Excellent    │  │  ▲ Very High    │  │  ▲ Top 1%       │
└─────────────────┘  └─────────────────┘  └─────────────────┘
```

Uses log-scale for extreme disparities.

### 4. Model Usage

```
MODEL PREFERENCES
────────────────────────────────────────────────────────────────────

┌──────────────────────────────────────────────────────────────────┐
│ ████████████████████████████████████████████░░░░░░░░░░░░░░░░░░░ │
│ ◆ Sonnet 4.5 ─────────────────────────────────────────────── 58% │
│   4.4M tokens • $1,340                                           │
│                                                                  │
│ ████████████████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│ ◆ Opus 4.5 ───────────────────────────────────────────────── 41% │
│   3.1M tokens • $890                                             │
│                                                                  │
│ █░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│ ◆ Haiku ─────────────────────────────────────────────────── 0.4% │
│   30K tokens • $2                                                │
└──────────────────────────────────────────────────────────────────┘

INSIGHT: You prefer Sonnet for daily work, switching to Opus for
complex tasks. You use Opus 3x more than the average user.
```

Horizontal bars, not pie charts.

### 5. Activity Section

```
ACTIVITY
────────────────────────────────────────────────────────────────────

     Jan   Feb   Mar   Apr   May   Jun   Jul   Aug   Sep   Oct   Nov
Mon  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓▒▓█▒░░░░░░
Tue  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▒▓▒▓░░░░░░
Wed  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓█▓█▒▒░░░░░░
Thu  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░█▓▒█▓░░░░░░
Fri  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▒█▒█▓░░░░░░░
Sat  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓▒░▒▓░░░░░░░
Sun  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓░▒░░░░░░░

Less ░ ▒ ▓ █ More                           [Hover for details]

────────────────────────────────────────────────────────────────────

🔥 3 days          🏆 10 days         📅 30/42         💬 104
   current streak     best streak        active days      sessions
```

---

## Copy Guidelines

### Voice Characteristics

| Trait | Description | Example |
|-------|-------------|---------|
| **Knowing** | Like a friend who gets it | Not explaining what tokens are |
| **Understated** | Confidence, not hype | "Top 0.1%" not "AMAZING!!!" |
| **Precise** | Specific, not vague | "67% after 8pm" not "mostly at night" |
| **Respectful** | Treats users as professionals | No tutorials, no hand-holding |

### Do vs Don't

| Don't ❌ | Do ✓ |
|----------|------|
| "Congratulations! You've earned the Power User badge! 🎉" | "The Context Maximizer. You process more context than most users see in a year." |
| "Great job! You've written 45,000 lines of code!" | "45,200 lines written. That's 3 novels worth of code." |
| "You're a Power User! 💪" | "The Marathoner. Your average session: 1h 47m." |
| "Keep up your streak for more rewards!" | "3 days and counting." |
| "Share your amazing stats with friends!" | "Copy to clipboard" |
| "Oops! Something went wrong 😅" | "Sync failed. GitHub rate limit exceeded. Try again in 5 minutes." |

### Stat Labels

| Don't ❌ | Do ✓ |
|----------|------|
| "Total Tokens Used" | "Tokens" |
| "Lines of Code Written" | "Lines Written" |
| "Your Current Streak" | "Current Streak" |
| "Estimated Cost" | "$X invested" or just "$X" |

### Comparison Copy

**Good comparisons:**
- "47 copies of War and Peace" (specific, respectable)
- "3 PhD dissertations" (professional)
- "Would take 47 hours to read aloud" (tangible)

**Bad comparisons:**
- "10 million tweets!" (trivial)
- "You could have watched 200 movies" (negative framing)
- "That's like, a lot!" (lazy)

### Empty States

```
Just getting started.

12 prompts • 3 days tracked

Everyone starts somewhere. Keep building.
```

Not patronizing. Not gamifying. Respectful.

---

## Data Requirements

### Current Data (Already Stored)

| Field | Location | Notes |
|-------|----------|-------|
| totalPrompts | users table | User messages only |
| totalTokens | users table | Input + Output (legacy) |
| totalInputTokens | users table | V3 |
| totalOutputTokens | users table | V3 |
| totalCacheReadTokens | users table | V3 |
| totalCacheCreationTokens | users table | V3 |
| totalCostUsd | users table | In cents |
| totalLinesAdded | users table | Lines of code |
| totalCommits | users table | Git commits |
| hourCounts | users table | JSON: hour → count |
| currentStreak | users table | Days |
| longestStreak | users table | Days |
| badges | users table | JSON array |
| daily_stats | daily_stats table | Per-day breakdown |

### New Data Needed

| Field | Purpose | How to Get |
|-------|---------|------------|
| archetype | User's primary archetype | Calculate from existing data |
| archetypeSecondary | Secondary archetype | Calculate from existing data |
| modelUsage | Per-model token breakdown | Query ClickHouse model_usage_daily |
| avgSessionDuration | For Marathoner/Sprinter | Need session tracking in CLI |
| totalActiveSeconds | Total active time | Already in schema, need CLI to send |
| percentiles | Per-metric percentile | Calculate on API request |

### Derived Metrics

| Metric | Formula | Display |
|--------|---------|---------|
| Output Leverage | output_tokens / input_tokens | "46x" |
| Cache Efficiency | cache_read / (input + cache_creation) | "85%" |
| Cost per Line | total_cost / lines_written | "$0.05/line" |
| Cost per Commit | total_cost / commits | "$9.62/commit" |
| Context Reuse | cache_read / (cache_read + input) | "97.3%" |

---

## Technical Implementation

### Server-Rendered SVG (Zero Client JS)

All charts rendered server-side in JSX:

```tsx
// Example: Token breakdown bars
export const TokenBreakdown: FC<Props> = ({ tokens }) => {
  const max = Math.max(...Object.values(tokens));
  const useLog = max / Math.min(...Object.values(tokens).filter(v => v > 0)) > 50;

  const getWidth = (value: number) => {
    if (useLog) return (Math.log10(value + 1) / Math.log10(max + 1)) * 100;
    return (value / max) * 100;
  };

  return (
    <svg viewBox="0 0 400 120" class="w-full">
      {/* Render bars... */}
    </svg>
  );
};
```

### CSS-Only Enhancements

```css
/* Glow effect for hero stat */
.hero-stat {
  text-shadow: 0 0 40px var(--accent-glow);
}

/* Scanline texture */
.card::before {
  content: '';
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(
    0deg,
    transparent,
    transparent 2px,
    rgba(0, 0, 0, 0.03) 2px,
    rgba(0, 0, 0, 0.03) 4px
  );
  pointer-events: none;
}

/* Contribution cell hover */
.contribution-cell:hover {
  transform: scale(1.5);
  box-shadow: 0 0 10px var(--accent-primary);
  z-index: 10;
}
```

### Share Card Generation

Use Satori/OG Image pattern:

```tsx
// GET /api/og/[username].png
import { ImageResponse } from '@vercel/og';

export async function GET(request: Request) {
  const user = await getUser(username);
  return new ImageResponse(<ShareCard user={user} />, {
    width: 1200,
    height: 630
  });
}
```

---

## Entry Points & Flows

### CLI Commands

| Command | Action | Output |
|---------|--------|--------|
| `clawd login` | Authenticate via device flow | Token stored locally |
| `clawd sync` | Upload stats to server | Summary of days synced |
| `clawd setup` | Enable auto-sync (OTel) | Config updated |
| `clawd status` | Show stats + rank | Hero card in terminal |
| `clawd gg` | Sync + Status combined | Full flex experience |

### CLI Output Design

```
$ clawd gg

  Syncing 3 new days...

  ┌──────────────────────────────────────────────────────────────┐
  │                                                              │
  │  THE CONTEXT MAXIMIZER                     @maelh  #1       │
  │  ────────────────────────────────────────────────────────── │
  │                                                              │
  │  $2,252 invested                              Top 0.1%      │
  │  7.5M tokens • 45K lines • 234 commits                      │
  │                                                              │
  │  🔥 5 days (personal best!)                                 │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘

  → clawd.gg/u/maelh
```

### Web Routes

| Route | Purpose | Auth |
|-------|---------|------|
| `/` | Leaderboard | Optional |
| `/u/:username` | User profile | Public |
| `/about` | About page | Public |
| `/api/og/:username.png` | Share card image | Public |

---

## Implementation Phases

### Phase 1: Core Profile Redesign (Priority: HIGH)

**Goal:** Ship the new profile structure with archetype system

**Tasks:**
1. [ ] Add archetype calculation logic to API
2. [ ] Add `archetype` field to users table
3. [ ] Redesign hero section with archetype + cost
4. [ ] Add percentile calculation for key stats
5. [ ] Restructure profile into "Your Numbers" + "Your Style" grid
6. [ ] Update CLI `clawd status` output to match new design
7. [ ] Add comparison text ("47 copies of War and Peace")

**Files to modify:**
- `src/routes/profile.tsx` - Main redesign
- `src/routes/api.ts` - Add archetype calculation
- `src/db/schema.ts` - Add archetype field
- `cli/index.ts` - Update status output

**Estimated scope:** Medium (3-5 focused sessions)

### Phase 2: Token & Model Insights

**Goal:** Add expandable detail sections with derived metrics

**Tasks:**
1. [ ] Create TokenBreakdown component (SVG bars with log scale)
2. [ ] Add derived metrics (leverage ratio, cache efficiency)
3. [ ] Create ModelUsage component (horizontal bars)
4. [ ] Add insight text generation based on patterns
5. [ ] Make sections expandable/collapsible

**Files to modify:**
- `src/components/TokenBreakdown.tsx` - New
- `src/components/ModelUsage.tsx` - New
- `src/routes/profile.tsx` - Integrate components

**Estimated scope:** Medium (2-3 sessions)

### Phase 3: Activity Enhancements

**Goal:** Improve activity visualization and add hourly chart

**Tasks:**
1. [ ] Enhance contribution heatmap with better tooltips
2. [ ] Create HourlyActivity component (bar chart by hour)
3. [ ] Add peak hour detection and display
4. [ ] Improve streak display with visual progress

**Files to modify:**
- `src/routes/profile.tsx` - Enhance ContributionGraph
- `src/components/HourlyActivity.tsx` - New

**Estimated scope:** Small (1-2 sessions)

### Phase 4: Share Features

**Goal:** Make sharing effortless and beautiful

**Tasks:**
1. [ ] Create ShareCard component for OG images
2. [ ] Add `/api/og/:username.png` endpoint
3. [ ] Add "Download card" button to profile
4. [ ] Update meta tags for social sharing

**Files to modify:**
- `src/components/ShareCard.tsx` - New
- `src/routes/og.tsx` - New endpoint
- `src/routes/profile.tsx` - Add download button

**Estimated scope:** Medium (2-3 sessions)

### Phase 5: Polish & Refinement

**Goal:** Apply the full design system

**Tasks:**
1. [ ] Add new fonts (Space Mono, Geist Mono)
2. [ ] Apply color palette consistently
3. [ ] Add scanline/grain texture effects
4. [ ] Add subtle glow effects
5. [ ] Ensure mobile responsiveness
6. [ ] Performance optimization

**Estimated scope:** Small (1-2 sessions)

---

## Anti-Patterns

### Never Do This

| Anti-Pattern | Why It's Bad |
|--------------|--------------|
| Badges for everything | Feels cheap, gamified |
| Excessive emojis | Unprofessional |
| "Congratulations!" copy | Patronizing |
| Daily notifications | Annoying |
| Social sharing prompts | Desperate |
| Progress bars to "next level" | This isn't a game |
| Leaderboard trash talk | Toxic |
| "Invite friends" CTAs | Growth hacky |

### The Rule

> If it would feel at home in a mobile game, it doesn't belong here.

---

## Success Metrics

### Qualitative

- Users screenshot and share profiles without prompting
- "That's me" reaction to archetype reveal
- Return visits without push notifications
- Organic word-of-mouth growth

### Quantitative

- Profile view → share conversion rate
- Return visit rate (weekly active / total users)
- Time on profile page
- CLI → web conversion rate

---

## Appendix: File Structure

```
src/
├── routes/
│   ├── profile.tsx       # Main profile page (redesign)
│   ├── index.tsx         # Leaderboard (future update)
│   ├── api.ts            # API endpoints (add archetype calc)
│   └── og.tsx            # OG image generation (new)
├── components/
│   ├── TokenBreakdown.tsx    # Token composition chart (new)
│   ├── ModelUsage.tsx        # Model usage chart (new)
│   ├── HourlyActivity.tsx    # Hourly activity chart (new)
│   ├── ShareCard.tsx         # Shareable card component (new)
│   └── StatRow.tsx           # Reusable stat row (new)
├── lib/
│   ├── archetypes.ts     # Archetype calculation logic (new)
│   ├── insights.ts       # Insight text generation (new)
│   └── formatting.ts     # Number formatting utilities
└── db/
    └── schema.ts         # Add archetype field

cli/
└── index.ts              # Update status output
```

---

## References

- Agent Research: Entry points mapping
- Agent Research: Psychology of flexing
- Agent Research: Design critique
- Agent Research: Creative insights
- Agent Research: Tech implementation
- Frontend Design Skill: Visual direction
