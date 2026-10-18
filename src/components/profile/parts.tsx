import type { FC, PropsWithChildren } from 'hono/jsx';
import type { FingerprintSection } from '../../lib/fingerprint';

/**
 * The three shapes every section of the fingerprint is built from: the card it
 * sits on, the heading above it, and the pill that says whether a visitor can
 * see it.
 */

export const Card: FC<PropsWithChildren<{ class?: string }>> = ({ children, class: extra }) => (
  <div class={`bg-fp-card border border-fp-border rounded-2xl ${extra ?? 'p-5 sm:p-6'}`}>
    {children}
  </div>
);

/**
 * `● public` / `○ private`, next to the title of the section it governs.
 *
 * A real <button> with aria-pressed, not a styled div: this is a control, it
 * has a state, and a screen reader has to be able to read both. The island
 * (src/client/profile-visibility.ts) finds it by data-section and keeps it in
 * step with the toggle grid further down the page.
 */
export const VisibilityPill: FC<{ section: FingerprintSection; isPublic: boolean }> = ({
  section,
  isPublic,
}) => (
  <button
    type="button"
    class="fp-visibility-pill font-mono text-[11px] font-bold px-3 min-h-[28px] rounded-full border transition-colors"
    data-section={section}
    aria-pressed={isPublic ? 'true' : 'false'}
    aria-label={`${section} is ${isPublic ? 'public' : 'private'} — click to ${isPublic ? 'hide it' : 'show it'}`}
    style={
      isPublic
        ? 'border-color:#1f3b2f;background:#0c1a14;color:#00ff9f'
        : 'border-color:#262b38;background:transparent;color:#8a91a0'
    }
  >
    {isPublic ? '● public' : '○ private'}
  </button>
);

interface SectionTitleProps {
  /** "⚡ activity" — the emoji is part of the name, not decoration. */
  title: string;
  /** Rendered at the right-hand end of the heading row. */
  aside?: unknown;
  section?: FingerprintSection;
  /** Undefined for a visitor: only the owner gets the pill. */
  isPublic?: boolean;
}

export const SectionTitle: FC<SectionTitleProps> = ({ title, aside, section, isPublic }) => (
  <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
    <div class="flex items-center gap-3">
      <h2 class="m-0 font-mono text-[15px] font-bold tracking-[0.04em] text-fp-text">{title}</h2>
      {section && isPublic !== undefined && (
        <VisibilityPill section={section} isPublic={isPublic} />
      )}
    </div>
    {aside ? <div class="font-mono text-[13px] text-fp-dim">{aside}</div> : null}
  </div>
);

/** The caption above a figure inside a card: "ANATOMY OF YOUR AVERAGE PROMPT". */
export const CardLabel: FC<PropsWithChildren<{ class?: string }>> = ({ children, class: extra }) => (
  <span class={`font-mono text-[11px] tracking-[0.08em] ${extra ?? 'text-fp-dim'}`}>
    {children}
  </span>
);

/**
 * What a card says when there is nothing in it yet.
 *
 * Deliberately not "0 prompts": a zero is a claim about this person's work,
 * and "nothing here yet" is a claim about the data we hold. Only one of those
 * is true of someone who installed the CLI an hour ago.
 */
export const Nothing: FC<{ children?: unknown }> = ({ children }) => (
  <span class="font-mono text-[12px] text-fp-faint">{children ?? 'nothing here yet'}</span>
);
