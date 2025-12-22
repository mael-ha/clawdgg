// ═══════════════════════════════════════════════════════════════════════════
// ARCHETYPES - Identity-first user classification
// ═══════════════════════════════════════════════════════════════════════════
//
// Philosophy: An archetype isn't a badge you earn. It's a mirror that reflects
// how you work. It should make users go: "Yeah... that IS me."
//
// Each archetype is stated as fact, not awarded as prize.
// ═══════════════════════════════════════════════════════════════════════════

export interface ArchetypeScore {
  id: string;
  name: string;
  score: number;      // 0-100 confidence
  description: string;  // One-line description
  trigger: string;    // Human-readable reason why this applies
}

export interface ArchetypeInput {
  // Token data
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;

  // Activity patterns
  hourCounts: Record<string, number> | null;  // {"0": 5, "1": 2, ...}

  // Session data (if available)
  avgSessionMinutes?: number;
  longestSessionMinutes?: number;

  // Model usage (if available)
  modelUsage?: {
    opus: number;    // Tokens or percentage
    sonnet: number;
    haiku: number;
  };

  // Efficiency metrics
  totalPrompts: number;
  totalLinesWritten: number;
  totalCommits: number;

  // Comparative data (for percentile-based archetypes)
  percentiles?: {
    outputInputRatio?: number;  // What percentile is their output/input ratio
    linesPerToken?: number;
  };

