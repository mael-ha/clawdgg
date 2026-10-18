import type { FC } from 'hono/jsx';
import { Wordmark } from '../Layout';

/**
 * What this is, and the one line that joins it — above the board, in the space
 * a landing page would have spent on a manifesto.
 *
 * Compact on purpose: the leaderboard is the product, so the pitch gets the
 * top of the page and not the fold. Everything a first-time visitor needs is
 * the sentence and the curl.
 */

export const INSTALL_COMMAND = 'curl -fsSL https://clawd.gg/install | sh';

interface PitchProps {
  /** A real handle to send a curious visitor to, when there is one to send. */
  featuredProfile: string | null;
}

export const Pitch: FC<PitchProps> = ({ featuredProfile }) => (
  <section class="grid gap-8 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:items-center lg:gap-9">
    <div class="flex min-w-0 flex-col gap-3.5">
      <h1 class="text-5xl sm:text-6xl font-bold tracking-[-0.04em] leading-none">
        <Wordmark ghost />
      </h1>
      <p class="text-lg sm:text-[19px] leading-relaxed text-[#c9ccd4]">
        How you use Claude Code, as a fingerprint.{' '}
        <span class="text-[#8a91a0]">Ranked every week.</span>
      </p>
      {featuredProfile && (
        <a
          href={`/u/${featuredProfile}`}
          class="self-start text-[13px] text-cyan-400 hover:text-cyan-300 transition-colors"
        >
          see a profile → @{featuredProfile}
        </a>
      )}
    </div>

    <div class="flex min-w-0 flex-col gap-3 rounded-[14px] border border-[#1a1f2b] bg-[#0b0d12] p-5">
      <span class="text-[11px] tracking-[0.08em] text-[#8a91a0]">CONNECT IN ONE LINE</span>
      <div class="flex min-w-0 items-center gap-2.5 rounded-[10px] border border-[#1a1f2b] bg-[#050508] py-1.5 pl-3.5 pr-1.5">
        {/* min-w-0 is what makes the ellipsis possible: a flex child's default
            min-width is its content, so a nowrap line widens the page instead
            of truncating — at 390px that was 84px of horizontal scroll. */}
        <code class="min-w-0 grow overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[13px] text-[#e6e8ee]">
          <span class="text-cyan-400">$</span> {INSTALL_COMMAND}
        </code>
        {/* 44px high: this is the one thing a visitor taps on a phone. */}
        <button
          type="button"
          data-copy-install={INSTALL_COMMAND}
          class="min-h-[44px] shrink-0 rounded-lg bg-cyan-400 px-3.5 font-mono text-xs font-bold text-[#050508] transition-colors hover:bg-cyan-300"
        >
          copy
        </button>
      </div>
      <span class="text-[11px] text-[#6f7686]">
        then <span class="text-[#c9ccd4]">clawdgg setup</span> · imports your history · never sends
        prompt text
      </span>
    </div>
  </section>
);
