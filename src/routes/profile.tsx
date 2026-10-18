import { Hono } from 'hono';
import type { FC } from 'hono/jsx';
import { Layout } from '../components/Layout';
import { db } from '../db';
import { dailyStats, users } from '../db/schema';
import { eq, sql, asc } from 'drizzle-orm';
import { getBadges, BADGES } from '../lib/badges';
import { formatCost, formatHours, formatTokens } from '../lib/format';
import { getTokenComparison } from '../lib/comparisons';
import {
  calculateArchetypes,
  formatArchetypeDisplay,
  getArchetypeDescription,
  calculateDerivedMetrics,
  getPeakHour,
  type ArchetypeInput,
  type ArchetypeScore,
  type DerivedMetrics,
  type PeakHourInfo
} from '../lib/archetypes';
import { TokenBar } from '../components/TokenBar';
import { ActivityRadar } from '../components/ActivityRadar';
import { AnalyticsChart } from '../components/AnalyticsChart';
import { LanguageChart } from '../components/LanguageChart';
import { ToolkitChart } from '../components/ToolkitChart';
import { TrustStyleComponent } from '../components/TrustStyle';
import { EfficiencyMetrics } from '../components/EfficiencyMetrics';
import type { SessionUser } from '../types';
import {
  clickhouse,
  type TodayMetrics,
  type CacheStats,
  type LanguageStats,
  type ToolStats,
  type TrustStyle,
  type AgenticStats,
  type TerminalStats,
  type TodayMetricsEnhanced,
} from '../db/clickhouse';

type Variables = {
  user: SessionUser | null;
};

const app = new Hono<{ Variables: Variables }>();

// ═══════════════════════════════════════════════════════════════════════════
// COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════

// Contribution graph (GitHub-style, 365 days)
interface ContributionDay {
  date: string;
  count: number;
  level: 0 | 1 | 2 | 3 | 4;
  // Rich data for enhanced tooltips (OTEL users)
  tokens?: number;
  linesAdded?: number;
  linesRemoved?: number;
  costUsd?: number;
}

const ContributionGraph: FC<{ days: ContributionDay[] }> = ({ days }) => {
  const dayMap = new Map(days.map(d => [d.date, d]));
  const allDays: ContributionDay[] = [];
  const today = new Date();

  for (let i = 364; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0] as string;
    const existing = dayMap.get(dateStr);
    allDays.push(existing || { date: dateStr, count: 0, level: 0 as const });
  }

  const weeks: ContributionDay[][] = [];
  let currentWeek: ContributionDay[] = [];
  const firstDay = allDays[0];
  const firstDayOfWeek = firstDay ? new Date(firstDay.date).getDay() : 0;

  for (let i = 0; i < firstDayOfWeek; i++) {
    currentWeek.push({ date: '', count: 0, level: 0 });
  }

  for (const day of allDays) {
    currentWeek.push(day);
    if (currentWeek.length === 7) {
      weeks.push(currentWeek);
      currentWeek = [];
    }
  }
  if (currentWeek.length > 0) weeks.push(currentWeek);

  const levelColors = [
    'bg-gray-800',
    'bg-cyan-900',
    'bg-cyan-700',
    'bg-cyan-500',
    'bg-cyan-300',
  ];

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Build data attributes for rich tooltip
  const buildDataAttrs = (day: ContributionDay) => {
    if (!day.date) return {};
    const attrs: Record<string, string> = {
      'data-date': day.date,
      'data-count': String(day.count),
    };
    // Always include rich data when available (for both OTEL and legacy days)
    if (day.tokens !== undefined) attrs['data-tokens'] = String(day.tokens);
    if (day.linesAdded !== undefined) attrs['data-lines-added'] = String(day.linesAdded);
    if (day.linesRemoved !== undefined) attrs['data-lines-removed'] = String(day.linesRemoved);
    if (day.costUsd !== undefined) attrs['data-cost'] = String(day.costUsd);
    return attrs;
  };

  return (
    <div class="overflow-x-auto relative" id="contribution-graph-container">
      {/* Custom tooltip */}
      <div
        id="contrib-tooltip"
        class="absolute z-50 hidden px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg shadow-xl text-xs font-mono pointer-events-none"
        style="transform: translateX(-50%);"
      />

      <div class="inline-block min-w-max">
        <div class="flex mb-1 ml-8">
          {weeks.map((week, i) => {
            if (i === 0 || i % 4 === 0) {
              const firstValidDay = week.find(d => d.date);
              if (firstValidDay) {
                const month = new Date(firstValidDay.date).getMonth();
                return <span class="text-xs text-gray-500 w-12">{months[month]}</span>;
              }
            }
            return null;
          })}
        </div>
        <div class="flex gap-[2px]">
          <div class="flex flex-col gap-[2px] mr-2 text-xs text-gray-500">
            <span class="h-[10px]"></span>
            <span class="h-[10px]">Mon</span>
            <span class="h-[10px]"></span>
            <span class="h-[10px]">Wed</span>
            <span class="h-[10px]"></span>
            <span class="h-[10px]">Fri</span>
            <span class="h-[10px]"></span>
          </div>
          {weeks.map((week, weekIdx) => (
            <div key={weekIdx} class="flex flex-col gap-[2px]">
              {week.map((day, dayIdx) => (
                <div
                  key={dayIdx}
                  class={`contrib-cell w-[10px] h-[10px] rounded-sm ${day.date ? levelColors[day.level] : 'bg-transparent'} ${day.date ? 'cursor-pointer hover:ring-1 hover:ring-gray-600 transition-all' : ''}`}
                  {...buildDataAttrs(day)}
                />
              ))}
            </div>
          ))}
        </div>
        <div class="flex items-center gap-1 mt-2 justify-end text-xs text-gray-500">
          <span>Less</span>
          {levelColors.map((color, i) => (
            <div key={i} class={`w-[10px] h-[10px] rounded-sm ${color}`} />
          ))}
          <span>More</span>
        </div>
      </div>

      {/* Tooltip script */}
      <script dangerouslySetInnerHTML={{
        __html: `
          (function() {
            const container = document.getElementById('contribution-graph-container');
            const tooltip = document.getElementById('contrib-tooltip');
            if (!container || !tooltip) return;

            function formatNum(n) {
              n = parseInt(n, 10) || 0;
              if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
              if (n >= 1000) return Math.round(n / 1000) + 'K';
              return n.toString();
            }

            function formatDate(dateStr) {
              const d = new Date(dateStr);
              const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
              return months[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
            }

            container.addEventListener('mouseover', function(e) {
              const cell = e.target.closest('.contrib-cell');
              if (!cell || !cell.dataset.date) return;

              const date = cell.dataset.date;
              const count = parseInt(cell.dataset.count, 10) || 0;
              const tokens = cell.dataset.tokens;
              const linesAdded = cell.dataset.linesAdded;
              const linesRemoved = cell.dataset.linesRemoved;
              const cost = cell.dataset.cost;

              let html = '<div class="text-gray-300 mb-1">' + formatDate(date) + '</div>';
              html += '<div class="border-t border-gray-700 pt-1 mt-1 space-y-0.5">';
              if (count > 0) {
                html += '<div class="text-white">' + count + ' prompts</div>';
              } else if (tokens !== undefined && parseInt(tokens, 10) > 0) {
                html += '<div class="text-gray-500 text-xs italic">backfilled — prompt count unavailable</div>';
              }

              if (tokens !== undefined) {
                html += '<div class="text-cyan-400">' + formatNum(tokens) + ' tokens</div>';
              }
              if (linesAdded !== undefined || linesRemoved !== undefined) {
                const added = parseInt(linesAdded, 10) || 0;
                const removed = parseInt(linesRemoved, 10) || 0;
                // Show +/- format for OTEL data, just + for legacy (no removed tracking)
                if (linesRemoved !== undefined) {
                  html += '<div><span class="text-green-400">+' + formatNum(added) + '</span> / <span class="text-red-400">-' + formatNum(removed) + '</span> lines</div>';
                } else {
                  html += '<div><span class="text-green-400">+' + formatNum(added) + ' lines</span></div>';
                }
              }
              if (cost !== undefined) {
                const costVal = parseFloat(cost) || 0;
                html += '<div class="text-amber-400">$' + (costVal >= 1 ? costVal.toFixed(0) : costVal.toFixed(2)) + '</div>';
              }
              html += '</div>';

              tooltip.innerHTML = html;
              tooltip.classList.remove('hidden');

              const rect = cell.getBoundingClientRect();
              const containerRect = container.getBoundingClientRect();
              tooltip.style.left = (rect.left - containerRect.left + rect.width / 2) + 'px';
              tooltip.style.top = (rect.top - containerRect.top - tooltip.offsetHeight - 8) + 'px';
            });

            container.addEventListener('mouseout', function(e) {
              if (!e.target.closest('.contrib-cell')) return;
              tooltip.classList.add('hidden');
            });
          })();
        `
      }} />
    </div>
  );
};

