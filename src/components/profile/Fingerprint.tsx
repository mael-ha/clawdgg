import type { FC } from 'hono/jsx';
import type {
  Anatomy as AnatomyFigures,
  Conversation as ConversationFigures,
  FingerprintSection,
  Rings as RingFigures,
  Ultrathink,
  UserClass,
  ValueFigures,
} from '../../lib/fingerprint';
import { Card, CardLabel, Nothing, VisibilityPill } from './parts';
import { className } from './palette';
import { compact, delta, group, money, perPrompt, pct, times } from './format';
import {
  VIEW,
  hoursRing,
  languagesRing,
  modelsRing,
  weekRing,
  type Ring,
} from './geometry';
import type { Visibility } from './types';

/**
 * The fingerprint itself: who someone is, above the fold.
 *
 * Four blocks, in the order they answer a question — WHO (the header and the
 * class), WHAT one prompt of theirs looks like, WHEN and WITH WHAT they work
 * (the rings), and HOW LOPSIDED the conversation is. Each is independent: a
 * section the owner has hidden simply is not in the payload, and the block
 * disappears with it rather than rendering a zero.
 */

interface Pill {
  section: FingerprintSection;
  visibility: Visibility | null;
}

const pillFor = ({ section, visibility }: Pill) =>
  visibility ? <VisibilityPill section={section} isPublic={visibility[section]} /> : null;

/**
 * Above this share, a typed-character figure is told on itself.
 *
 * Characters recovered from ~/.claude/history.jsonl are the REPL's DISPLAY
 * string, where a paste reads `[Pasted text #1 +40 lines]` instead of its
 * forty lines — so they understate what was actually sent, and so do the
 * median prompt length and the conversation ratio built on them. A couple of
 * percent moves nothing; a quarter of someone's history does.
 */
const HISTORY_CAVEAT_PCT = 5;

const historyNote = (sharePct: number): string | undefined =>
  sharePct >= HISTORY_CAVEAT_PCT
    ? `${Math.round(sharePct)}% of these characters were recovered from the ` +
      `local prompt history, which records a paste as "[Pasted text +40 lines]" ` +
      `rather than its lines — so this reads low.`
    : undefined;

// ═══════════════════════════════════════════════════════════════════════════
// The header
// ═══════════════════════════════════════════════════════════════════════════

const Avatar: FC<{ username: string; avatarUrl: string | null; class?: string }> = ({
  username,
  avatarUrl,
  class: size,
}) =>
  avatarUrl ? (
    <img
      src={avatarUrl}
      alt=""
      class={`${size} shrink-0 rounded-full border-2 border-cyan-400 object-cover`}
    />
  ) : (
    <div
      aria-hidden="true"
      class={`${size} shrink-0 rounded-full border-2 border-cyan-400 bg-fp-border flex items-center justify-center font-mono font-extrabold text-fp-text`}
    >
      {username.slice(0, 2).toUpperCase()}
    </div>
  );

interface HeaderProps {
  username: string;
  avatarUrl: string | null;
  userClass: UserClass | undefined;
  ultrathink: Ultrathink | undefined;
  value: ValueFigures | undefined;
  visibility: Visibility | null;
}