  // User tenure
  firstSessionDate?: string;
  isBetaUser?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// ARCHETYPE DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════

const ARCHETYPES = {
  context_maximizer: {
    id: 'context_maximizer',
    name: 'The Context Maximizer',
    description: 'You give Claude everything. Maximum context, maximum understanding.',
    check: (input: ArchetypeInput): ArchetypeScore | null => {
      const totalInput = input.totalInputTokens + input.totalCacheCreationTokens;
      if (totalInput === 0) return null;

      const cacheRatio = input.totalCacheReadTokens / totalInput;

      // High cache read ratio means they're reusing context efficiently
      if (cacheRatio >= 10) {
        return {
          id: 'context_maximizer',
          name: 'The Context Maximizer',
          description: 'You give Claude everything. Maximum context, maximum understanding.',
          score: Math.min(100, cacheRatio * 5),
          trigger: `${Math.round(cacheRatio)}x cache reuse ratio`
        };
      }
      return null;
    }
  },

  night_owl: {
    id: 'night_owl',
    name: 'The Night Owl',
    description: 'Your best work happens after dark.',
    check: (input: ArchetypeInput): ArchetypeScore | null => {
      if (!input.hourCounts) return null;

      const nightHours = ['20', '21', '22', '23', '0', '1', '2', '3', '4'];
      const counts = input.hourCounts;

      const nightActivity = nightHours.reduce((sum, h) => sum + (counts[h] || 0), 0);
      const totalActivity = Object.values(counts).reduce((a, b) => a + b, 0);

      if (totalActivity === 0) return null;

      const nightPct = nightActivity / totalActivity;

      if (nightPct >= 0.5) {  // 50%+ activity at night
        return {
          id: 'night_owl',
          name: 'The Night Owl',
          description: 'Your best work happens after dark.',
          score: Math.min(100, nightPct * 120),
          trigger: `${Math.round(nightPct * 100)}% of activity after 8pm`
        };
      }
      return null;
    }
  },

  early_bird: {
    id: 'early_bird',
    name: 'The Early Bird',
    description: 'First code of the day, every day.',
    check: (input: ArchetypeInput): ArchetypeScore | null => {
      if (!input.hourCounts) return null;

      const morningHours = ['5', '6', '7', '8', '9'];
      const counts = input.hourCounts;

      const morningActivity = morningHours.reduce((sum, h) => sum + (counts[h] || 0), 0);
      const totalActivity = Object.values(counts).reduce((a, b) => a + b, 0);

      if (totalActivity === 0) return null;

      const morningPct = morningActivity / totalActivity;

      if (morningPct >= 0.4) {  // 40%+ activity in morning
        return {
          id: 'early_bird',
          name: 'The Early Bird',
          description: 'First code of the day, every day.',
          score: Math.min(100, morningPct * 150),
          trigger: `${Math.round(morningPct * 100)}% of activity before 10am`
        };
      }
      return null;
    }
  },

  marathoner: {
    id: 'marathoner',
    name: 'The Marathoner',
    description: 'You go deep. Long sessions, thorough exploration.',
    check: (input: ArchetypeInput): ArchetypeScore | null => {
      if (!input.avgSessionMinutes && !input.longestSessionMinutes) return null;

      // Check longest session (> 4 hours = marathon)
      if (input.longestSessionMinutes && input.longestSessionMinutes >= 240) {
        return {
          id: 'marathoner',
          name: 'The Marathoner',
          description: 'You go deep. Long sessions, thorough exploration.',
          score: Math.min(100, (input.longestSessionMinutes / 240) * 60),
          trigger: `Longest session: ${Math.floor(input.longestSessionMinutes / 60)}h ${input.longestSessionMinutes % 60}m`
        };
      }

      // Or check average session (> 2 hours average)
      if (input.avgSessionMinutes && input.avgSessionMinutes >= 120) {
        return {
          id: 'marathoner',
          name: 'The Marathoner',
          description: 'You go deep. Long sessions, thorough exploration.',
          score: Math.min(100, (input.avgSessionMinutes / 120) * 50),
          trigger: `Average session: ${Math.floor(input.avgSessionMinutes / 60)}h ${Math.round(input.avgSessionMinutes % 60)}m`
        };
      }

      return null;
    }
  },

  sprinter: {
    id: 'sprinter',
    name: 'The Sprinter',
    description: 'Quick iterations, rapid prototyping.',
    check: (input: ArchetypeInput): ArchetypeScore | null => {
      if (!input.avgSessionMinutes) return null;

      if (input.avgSessionMinutes <= 30 && input.totalPrompts > 50) {
        return {
          id: 'sprinter',
          name: 'The Sprinter',
          description: 'Quick iterations, rapid prototyping.',
          score: Math.min(100, (30 / input.avgSessionMinutes) * 50),
          trigger: `Average session: ${Math.round(input.avgSessionMinutes)}m`
        };
      }
      return null;
    }
  },

  opus_connoisseur: {
    id: 'opus_connoisseur',
    name: 'The Opus Connoisseur',
    description: 'You demand the best. Premium models, premium results.',
    check: (input: ArchetypeInput): ArchetypeScore | null => {
      if (!input.modelUsage) return null;

      const total = input.modelUsage.opus + input.modelUsage.sonnet + input.modelUsage.haiku;
      if (total === 0) return null;

      const opusPct = input.modelUsage.opus / total;

      if (opusPct >= 0.5) {  // 50%+ Opus usage
        return {
          id: 'opus_connoisseur',
          name: 'The Opus Connoisseur',
          description: 'You demand the best. Premium models, premium results.',
          score: Math.min(100, opusPct * 100),
          trigger: `${Math.round(opusPct * 100)}% Opus usage`
        };
      }
      return null;
    }
  },

  efficiency_expert: {
    id: 'efficiency_expert',
    name: 'The Efficiency Expert',
    description: 'Maximum output, minimum input. Every token counts.',
    check: (input: ArchetypeInput): ArchetypeScore | null => {
      if (input.totalInputTokens === 0) return null;

      const outputInputRatio = input.totalOutputTokens / input.totalInputTokens;

      // High output/input ratio (Claude writes a lot for each prompt)
      if (outputInputRatio >= 30) {
        return {
          id: 'efficiency_expert',
          name: 'The Efficiency Expert',
          description: 'Maximum output, minimum input. Every token counts.',
          score: Math.min(100, outputInputRatio * 2),
          trigger: `${Math.round(outputInputRatio)}x output leverage`
        };
      }
      return null;
    }
  },

  code_machine: {
    id: 'code_machine',
    name: 'The Code Machine',
    description: 'Less talk, more code. Pure productivity.',
    check: (input: ArchetypeInput): ArchetypeScore | null => {
      if (input.totalPrompts === 0) return null;

      const linesPerPrompt = input.totalLinesWritten / input.totalPrompts;

      // High lines per prompt ratio
      if (linesPerPrompt >= 5) {
        return {
          id: 'code_machine',
          name: 'The Code Machine',
          description: 'Less talk, more code. Pure productivity.',
          score: Math.min(100, linesPerPrompt * 10),
          trigger: `${linesPerPrompt.toFixed(1)} lines per prompt`
        };
      }
      return null;
    }
  },

  pioneer: {
    id: 'pioneer',
    name: 'The Pioneer',
    description: 'Here from the beginning. An early believer.',
    check: (input: ArchetypeInput): ArchetypeScore | null => {
      if (input.isBetaUser) {
        return {
          id: 'pioneer',
          name: 'The Pioneer',
          description: 'Here from the beginning. An early believer.',
          score: 100,
          trigger: 'Member since beta'
        };
      }

      // Or check if first session was before a certain date
      if (input.firstSessionDate) {
        const firstDate = new Date(input.firstSessionDate);
        const betaCutoff = new Date('2024-12-01');  // Adjust as needed

        if (firstDate <= betaCutoff) {
          return {
            id: 'pioneer',
            name: 'The Pioneer',
            description: 'Here from the beginning. An early believer.',
            score: 80,
            trigger: `Member since ${firstDate.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`
          };
        }
      }
      return null;
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// MAIN CALCULATION FUNCTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Calculate user archetypes based on their usage data.
 * Returns up to 2 archetypes (primary + secondary) sorted by score.
 */
export function calculateArchetypes(input: ArchetypeInput): ArchetypeScore[] {
  const scores: ArchetypeScore[] = [];

  // Check each archetype
  for (const archetype of Object.values(ARCHETYPES)) {
    const result = archetype.check(input);
    if (result) {
      scores.push(result);
    }
  }

  // Sort by score descending, return top 2
  return scores.sort((a, b) => b.score - a.score).slice(0, 2);
}

/**
 * Get primary archetype (highest scoring) or null if none qualify.
 */
export function getPrimaryArchetype(input: ArchetypeInput): ArchetypeScore | null {
  const archetypes = calculateArchetypes(input);
  return archetypes[0] || null;
}

/**
 * Format archetypes as a display string.
 * Examples:
 *   - "The Night Owl"
 *   - "The Night Owl Marathoner" (composite)
 */
export function formatArchetypeDisplay(archetypes: ArchetypeScore[]): string {
  if (archetypes.length === 0) {
    return 'Claude Code User';
  }

  if (archetypes.length === 1) {
    return archetypes[0].name;
  }

  // Composite: "The Night Owl Marathoner"
  // Take "The X" from first, just "X" from second (remove "The ")
  const first = archetypes[0].name;
  const second = archetypes[1].name.replace(/^The\s+/, '');

  return `${first} ${second}`;
}

/**
 * Get archetype description for display.
 * If composite, combines both descriptions.
 */
export function getArchetypeDescription(archetypes: ArchetypeScore[]): string {
  if (archetypes.length === 0) {
    return 'Just getting started.';
  }

  // Return primary archetype's trigger as the main description
  return archetypes[0].trigger;
}

// ═══════════════════════════════════════════════════════════════════════════
// DERIVED METRICS
// ═══════════════════════════════════════════════════════════════════════════

export interface DerivedMetrics {
  outputLeverage: number;      // output_tokens / input_tokens
  cacheEfficiency: number;     // cache_read / (input + cache_creation) as percentage
  costPerLine: number | null;  // dollars per line
  costPerCommit: number | null; // dollars per commit
  contextReuse: number;        // cache_read / (cache_read + input) as percentage
}

export function calculateDerivedMetrics(
  input: ArchetypeInput,
  totalCostCents: number
): DerivedMetrics {
  const totalCostDollars = totalCostCents / 100;

  // Output Leverage: How much does Claude write per your input?
  const outputLeverage = input.totalInputTokens > 0
    ? input.totalOutputTokens / input.totalInputTokens
    : 0;

  // Cache Efficiency: How much are you reusing vs creating?
  const freshInput = input.totalInputTokens + input.totalCacheCreationTokens;
  const cacheEfficiency = freshInput > 0
    ? (input.totalCacheReadTokens / freshInput) * 100
    : 0;

  // Context Reuse: What % of input is from cache?
  const totalContext = input.totalCacheReadTokens + input.totalInputTokens;
  const contextReuse = totalContext > 0
    ? (input.totalCacheReadTokens / totalContext) * 100
    : 0;

  // Cost per Line
  const costPerLine = input.totalLinesWritten > 0
    ? totalCostDollars / input.totalLinesWritten
    : null;

  // Cost per Commit
  const costPerCommit = input.totalCommits > 0
    ? totalCostDollars / input.totalCommits
    : null;

  return {
    outputLeverage,
    cacheEfficiency,
    costPerLine,
    costPerCommit,
    contextReuse,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PEAK HOUR DETECTION
// ═══════════════════════════════════════════════════════════════════════════

export interface PeakHourInfo {
  hour: number;           // 0-23
  displayHour: string;    // "6-7pm"
  percentage: number;     // What % of activity happens at this hour
  timeOfDay: 'morning' | 'afternoon' | 'evening' | 'night';
}

export function getPeakHour(hourCounts: Record<string, number> | null): PeakHourInfo | null {
  if (!hourCounts) return null;

  const values = Object.values(hourCounts);
  if (values.length === 0) return null;

  const total = values.reduce((a, b) => a + b, 0);
  if (total === 0) return null;

  // Find peak hour
  let peakHour = 0;
  let peakCount = 0;

  for (const [hour, count] of Object.entries(hourCounts)) {
    if (count > peakCount) {
      peakCount = count;
      peakHour = parseInt(hour);
    }
  }

  // Format display hour
  const nextHour = (peakHour + 1) % 24;
  const formatHour = (h: number): string => {
    if (h === 0) return '12am';
    if (h === 12) return '12pm';
    return h < 12 ? `${h}am` : `${h - 12}pm`;
  };

  const displayHour = `${formatHour(peakHour)}-${formatHour(nextHour)}`;

  // Determine time of day
  let timeOfDay: 'morning' | 'afternoon' | 'evening' | 'night';
  if (peakHour >= 5 && peakHour < 12) timeOfDay = 'morning';
  else if (peakHour >= 12 && peakHour < 17) timeOfDay = 'afternoon';
  else if (peakHour >= 17 && peakHour < 21) timeOfDay = 'evening';
  else timeOfDay = 'night';

  return {
    hour: peakHour,
    displayHour,
    percentage: Math.round((peakCount / total) * 100),
    timeOfDay,
  };
}