// Stat row for the two-column grid
interface StatRowProps {
  label: string;
  value: string;
  percentile?: string;
  detail?: string;
}

const StatRow: FC<StatRowProps> = ({ label, value, percentile, detail }) => (
  <div class="flex items-center justify-between py-3 border-b border-gray-800/50 last:border-0">
    <div class="flex flex-col">
      <span class="text-gray-400 text-sm">{label}</span>
      {detail && <span class="text-gray-600 text-xs">{detail}</span>}
    </div>
    <div class="flex items-center gap-3">
      <span class="text-gray-100 font-mono text-lg">{value}</span>
      {percentile && (
        <span class="text-xs px-2 py-0.5 bg-cyan-500/10 text-cyan-400 rounded-full border border-cyan-500/20">
          {percentile}
        </span>
      )}
    </div>
  </div>
);

// Style row for "Your Style" section
interface StyleRowProps {
  label: string;
  value: string;
  subvalue?: string;
  icon?: string;
}

const StyleRow: FC<StyleRowProps> = ({ label, value, subvalue, icon }) => (
  <div class="flex items-center justify-between py-3 border-b border-gray-800/50 last:border-0">
    <span class="text-gray-400 text-sm">{label}</span>
    <div class="flex items-center gap-2">
      {icon && <span>{icon}</span>}
      <div class="text-right">
        <div class="text-gray-100 font-mono">{value}</div>
        {subvalue && <div class="text-gray-500 text-xs">{subvalue}</div>}
      </div>
    </div>
  </div>
);

// Today's Activity Widget (OTEL users only)
interface TodayWidgetProps {
  today: TodayMetrics;
  cacheStats: CacheStats | null;
}