export const Header: FC<HeaderProps> = ({
  username,
  avatarUrl,
  userClass,
  ultrathink,
  value,
  visibility,
}) => {
  const name = className(userClass?.rhythm ?? null, userClass?.style ?? null);
  const change = delta(value?.deltaPct ?? null);

  return (
    <header class="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between sm:gap-8">
      <div class="flex items-start gap-4 sm:items-center sm:gap-[18px]">
        <Avatar
          username={username}
          avatarUrl={avatarUrl}
          class="w-[52px] h-[52px] text-base sm:w-[68px] sm:h-[68px] sm:text-xl"
        />
        <div class="flex min-w-0 flex-col gap-1.5">
          <div class="flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:items-baseline sm:gap-3.5">
            <h1 class="m-0 font-mono text-[21px] font-bold text-fp-text sm:text-[28px]">
              @{username}
            </h1>
            {name && (
              <span class="font-mono text-[15px] font-extrabold text-fp-text sm:text-xl">
                {name.emoji} {name.rhythm}{' '}
                <span class="text-magenta-400">{name.style}</span>
              </span>
            )}
          </div>

          {ultrathink && ultrathink.count > 0 && (
            <span
              class="fp-rainbow self-start rounded-full border border-fp-edge px-3 py-[5px] font-mono text-[12px] font-extrabold sm:text-[13px]"
              title={
                ultrathink.firstSeen
                  ? `Counted since ${ultrathink.firstSeen}. Prompts before that were never looked at, so the share is a floor.`
                  : undefined
              }
            >
              🌈 {group(ultrathink.count)} ultrathinks · {pct(ultrathink.sharePct, 1)} of prompts
            </span>
          )}
        </div>
      </div>

      {/* A value of nothing is left out rather than printed as "$0". On a
          brand-new account every figure is zero, and a wall of zeros is a
          claim about the person; an absent figure is a claim about the data. */}
      {value && (value.allTime > 0 || value.thisWeek > 0) && (
        <div class="flex flex-col gap-0.5 rounded-2xl border border-fp-border bg-fp-card p-4 sm:items-end sm:border-0 sm:bg-transparent sm:p-0">
          <div class="flex items-center gap-2">
            <CardLabel class="text-magenta-400">💎 API-EQUIVALENT VALUE · THIS WEEK</CardLabel>
            {pillFor({ section: 'value', visibility })}
          </div>
          <span class="font-mono text-[36px] font-extrabold leading-[1.05] tracking-[-0.03em] text-fp-text sm:text-[46px]">
            {money(value.thisWeek)}{' '}
            {change && (
              <span
                class={`text-[13px] font-medium sm:text-[15px] ${change.up ? 'text-cyan-400' : 'text-fp-rose'}`}
              >
                {change.arrow} {change.text}
              </span>
            )}
          </span>
          <span class="font-mono text-[12px] text-fp-dim sm:text-[13px]">
            <span class="text-fp-text">{money(value.allTime)}</span> all time · list price, not
            what you pay
          </span>
        </div>
      )}
    </header>
  );
};

// ═══════════════════════════════════════════════════════════════════════════
// Anatomy of your average prompt
// ═══════════════════════════════════════════════════════════════════════════

const Arrow: FC<{ glyph?: string }> = ({ glyph }) => (
  <span aria-hidden="true" class="hidden text-center text-[22px] text-fp-mute lg:block">
    {glyph ?? '→'}
  </span>
);

const AnatomyFigure: FC<{
  label: string;
  color: string;
  figure: string;
  unit?: string;
  note: string;
  /** The long form of a caveat the note only hints at. */
  title?: string;
}> = ({ label, color, figure, unit, note, title }) => (
  <div class="flex flex-col gap-0.5" title={title}>
    <span class={`font-mono text-[11px] sm:text-[12px] ${color}`}>{label}</span>
    <span class="font-mono text-[24px] font-extrabold tracking-[-0.02em] text-fp-text sm:text-[38px]">
      {figure}
      {unit && (
        <span class="ml-1 text-[11px] font-medium text-fp-dim sm:text-[15px]">{unit}</span>
      )}
    </span>
    <span class="hidden font-mono text-[11px] text-fp-faint lg:block">{note}</span>
  </div>
);

export const Anatomy: FC<{
  anatomy: AnatomyFigures;
  /** From `conversation`, when that section is in this payload. */
  historyDerivedCharsPct?: number;
  visibility: Visibility | null;
}> = ({ anatomy, historyDerivedCharsPct, visibility }) => {
  const figures = anatomy.allTime;
  const caveat = historyNote(historyDerivedCharsPct ?? 0);

  return (
    <Card>
      <div class="mb-3 flex items-center justify-between gap-3">
        <div class="flex items-center gap-3">
          <CardLabel>ANATOMY OF YOUR AVERAGE PROMPT</CardLabel>
          {pillFor({ section: 'anatomy', visibility })}
        </div>
        <CardLabel class="text-fp-faint">all time</CardLabel>
      </div>

      {figures.prompts === 0 ? (
        <Nothing>no prompts recorded yet</Nothing>
      ) : (
        <div class="grid grid-cols-2 items-center gap-y-4 lg:grid-cols-[minmax(0,1fr)_40px_minmax(0,1fr)_40px_minmax(0,1fr)_40px_minmax(0,1fr)] lg:gap-y-0">
          <AnatomyFigure
            label="✍️ you type"
            color="text-cyan-300"
            figure={group(figures.medianPromptChars)}
            unit={caveat ? 'chars*' : 'chars'}
            // The p95 beside the median is the whole shape of the
            // distribution in two numbers. It only says something when it is
            // above the median — equal or below means too few lengths were
            // recorded to have a tail.
            note={
              `median · ${
                figures.p95PromptChars > figures.medianPromptChars
                  ? `long tail to ${group(figures.p95PromptChars)}`
                  : 'per prompt'
              }${caveat ? ' · reads low' : ''}`
            }
            title={caveat}
          />
          <Arrow />
          <AnatomyFigure
            label="🔁 Claude acts"
            color="text-amber-400"
            figure={perPrompt(figures.toolCallsPerPrompt)}
            unit="tool calls"
            // The tools those calls went to, biggest first — counted from the
            // same event the ratio is, so the names and the figure above them
            // describe one measurement.
            note={
              anatomy.topTools.length > 0
                ? anatomy.topTools.map((tool) => tool.name).join(' · ')
                : 'per prompt'
            }
          />
          <Arrow />
          <AnatomyFigure
            label="📦 it ships"
            color="text-cyan-400"
            figure={perPrompt(figures.linesPerPrompt)}
            unit="lines"
            note="added, per prompt"
          />
          <Arrow glyph="·" />
          <AnatomyFigure
            label="💎 it costs"
            color="text-magenta-400"
            figure={money(figures.valuePerPrompt)}
            note="API-equivalent, per prompt"
          />
        </div>
      )}
    </Card>
  );
};

