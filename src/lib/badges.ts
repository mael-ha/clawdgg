// Badge definitions and detection logic
// I designed these to be fun and personality-based, not competitive

export interface Badge {
  id: string;
  name: string;
  emoji: string;
  description: string;
}

// All available badges
export const BADGES: Record<string, Badge> = {
  // Time-based
  night_owl: {
    id: 'night_owl',
    name: 'Night Owl',
    emoji: '🦉',
    description: '5+ sessions after midnight',
  },
  early_bird: {
    id: 'early_bird',
    name: 'Early Bird',
    emoji: '🐦',
    description: '5+ sessions before 7am',
  },

  // Streak-based
  on_fire: {
    id: 'on_fire',
    name: 'On Fire',
    emoji: '🔥',
    description: 'Currently on a 3+ day streak',
  },
  streak_7: {
    id: 'streak_7',
    name: 'Week Warrior',
    emoji: '⚡',
    description: '7-day streak achieved',
  },
  streak_30: {
    id: 'streak_30',
    name: 'Unstoppable',
    emoji: '💪',
    description: '30-day streak achieved',
  },

  // Message milestones
  messages_1k: {
    id: 'messages_1k',
    name: '1K Club',
    emoji: '💬',
    description: '1,000+ messages',
  },
  messages_5k: {
    id: 'messages_5k',
    name: 'Chatterbox',
    emoji: '🗣️',
    description: '5,000+ messages',
  },
  messages_10k: {
    id: 'messages_10k',
    name: 'Claude Whisperer',
    emoji: '🤖',
    description: '10,000+ messages',
  },

  // Tool milestones
  tools_1k: {
    id: 'tools_1k',
    name: 'Tool Time',
    emoji: '🛠️',
    description: '1,000+ tool calls',
  },
  tools_5k: {
    id: 'tools_5k',
    name: 'Automation Pro',
    emoji: '⚙️',
    description: '5,000+ tool calls',
  },

  // Session-based
  marathon: {
    id: 'marathon',
    name: 'Marathon',
    emoji: '🏃',
    description: 'Single session with 500+ messages',
  },

  // Special
  og: {
    id: 'og',
    name: 'OG',
    emoji: '👑',
    description: 'Among the first 100 users',
  },
};

export interface BadgeInput {
  totalMessages: number;
  totalToolCalls: number;
  currentStreak: number;
  longestStreak: number;
  longestSessionMessages: number;
  hourCounts: Record<string, number>; // { "0": 5, "1": 2, ... }
  userRank?: number; // Position in signup order
}

/**
 * Compute which badges a user has earned based on their stats
 */
export function computeBadges(input: BadgeInput): string[] {
  const earned: string[] = [];

  // Time-based badges
  const nightHours = ['0', '1', '2', '3', '4']; // midnight to 4am
  const earlyHours = ['5', '6']; // 5am to 6am

  const nightSessions = nightHours.reduce(
    (sum, h) => sum + (input.hourCounts[h] || 0),
    0
  );
  const earlySessions = earlyHours.reduce(
    (sum, h) => sum + (input.hourCounts[h] || 0),
    0
  );

  if (nightSessions >= 5) earned.push('night_owl');
  if (earlySessions >= 5) earned.push('early_bird');

  // Streak badges
  if (input.currentStreak >= 3) earned.push('on_fire');
  if (input.longestStreak >= 7) earned.push('streak_7');
  if (input.longestStreak >= 30) earned.push('streak_30');

  // Message milestones
  if (input.totalMessages >= 1000) earned.push('messages_1k');
  if (input.totalMessages >= 5000) earned.push('messages_5k');
  if (input.totalMessages >= 10000) earned.push('messages_10k');

  // Tool milestones
  if (input.totalToolCalls >= 1000) earned.push('tools_1k');
  if (input.totalToolCalls >= 5000) earned.push('tools_5k');

  // Session-based
  if (input.longestSessionMessages >= 500) earned.push('marathon');

  // Special badges
  if (input.userRank !== undefined && input.userRank <= 100) {
    earned.push('og');
  }

  return earned;
}

/**
 * Get badge objects for a list of badge IDs
 */
export function getBadges(badgeIds: string[]): Badge[] {
  return badgeIds
    .map((id) => BADGES[id])
    .filter((b): b is Badge => b !== undefined);
}

/**
 * Format badges for display (emoji only, for leaderboard)
 */
export function formatBadgesCompact(badgeIds: string[]): string {
  return getBadges(badgeIds)
    .slice(0, 3) // Max 3 badges shown
    .map((b) => b.emoji)
    .join('');
}