const TodayWidget: FC<TodayWidgetProps> = ({ today, cacheStats }) => {
  const costFormatted = today.costUsd >= 1
    ? `$${today.costUsd.toFixed(0)}`
    : `$${today.costUsd.toFixed(2)}`;

  return (
    <div class="relative mb-8 p-6 bg-gradient-to-br from-green-500/5 via-transparent to-cyan-500/5 border border-green-500/20 rounded-2xl overflow-hidden">
      {/* Live indicator */}
      <div class="absolute top-4 right-4 flex items-center gap-2">
        <span class="relative flex h-2 w-2">
          <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
          <span class="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
        </span>
        <span class="text-green-400 text-xs font-mono">LIVE</span>
      </div>

      <h2 class="text-gray-400 text-xs uppercase tracking-[0.3em] mb-4 font-mono">Today's Activity</h2>

      <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div>
          <div class="text-2xl font-bold text-white font-mono">{today.prompts}</div>
          <div class="text-gray-600 text-xs font-mono">prompts</div>
        </div>
        <div>
          <div class="text-2xl font-bold text-green-400 font-mono">{costFormatted}</div>
          <div class="text-gray-600 text-xs font-mono">spent</div>
        </div>
        <div>
          <div class="text-2xl font-bold text-cyan-400 font-mono">{formatTokens(today.linesAdded)}</div>
          <div class="text-gray-600 text-xs font-mono">lines</div>
        </div>
        <div>
          <div class="text-2xl font-bold text-purple-400 font-mono">{today.commits}</div>
          <div class="text-gray-600 text-xs font-mono">commits</div>
        </div>
      </div>

      {/* Cache savings callout */}
      {cacheStats && cacheStats.estimatedSavingsUsd > 1 && (
        <div class="mt-4 pt-4 border-t border-gray-800/50">
          <div class="flex items-center gap-2">
            <span class="text-amber-400">$</span>
            <span class="text-amber-300 font-mono font-bold">{cacheStats.estimatedSavingsUsd.toFixed(0)}</span>
            <span class="text-gray-500 text-sm">saved by caching</span>
            <span class="text-gray-600 text-xs">({cacheStats.cacheHitRate.toFixed(0)}% cache hit rate)</span>
          </div>
        </div>
      )}
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════════
// PROFILE PAGE
// ═══════════════════════════════════════════════════════════════════════════

interface ProfileData {
  username: string;
  avatarUrl: string | null;
  firstSessionDate: string | null;
  badges: string[];
  currentStreak: number;
  longestStreak: number;

  // Core metrics
  totalPrompts: number;
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalCostCents: number;
  totalLinesWritten: number;
  totalCommits: number;
  totalActiveSeconds: number;

  // Legacy (backward compat)
  totalMessages: number;
  totalToolCalls: number;

  // Ranking
  rank: number;
  totalUsers: number;

  // Activity patterns
  hourCounts: Record<string, number> | null;
}

interface ProfileProps {
  profile: ProfileData;
  archetypes: ArchetypeScore[];
  derivedMetrics: DerivedMetrics;
  peakHour: PeakHourInfo | null;
  contributions: ContributionDay[];
  currentUser: SessionUser | null;
  // OTEL-specific data (only for own profile)
  todayMetrics: TodayMetrics | null;
  cacheStats: CacheStats | null;
  isOtelEnabled: boolean;
  // NEW: Profile Signature data
  languageStats: LanguageStats[];
  toolStats: ToolStats[];
  trustStyle: TrustStyle | null;
  agenticStats: AgenticStats | null;
  terminalStats: TerminalStats[];
  todayEnhanced: TodayMetricsEnhanced | null;
}

const Profile: FC<ProfileProps> = ({
  profile,
  archetypes,
  derivedMetrics,
  peakHour,
  contributions,
  currentUser,
  todayMetrics,
  cacheStats,
  isOtelEnabled,
  languageStats,
  toolStats,
  trustStyle,
  agenticStats,
  terminalStats,
  todayEnhanced,
}) => {
  const isOwnProfile = currentUser?.githubUsername === profile.username;
  const memberSince = profile.firstSessionDate
    ? new Date(profile.firstSessionDate).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
    : null;
  const totalDaysSinceStart = profile.firstSessionDate
    ? Math.floor((Date.now() - new Date(profile.firstSessionDate).getTime()) / (1000 * 60 * 60 * 24)) + 1
    : null;

  // Calculate percentile
  const percentile = profile.totalUsers > 0
    ? Math.max(0.1, Math.ceil((profile.rank / profile.totalUsers) * 1000) / 10)
    : 100;
  const percentileDisplay = percentile < 1 ? `Top ${percentile}%` : `Top ${Math.round(percentile)}%`;

  // Archetype display
  const archetypeDisplay = formatArchetypeDisplay(archetypes);
  const archetypeDescription = getArchetypeDescription(archetypes);

  // Fun comparison for share text
  const funComparison = getTokenComparison(profile.totalTokens);

  // Share text
  const shareText = `${archetypeDisplay}

${formatCost(profile.totalCostCents)} invested in Claude
#${profile.rank} • ${percentileDisplay} of users

${funComparison}

clawd.gg/u/${profile.username}`;

  // Check if we have token data for the orbit visualization
  const hasTokenData = profile.totalInputTokens > 0 || profile.totalOutputTokens > 0 || profile.totalCacheReadTokens > 0;
  const hasHourData = profile.hourCounts && Object.keys(profile.hourCounts).length > 0;

  return (
    <div class="min-h-screen bg-black">
      {/* Header */}
      <header class="border-b border-gray-800/50 py-4 px-4">
        <div class="max-w-5xl mx-auto flex justify-between items-center">
          <a href="/" class="text-gray-600 hover:text-cyan-400 font-mono text-sm transition-colors">
            ← back
          </a>
          {isOwnProfile && (
            <button
              data-share-text={shareText}
              onclick="navigator.clipboard.writeText(this.dataset.shareText).then(() => { this.textContent = '✓ copied'; setTimeout(() => this.textContent = 'copy stats', 2000); });"
              class="px-3 py-1.5 bg-transparent hover:bg-gray-900 border border-gray-800 hover:border-gray-700 rounded text-gray-500 hover:text-gray-300 font-mono text-xs transition-all"
            >
              copy stats
            </button>
          )}
        </div>
      </header>

      <main class="max-w-5xl mx-auto px-4 py-8">
        {/* ════════════════════════════════════════════════════════════════════
            LIVE TODAY WIDGET (OTEL users viewing own profile only)
            ════════════════════════════════════════════════════════════════════ */}
        {isOwnProfile && isOtelEnabled && todayMetrics && (
          <TodayWidget today={todayMetrics} cacheStats={cacheStats} />
        )}

        {/* ════════════════════════════════════════════════════════════════════
            COMMAND CENTER HERO
            Dramatic centered layout with glowing accents
            ════════════════════════════════════════════════════════════════════ */}
        <div class="relative mb-16 text-center">
          {/* Background glow effects */}
          <div class="absolute inset-0 flex items-center justify-center pointer-events-none overflow-hidden">
            <div class="w-[600px] h-[600px] bg-cyan-500/5 rounded-full blur-3xl" />
          </div>
          <div class="absolute top-0 left-1/2 -translate-x-1/2 w-px h-20 bg-gradient-to-b from-transparent via-cyan-500/30 to-transparent" />

          {/* User identity */}
          <div class="relative inline-flex flex-col items-center mb-8">
            {profile.rank === 1 && (
              <div class="absolute -top-6 text-3xl animate-pulse">👑</div>
            )}
            <div class="relative">
              {profile.avatarUrl ? (
                <img
                  src={profile.avatarUrl}
                  alt={profile.username}
                  class="w-20 h-20 rounded-full ring-2 ring-cyan-500/30 ring-offset-4 ring-offset-black"
                />
              ) : (
                <div class="w-20 h-20 rounded-full bg-gray-900 ring-2 ring-cyan-500/30 ring-offset-4 ring-offset-black flex items-center justify-center text-2xl font-bold text-gray-500">
                  {profile.username.slice(0, 2).toUpperCase()}
                </div>
              )}
              {/* Status indicator */}
              <div class="absolute -bottom-1 -right-1 w-5 h-5 bg-green-500 rounded-full border-4 border-black" />
            </div>
            <div class="mt-4">
              <div class="text-white font-mono text-lg">@{profile.username}</div>
              <div class="flex items-center justify-center gap-2 mt-1">
                {memberSince && (
                  <span class="text-gray-600 text-xs font-mono">since {memberSince}</span>
                )}
                {terminalStats[0] && (
                  <>
                    <span class="text-gray-700">•</span>
                    <span class="text-gray-500 text-xs font-mono flex items-center gap-1">
                      <span>⌨️</span>
                      <span>{terminalStats[0].terminalType}</span>
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Archetype - The star of the show */}
          <div class="relative mb-8">
            <h1 class="text-3xl md:text-4xl lg:text-5xl font-bold tracking-[0.2em] uppercase"
                style="background: linear-gradient(135deg, #22d3ee 0%, #a855f7 50%, #22d3ee 100%); background-size: 200% auto; -webkit-background-clip: text; -webkit-text-fill-color: transparent; animation: gradient-shift 8s ease infinite;">
              {archetypeDisplay.replace(/^The\s+/i, '')}
            </h1>
            <p class="text-gray-500 text-sm font-mono mt-3 tracking-wider">
              {archetypeDescription}
            </p>
          </div>

          {/* Hero stat: Cost - massive and glowing */}
          <div class="relative inline-block mb-6">
            <div class="text-6xl md:text-7xl lg:text-8xl font-bold text-white"
                 style="text-shadow: 0 0 60px rgba(34, 211, 238, 0.4), 0 0 120px rgba(34, 211, 238, 0.2);">
              {formatCost(profile.totalCostCents)}
            </div>
            <div class="text-gray-600 text-sm font-mono mt-2 tracking-widest uppercase">invested in claude</div>
          </div>

          {/* Rank, active hours, and percentile */}
          <div class="flex items-center justify-center gap-4 sm:gap-6 text-sm flex-wrap">
            {profile.totalActiveSeconds > 0 && (
              <>
                <div class="flex items-center gap-2">
                  <span class="text-gray-600 font-mono">active</span>
                  <span class="text-white font-mono font-bold">{formatHours(profile.totalActiveSeconds)}</span>
                </div>
                <div class="w-px h-4 bg-gray-800 hidden sm:block" />
              </>
            )}
            <div class="flex items-center gap-2">
              <span class="text-gray-600 font-mono">rank</span>
              <span class="text-white font-mono font-bold">#{profile.rank.toLocaleString()}</span>
              <span class="text-gray-700">of {profile.totalUsers.toLocaleString()}</span>
            </div>
            <div class="w-px h-4 bg-gray-800" />
            <div class="px-3 py-1 bg-cyan-500/10 border border-cyan-500/30 rounded-full">
              <span class="text-cyan-400 font-mono text-sm">{percentileDisplay}</span>
            </div>
          </div>

          {/* Fun comparison */}
          <div class="mt-8 text-gray-600 text-xs font-mono">
            {funComparison}
          </div>
        </div>

        {/* ════════════════════════════════════════════════════════════════════
            ANALYTICS CHART - Flexible metrics explorer
            Shown to all users viewing their own profile (supports OTEL + legacy data)
            ════════════════════════════════════════════════════════════════════ */}
        {isOwnProfile && (
          <section class="mb-16">
            <h2 class="text-gray-600 text-xs uppercase tracking-[0.3em] mb-6 font-mono flex items-center gap-2">
              <span class="w-2 h-2 bg-cyan-500 rounded-full animate-pulse" />
              Analytics
            </h2>
            <div class="p-6 bg-gray-950/50 border border-gray-800/50 rounded-2xl backdrop-blur">
              <AnalyticsChart userId={profile.username} />
            </div>
          </section>
        )}

        {/* ════════════════════════════════════════════════════════════════════
            YOUR SIGNATURE - Identity-revealing insights (OTEL users only)
            ════════════════════════════════════════════════════════════════════ */}
        {isOwnProfile && isOtelEnabled && (languageStats.length > 0 || toolStats.length > 0 || trustStyle) && (
          <section class="mb-16">
            <h2 class="text-gray-600 text-xs uppercase tracking-[0.3em] mb-6 font-mono flex items-center gap-2">
              <span class="w-2 h-2 rounded-full" style="background: linear-gradient(135deg, #22d3ee, #a855f7);" />
              Your Signature
            </h2>

            {/* Languages - Full width card */}
            {languageStats.length > 0 && (
              <div class="mb-8 p-4 sm:p-6 bg-gray-950/50 border border-gray-800/50 rounded-2xl backdrop-blur">
                <h3 class="text-gray-600 text-xs uppercase tracking-[0.3em] mb-4 sm:mb-6 font-mono flex items-center gap-2">
                  <span class="w-2 h-2 bg-blue-500 rounded-full" />
                  Languages You Build With
                </h3>
                <LanguageChart languages={languageStats} />
              </div>
            )}

            {/* Toolkit + Trust - Two columns */}
            <div class="grid md:grid-cols-2 gap-8">
              {toolStats.length > 0 && (
                <div class="p-4 sm:p-6 bg-gray-950/50 border border-gray-800/50 rounded-2xl backdrop-blur">
                  <h3 class="text-gray-600 text-xs uppercase tracking-[0.3em] mb-4 sm:mb-6 font-mono flex items-center gap-2">
                    <span class="w-2 h-2 bg-amber-500 rounded-full" />
                    Your Toolkit
                  </h3>
                  <ToolkitChart tools={toolStats} />
                </div>
              )}
              {trustStyle && (
                <div class="p-4 sm:p-6 bg-gray-950/50 border border-gray-800/50 rounded-2xl backdrop-blur">
                  <h3 class="text-gray-600 text-xs uppercase tracking-[0.3em] mb-4 sm:mb-6 font-mono flex items-center gap-2">
                    <span class="w-2 h-2 bg-green-500 rounded-full" />
                    Your Trust Style
                  </h3>
                  <TrustStyleComponent trustStyle={trustStyle} />
                </div>
              )}
            </div>
          </section>
        )}

        {/* ════════════════════════════════════════════════════════════════════
            RADAR DISPLAYS - The cockpit instruments
            ════════════════════════════════════════════════════════════════════ */}
        {(hasTokenData || hasHourData) && (
          <div class="grid md:grid-cols-2 gap-8 mb-16">
            {/* Activity Radar */}
            {hasHourData && profile.hourCounts && (
              <div class="p-4 sm:p-6 bg-gray-950/50 border border-gray-800/50 rounded-2xl backdrop-blur">
                <h2 class="text-gray-600 text-xs uppercase tracking-[0.3em] mb-4 sm:mb-6 font-mono flex items-center gap-2">
                  <span class="w-2 h-2 bg-purple-500 rounded-full animate-pulse" />
                  Activity Patterns
                </h2>
                <ActivityRadar hourCounts={profile.hourCounts} />
              </div>
            )}

            {/* Efficiency Metrics (OTEL) or Token Orbit (legacy) */}
            {isOtelEnabled && agenticStats ? (
              <div class="p-4 sm:p-6 bg-gray-950/50 border border-gray-800/50 rounded-2xl backdrop-blur">
                <h2 class="text-gray-600 text-xs uppercase tracking-[0.3em] mb-4 sm:mb-6 font-mono flex items-center gap-2">
                  <span class="w-2 h-2 bg-cyan-500 rounded-full animate-pulse" />
                  Efficiency
                </h2>
                <EfficiencyMetrics
                  agenticStats={agenticStats}
                  cacheStats={cacheStats}
                  totalOutputTokens={profile.totalOutputTokens}
                  totalInputTokens={profile.totalInputTokens}
                  totalLinesAdded={profile.totalLinesWritten}
                  totalCostUsd={profile.totalCostCents / 100}
                />
              </div>
            ) : hasTokenData && (
              <div class="p-4 sm:p-6 bg-gray-950/50 border border-gray-800/50 rounded-2xl backdrop-blur">
                <h2 class="text-gray-600 text-xs uppercase tracking-[0.3em] mb-4 sm:mb-6 font-mono flex items-center gap-2">
                  <span class="w-2 h-2 bg-cyan-500 rounded-full animate-pulse" />
                  Token Flow
                </h2>
                <TokenBar
                  inputTokens={profile.totalInputTokens}
                  outputTokens={profile.totalOutputTokens}
                  cacheReadTokens={profile.totalCacheReadTokens}
                  cacheCreationTokens={profile.totalCacheCreationTokens}
                />
              </div>
            )}
          </div>
        )}

        {/* ════════════════════════════════════════════════════════════════════
            METRICS GRID - Quick stats with terminal aesthetic
            ════════════════════════════════════════════════════════════════════ */}
        <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-16">
          <div class="p-4 bg-gray-950/30 border border-gray-800/30 rounded-xl text-center group relative">
            <div class="text-2xl font-bold text-white font-mono">{formatTokens(profile.totalTokens)}</div>
            <div class="text-gray-600 text-xs font-mono mt-1">I/O tokens</div>
            <div class="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-gray-900 border border-gray-700 rounded text-xs text-gray-400 whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
              Input + Output (excludes cache)
            </div>
          </div>
          <div class="p-4 bg-gray-950/30 border border-gray-800/30 rounded-xl text-center">
            <div class="text-2xl font-bold text-white font-mono">{formatTokens(profile.totalLinesWritten)}</div>
            <div class="text-gray-600 text-xs font-mono mt-1">lines</div>
          </div>
          <div class="p-4 bg-gray-950/30 border border-gray-800/30 rounded-xl text-center">
            <div class="text-2xl font-bold text-white font-mono">{profile.totalCommits.toLocaleString()}</div>
            <div class="text-gray-600 text-xs font-mono mt-1">commits</div>
          </div>
          <div class="p-4 bg-gray-950/30 border border-gray-800/30 rounded-xl text-center">
            <div class="text-2xl font-bold text-white font-mono">{profile.totalPrompts.toLocaleString()}</div>
            <div class="text-gray-600 text-xs font-mono mt-1">prompts</div>
          </div>
        </div>

        {/* ════════════════════════════════════════════════════════════════════
            DERIVED METRICS - The efficiency story
            ════════════════════════════════════════════════════════════════════ */}
        <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-16">
          {derivedMetrics.outputLeverage > 0 && (
            <div class="p-4 bg-gradient-to-br from-cyan-500/5 to-transparent border border-cyan-500/10 rounded-xl">
              <div class="text-3xl font-bold text-cyan-400 font-mono">{Math.round(derivedMetrics.outputLeverage)}×</div>
              <div class="text-gray-500 text-xs font-mono mt-1">output leverage</div>
            </div>
          )}
          {derivedMetrics.cacheEfficiency > 0 && (
            <div class="p-4 bg-gradient-to-br from-amber-500/5 to-transparent border border-amber-500/10 rounded-xl">
              <div class="text-3xl font-bold text-amber-400 font-mono">{Math.round(derivedMetrics.cacheEfficiency)}%</div>
              <div class="text-gray-500 text-xs font-mono mt-1">cache efficiency</div>
            </div>
          )}
          {derivedMetrics.costPerLine !== null && derivedMetrics.costPerLine > 0 && (
            <div class="p-4 bg-gradient-to-br from-green-500/5 to-transparent border border-green-500/10 rounded-xl">
              <div class="text-3xl font-bold text-green-400 font-mono">${derivedMetrics.costPerLine.toFixed(2)}</div>
              <div class="text-gray-500 text-xs font-mono mt-1">per line</div>
            </div>
          )}
          {derivedMetrics.costPerCommit !== null && derivedMetrics.costPerCommit > 0 && (
            <div class="p-4 bg-gradient-to-br from-purple-500/5 to-transparent border border-purple-500/10 rounded-xl">
              <div class="text-3xl font-bold text-purple-400 font-mono">${derivedMetrics.costPerCommit.toFixed(0)}</div>
              <div class="text-gray-500 text-xs font-mono mt-1">per commit</div>
            </div>
          )}
        </div>

        {/* ════════════════════════════════════════════════════════════════════
            ACTIVITY TIMELINE
            ════════════════════════════════════════════════════════════════════ */}
        <section class="mb-16">
          <h2 class="text-gray-600 text-xs uppercase tracking-[0.3em] mb-6 font-mono flex items-center gap-2">
            <span class="w-2 h-2 bg-green-500 rounded-full" />
            Activity Timeline
          </h2>
          <div class="p-6 bg-gray-950/30 border border-gray-800/30 rounded-2xl">
            <ContributionGraph days={contributions} />

            {/* Streak stats */}
            <div class="mt-6 pt-6 border-t border-gray-800/50 grid grid-cols-2 md:grid-cols-4 gap-4">
              <div class="text-center">
                <div class="text-2xl font-bold text-orange-400 font-mono">{profile.currentStreak}</div>
                <div class="text-gray-600 text-xs font-mono">streak</div>
              </div>
              <div class="text-center">
                <div class="text-2xl font-bold text-amber-400 font-mono">{profile.longestStreak}</div>
                <div class="text-gray-600 text-xs font-mono">best</div>
              </div>
              <div class="text-center">
                <div class="text-2xl font-bold text-gray-300 font-mono">
                  {contributions.filter(d => d.level > 0).length}
                  <span class="text-gray-600 text-lg">/365</span>
                </div>
                <div class="text-gray-600 text-xs font-mono">active days</div>
              </div>
              <div class="text-center">
                <div class="text-2xl font-bold text-gray-300 font-mono">{profile.totalToolCalls || '—'}</div>
                <div class="text-gray-600 text-xs font-mono">tool calls</div>
              </div>
            </div>
          </div>
        </section>

        {/* ════════════════════════════════════════════════════════════════════
            BADGES (if any)
            ════════════════════════════════════════════════════════════════════ */}
        {profile.badges.length > 0 && (
          <section>
            <h2 class="text-gray-500 text-xs uppercase tracking-wider mb-4 font-mono">
              // badges <span class="text-gray-600">({profile.badges.length}/{Object.keys(BADGES).length})</span>
            </h2>
            <div class="p-6 bg-gray-950 border border-gray-800 rounded-xl">
              <div class="flex flex-wrap gap-3">
                {getBadges(profile.badges).map((badge) => (
                  <div
                    key={badge.id}
                    class="flex items-center gap-2 px-3 py-2 bg-gray-900/50 border border-gray-800 rounded-lg"
                    title={badge.description}
                  >
                    <span class="text-xl">{badge.emoji}</span>
                    <span class="text-gray-300 text-sm">{badge.name}</span>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* GitHub link */}
        <div class="mt-12 text-center">
          <a
            href={`https://github.com/${profile.username}`}
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex items-center gap-2 px-4 py-2 border border-gray-800 hover:border-gray-700 rounded-lg text-gray-500 hover:text-gray-400 transition-colors text-sm"
          >
            <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
            </svg>
            View on GitHub
          </a>
        </div>
      </main>
    </div>
  );
};

// 404 component
const NotFound: FC<{ username: string }> = ({ username }) => (
  <div class="min-h-screen bg-black flex items-center justify-center px-4">
    <div class="text-center">
      <div class="text-6xl mb-4">🤔</div>
      <h1 class="text-2xl font-bold text-gray-100 mb-2">User not found</h1>
      <p class="text-gray-500 font-mono text-sm mb-6">
        @{username} hasn't joined clawd.gg yet
      </p>
      <a
        href="/"
        class="inline-flex items-center gap-2 text-cyan-400 hover:text-cyan-300 font-mono transition-colors"
      >
        &larr; Back to Leaderboard
      </a>
    </div>
  </div>
);

// ═══════════════════════════════════════════════════════════════════════════
// ROUTE HANDLER
// ═══════════════════════════════════════════════════════════════════════════

app.get('/:username', async (c) => {
  const username = c.req.param('username');
  const currentUser = c.get('user');

  // Fetch user
  const user = await db
    .select()
    .from(users)
    .where(eq(users.githubUsername, username))
    .limit(1);

  if (user.length === 0) {
    return c.html(
      <Layout title={`@${username} - Not Found`} user={currentUser}>
        <NotFound username={username} />
      </Layout>,
      404
    );
  }

  const userData = user[0]!;
  const isOtelUser = userData.otelEnabled === true;

  // Get stats: use users.total_* for OTel users, sum daily_stats for legacy
  let totalPrompts: number;
  let totalLinesWritten: number;
  let totalCommits: number;
  let totalTokens: number;
  let totalInputTokens: number;
  let totalOutputTokens: number;
  let totalCacheReadTokens: number;
  let totalCacheCreationTokens: number;
  let totalCostCents: number;
  let totalActiveSeconds: number;
  let totalMessages: number;
  let totalToolCalls: number;

  if (isOtelUser) {
    // V2: Use cached totals from users table
    totalPrompts = userData.totalPrompts ?? 0;
    totalLinesWritten = userData.totalLinesAdded ?? 0;
    totalCommits = userData.totalCommits ?? 0;
    totalTokens = userData.totalTokens ?? 0;
    totalInputTokens = userData.totalInputTokens ?? 0;
    totalOutputTokens = userData.totalOutputTokens ?? 0;
    totalCacheReadTokens = userData.totalCacheReadTokens ?? 0;
    totalCacheCreationTokens = userData.totalCacheCreationTokens ?? 0;
    totalCostCents = userData.totalCostCents ?? 0;
    totalActiveSeconds = userData.totalActiveSeconds ?? 0;
    totalMessages = totalPrompts;
    // Tool calls: OTEL + legacy (query ClickHouse for fresh count)
    const otelToolCalls = await clickhouse.getUserTotalToolCalls(userData.id);
    totalToolCalls = otelToolCalls + (userData.legacyTotalToolCalls ?? 0);
  } else {
    // V1: Sum from daily_stats
    const statsResult = await db
      .select({
        totalPrompts: sql<number>`sum(${dailyStats.promptCount})`,
        totalLinesWritten: sql<number>`sum(${dailyStats.linesWritten})`,
        totalCommits: sql<number>`sum(${dailyStats.commitCount})`,
        totalMessages: sql<number>`sum(${dailyStats.messageCount})`,
        totalToolCalls: sql<number>`sum(${dailyStats.toolCallCount})`,
        totalTokens: sql<number>`sum(${dailyStats.tokenCount})`,
        totalInputTokens: sql<number>`sum(${dailyStats.inputTokens})`,
        totalOutputTokens: sql<number>`sum(${dailyStats.outputTokens})`,
        totalCacheReadTokens: sql<number>`sum(${dailyStats.cacheReadTokens})`,
        totalCacheCreationTokens: sql<number>`sum(${dailyStats.cacheCreationTokens})`,
        totalCostCents: sql<number>`sum(${dailyStats.costUsdCents})`,
      })
      .from(dailyStats)
      .where(eq(dailyStats.userId, userData.id));

    totalPrompts = statsResult[0]?.totalPrompts ?? 0;
    totalLinesWritten = statsResult[0]?.totalLinesWritten ?? 0;
    totalCommits = statsResult[0]?.totalCommits ?? 0;
    totalTokens = statsResult[0]?.totalTokens ?? 0;
    totalInputTokens = statsResult[0]?.totalInputTokens ?? 0;
    totalOutputTokens = statsResult[0]?.totalOutputTokens ?? 0;
    totalCacheReadTokens = statsResult[0]?.totalCacheReadTokens ?? 0;
    totalCacheCreationTokens = statsResult[0]?.totalCacheCreationTokens ?? 0;
    totalCostCents = statsResult[0]?.totalCostCents ?? 0;
    totalActiveSeconds = 0;
    totalMessages = statsResult[0]?.totalMessages ?? 0;
    totalToolCalls = statsResult[0]?.totalToolCalls ?? 0;
  }

  // Fetch daily activity for contribution graph
  // For OTEL users: Merge legacy dailyStats + ClickHouse metrics_daily
  const legacyActivity = await db
    .select({
      date: dailyStats.date,
      count: dailyStats.promptCount,
      // Rich data from V2 schema (may be 0 for older data)
      inputTokens: dailyStats.inputTokens,
      outputTokens: dailyStats.outputTokens,
      linesWritten: dailyStats.linesWritten,
      costUsdCents: dailyStats.costUsdCents,
    })
    .from(dailyStats)
    .where(eq(dailyStats.userId, userData.id))
    .orderBy(asc(dailyStats.date));

  // Build merged daily activity map with optional rich data
  interface DailyData {
    count: number;
    tokens?: number;
    linesAdded?: number;
    linesRemoved?: number;
    costUsd?: number;
  }
  const activityMap = new Map<string, DailyData>();
  for (const day of legacyActivity) {
    const tokens = (day.inputTokens || 0) + (day.outputTokens || 0);
    activityMap.set(day.date, {
      count: day.count,
      // Only include rich data if we have it (V2 schema)
      tokens: tokens > 0 ? tokens : undefined,
      linesAdded: day.linesWritten > 0 ? day.linesWritten : undefined,
      // Legacy doesn't track removed lines separately
      linesRemoved: undefined,
      costUsd: day.costUsdCents > 0 ? day.costUsdCents / 100 : undefined,
    });
  }

  // For OTEL users, fetch and merge ClickHouse data with rich metrics
  if (isOtelUser) {
    const otelDaily = await clickhouse.getUserDailyMetrics(userData.id, 365);
    for (const day of otelDaily) {
      const otelCount = day.prompts || 0;
      if (otelCount > 0 || day.input_tokens > 0) {
        const existing = activityMap.get(day.date);
        activityMap.set(day.date, {
          count: Math.max(existing?.count || 0, otelCount),
          tokens: (day.input_tokens || 0) + (day.output_tokens || 0),
          linesAdded: day.lines_added || 0,
          linesRemoved: day.lines_removed || 0,
          costUsd: day.cost_usd || 0,
        });
      }
    }
  }

  // Convert map to sorted array
  const dailyActivity = Array.from(activityMap.entries())
    .map(([date, data]) => ({ date, ...data }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Calculate contribution levels.
  // Use the LOUDER of the count-ratio and the tokens-ratio (each normalized
  // against its own max). Days with token activity but zero recovered prompts
  // (e.g. backfilled gap window where the prompt source is unavailable) still
  // light up at a level proportional to their token volume.
  const maxCount = Math.max(...dailyActivity.map(d => d.count || 0), 1);
  const maxTokens = Math.max(...dailyActivity.map(d => d.tokens || 0), 1);
  const contributions: ContributionDay[] = dailyActivity.map(d => {
    const countRatio = (d.count || 0) / maxCount;
    const tokenRatio = (d.tokens || 0) / maxTokens;
    const ratio = Math.max(countRatio, tokenRatio);
    let level: 0 | 1 | 2 | 3 | 4 = 0;
    if (ratio > 0) {
      if (ratio >= 0.75) level = 4;
      else if (ratio >= 0.5) level = 3;
      else if (ratio >= 0.25) level = 2;
      else level = 1;
    }
    return {
      date: d.date,
      count: d.count,
      level,
      tokens: d.tokens,
      linesAdded: d.linesAdded,
      linesRemoved: d.linesRemoved,
      costUsd: d.costUsd,
    };
  });

  // Get user rank
  const rankResult = await db.all(sql`
    SELECT (
      SELECT COUNT(*) + 1 FROM (
        SELECT subq.id FROM (
          SELECT u.id,
            CASE
              WHEN u.otel_enabled = 1 THEN u.total_prompts
              ELSE COALESCE((SELECT SUM(prompt_count) FROM daily_stats WHERE user_id = u.id), 0)
            END as total_prompts
          FROM users u
          WHERE u.otel_enabled = 1
             OR EXISTS (SELECT 1 FROM daily_stats WHERE user_id = u.id)
        ) subq
        WHERE subq.total_prompts > ${totalPrompts}
      )
    ) as rank
  `) as any[];
  const rank = rankResult[0]?.rank ?? 1;

  // Get total users count
  const totalUsersResult = await db.all(sql`
    SELECT COUNT(*) as count
    FROM users u
    WHERE u.otel_enabled = 1
       OR EXISTS (SELECT 1 FROM daily_stats WHERE user_id = u.id)
  `) as any[];
  const totalUsers = totalUsersResult[0]?.count ?? 1;

  // Parse badges and hourCounts
  let badges: string[] = [];
  let hourCounts: Record<string, number> | null = null;
  try {
    badges = userData.badges ? JSON.parse(userData.badges) : [];
    hourCounts = userData.hourCounts ? JSON.parse(userData.hourCounts) : null;
  } catch {
    badges = [];
  }

  // Calculate archetypes
  const archetypeInput: ArchetypeInput = {
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    totalCacheCreationTokens,
    hourCounts,
    totalPrompts,
    totalLinesWritten,
    totalCommits,
    firstSessionDate: userData.firstSessionDate || undefined,
  };
  const archetypes = calculateArchetypes(archetypeInput);

  // Calculate derived metrics
  const derivedMetrics = calculateDerivedMetrics(archetypeInput, totalCostCents);

  // Get peak hour
  const peakHour = getPeakHour(hourCounts);

  // Fetch OTEL-specific data for own profile
  const isOwnProfile = currentUser?.githubUsername === username;
  let todayMetrics: TodayMetrics | null = null;
  let cacheStats: CacheStats | null = null;
  // NEW: Profile Signature data
  let languageStats: LanguageStats[] = [];
  let toolStats: ToolStats[] = [];
  let trustStyle: TrustStyle | null = null;
  let agenticStats: AgenticStats | null = null;
  let terminalStats: TerminalStats[] = [];
  let todayEnhanced: TodayMetricsEnhanced | null = null;

  if (isOwnProfile && isOtelUser) {
    try {
      // Fetch all OTEL data in parallel
      const [todayResult, cacheResult, langResult, toolResult, trustResult, agenticResult, terminalResult, todayEnhResult] = await Promise.all([
        clickhouse.getUserTodayMetrics(userData.id),
        clickhouse.getUserCacheStats(userData.id),
        clickhouse.getUserLanguageStats(userData.id),
        clickhouse.getUserToolBreakdown(userData.id),
        clickhouse.getUserTrustStyle(userData.id),
        clickhouse.getUserAgenticStats(userData.id),
        clickhouse.getUserTerminalStats(userData.id),
        clickhouse.getUserTodayMetricsEnhanced(userData.id),
      ]);
      todayMetrics = todayResult;
      cacheStats = cacheResult;
      languageStats = langResult;
      toolStats = toolResult;
      trustStyle = trustResult;
      agenticStats = agenticResult;
      terminalStats = terminalResult;
      todayEnhanced = todayEnhResult;
    } catch (error) {
      console.error('Error fetching OTEL data:', error);
      // Continue without OTEL data
    }
  }

  const profile: ProfileData = {
    username: userData.githubUsername,
    avatarUrl: userData.avatarUrl,
    firstSessionDate: userData.firstSessionDate,
    badges,
    currentStreak: userData.currentStreak ?? 0,
    longestStreak: userData.longestStreak ?? 0,
    totalPrompts,
    totalTokens,
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    totalCacheCreationTokens,
    totalCostCents,
    totalLinesWritten,
    totalCommits,
    totalActiveSeconds,
    totalMessages,
    totalToolCalls,
    rank,
    totalUsers,
    hourCounts,
  };

  return c.html(
    <Layout title={`@${username} - clawd.gg`} user={currentUser}>
      <Profile
        profile={profile}
        archetypes={archetypes}
        derivedMetrics={derivedMetrics}
        peakHour={peakHour}
        contributions={contributions}
        currentUser={currentUser}
        todayMetrics={todayMetrics}
        cacheStats={cacheStats}
        isOtelEnabled={isOtelUser}
        languageStats={languageStats}
        toolStats={toolStats}
        trustStyle={trustStyle}
        agenticStats={agenticStats}
        terminalStats={terminalStats}
        todayEnhanced={todayEnhanced}
      />
    </Layout>
  );
});

export default app;