// ═══════════════════════════════════════════════════════════════════════════
// The four rings
// ═══════════════════════════════════════════════════════════════════════════

/**
 * One dial.
 *
 * The SVG is the SAME at every width: a 240-unit viewBox scaled by CSS, with
 * the ticks and hour labels hidden and the centre type enlarged under 640px
 * (see .fp-ring-* in src/styles/app.css). Two geometries would be two chances
 * for the phone and the desktop to disagree about where 11 o'clock is.
 */
const RingCard: FC<{ title: string; sub: string; color: string; ring: Ring }> = ({
  title,
  sub,
  color,
  ring,
}) => (
  <div class="flex flex-col items-center gap-2.5 rounded-2xl border border-fp-border bg-fp-card px-3 pb-4 pt-4 sm:px-4">
    <div class="flex w-full items-baseline justify-between gap-2">
      <span class="font-mono text-[10px] tracking-[0.08em] sm:text-[12px]" style={`color:${color}`}>
        {title}
      </span>
      <span class="hidden font-mono text-[10px] text-fp-faint sm:block">{sub}</span>
    </div>

    <svg
      viewBox={`0 0 ${VIEW} ${VIEW}`}
      class="block h-auto w-full max-w-[236px]"
      role="img"
      aria-label={ring.aria}
    >
      {ring.ticks && (
        <path class="fp-ring-ticks" d={ring.ticks} stroke="#262b38" stroke-width="1" fill="none" />
      )}
      {ring.wedges.map((wedge, index) =>
        wedge.d ? <path key={index} d={wedge.d} fill={wedge.color} /> : null,
      )}
      <g class="fp-ring-labels">
        {ring.labels.map((label, index) => (
          <text
            key={index}
            x={label.x}
            y={label.y}
            text-anchor="middle"
            font-size="10"
            fill={label.color}
            font-family="JetBrains Mono, monospace"
          >
            {label.text}
          </text>
        ))}
      </g>
      <text
        class="fp-ring-big"
        x={VIEW / 2}
        y="122"
        text-anchor="middle"
        font-size="30"
        font-weight="800"
        fill="#e6e8ee"
        font-family="JetBrains Mono, monospace"
      >
        {ring.big}
      </text>
      <text
        class="fp-ring-small"
        x={VIEW / 2}
        y="141"
        text-anchor="middle"
        font-size="11"
        fill={color}
        font-family="JetBrains Mono, monospace"
      >
        {ring.small}
      </text>
    </svg>

    {ring.legend.length > 0 && (
      <div class="hidden flex-wrap justify-center gap-x-3 gap-y-1 font-mono text-[11px] text-fp-dim sm:flex">
        {ring.legend.map((entry) => (
          <span key={entry.name}>
            <span aria-hidden="true" style={`color:${entry.color}`}>
              ■
            </span>{' '}
            {entry.name}
          </span>
        ))}
      </div>
    )}
  </div>
);

/**
 * `timezone` is the OWNER's zone name and null for everyone else — a zone is
 * location data, and the hours ring is just as readable captioned "their own
 * clock". The buckets were computed in that zone server-side either way.
 */
export const RingsBlock: FC<{
  rings: RingFigures;
  timezone: string | null;
  visibility: Visibility | null;
}> = ({ rings, timezone, visibility }) => (
  <section class="flex flex-col gap-3">
    {visibility && (
      <div class="flex items-center gap-3">
        <CardLabel>🧿 THE RINGS</CardLabel>
        {pillFor({ section: 'rings', visibility })}
      </div>
    )}
    <div class="grid grid-cols-2 gap-2.5 lg:grid-cols-4 lg:gap-[18px]">
      <RingCard
        title="⏱ HOURS"
        sub={timezone ?? 'their own clock'}
        color="#fbbf24"
        ring={hoursRing(rings.hours, rings.peakHour?.hour ?? null)}
      />
      <RingCard
        title="📆 WEEK"
        sub="day of week"
        color="#67e8f9"
        ring={weekRing(rings.weekdays, rings.busiestDay, rings.weekdayShare)}
      />
      <RingCard
        title="🧬 LANGUAGES"
        sub="by edits"
        color="#67e8f9"
        ring={languagesRing(rings.languages, rings.topLanguage)}
      />
      <RingCard
        title="🧠 MODELS"
        sub="by value"
        color="#ff00ff"
        ring={modelsRing(rings.models, rings.topModel)}
      />
    </div>
  </section>
);

// ═══════════════════════════════════════════════════════════════════════════
// 📏 The conversation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Three numbers and the arrow of each one.
 *
 * Claude's side is an ESTIMATE and labelled one everywhere it appears: we
 * measure output TOKENS and multiply by four, so the figure carries a `~` and
 * the card's caption says what the four is.
 */
export const ConversationBlock: FC<{
  conversation: ConversationFigures;
  prompts: number;
  visibility: Visibility | null;
}> = ({ conversation, prompts, visibility }) => {
  const caveat = historyNote(conversation.historyDerivedCharsPct);

  return (
  <Card>
    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-3">
        <CardLabel>📏 THE CONVERSATION · ALL TIME</CardLabel>
        {pillFor({ section: 'conversation', visibility })}
      </div>
      <CardLabel class="text-fp-faint">
        output chars ≈ 4 per token
        {caveat ? ` · *${Math.round(conversation.historyDerivedCharsPct)}% of typed chars recovered, reads low` : ''}
      </CardLabel>
    </div>

    {conversation.charsTyped === 0 && conversation.outputTokens === 0 ? (
      <Nothing>no conversation recorded yet</Nothing>
    ) : (
      <div class="grid grid-cols-3 items-end gap-2 sm:gap-[18px]">
        <div class="flex flex-col gap-1" title={caveat}>
          <span class="font-mono text-[10px] text-fp-dim sm:text-[12px]">you sent</span>
          <span class="font-mono text-[20px] font-extrabold leading-none tracking-[-0.03em] text-fp-text sm:text-[44px]">
            <span class="text-cyan-400">↑</span> {compact(conversation.charsTyped)}
          </span>
          <span class="hidden font-mono text-[12px] text-fp-dim sm:block">
            {caveat ? 'characters typed*' : 'characters typed'}
            {prompts > 0 ? ` · ${group(prompts)} prompts` : ''}
          </span>
        </div>

        <div class="flex flex-col gap-1">
          <span class="font-mono text-[10px] text-fp-dim sm:text-[12px]">Claude sent back</span>
          <span class="font-mono text-[20px] font-extrabold leading-none tracking-[-0.03em] text-fp-text sm:text-[44px]">
            <span class="text-fp-rose">↓</span> ~{compact(conversation.approxOutputChars)}
          </span>
          <span class="hidden font-mono text-[12px] text-fp-dim sm:block">
            estimated characters · {compact(conversation.outputTokens)} output tokens
          </span>
        </div>

        <div class="flex flex-col items-end gap-1">
          <span class="font-mono text-[10px] text-fp-dim sm:text-[12px]">ratio</span>
          <span class="font-mono text-[20px] font-extrabold leading-none tracking-[-0.03em] text-fp-text sm:text-[44px]">
            {times(conversation.ratio)}
            <span class="text-magenta-400">×</span>
          </span>
          <span class="hidden text-right font-mono text-[12px] text-fp-dim sm:block">
            for every character you type
          </span>
        </div>
      </div>
    )}
  </Card>
  );
};
