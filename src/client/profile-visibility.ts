/**
 * The section toggles — the grid at the bottom, and the pill beside every
 * section title.
 *
 * One module for both, because they are the same control in two places and
 * must never disagree: clicking "🌈 ultrathink" in the grid has to flip the
 * pill next to the chip at the top of the page, or the owner is looking at two
 * answers to one question.
 *
 * The button is the source of truth for its own state and the server is the
 * source of truth for the answer: the click paints optimistically, the PUT
 * replies with the settings AS STORED, and that reply is what the page ends up
 * showing. A save that fails therefore rolls the switch back instead of
 * leaving someone believing a section is hidden when it is not.
 */

type Sections = Record<string, boolean>;

const grid = document.getElementById('fp-visibility');
const endpoint = grid?.dataset.endpoint ?? '/api/me/profile-settings';

const ON_TOGGLE = 'border-color:#1f3b2f;background:#0c1a14;color:#00ff9f';
const OFF_TOGGLE = 'border-color:#262b38;background:transparent;color:#8a91a0';

function paint(section: string, on: boolean): void {
  for (const pill of document.querySelectorAll<HTMLElement>(
    `.fp-visibility-pill[data-section="${section}"]`
  )) {
    pill.setAttribute('aria-pressed', on ? 'true' : 'false');
    pill.setAttribute(
      'aria-label',
      `${section} is ${on ? 'public' : 'private'} — click to ${on ? 'hide it' : 'show it'}`
    );
    pill.textContent = on ? '● public' : '○ private';
    pill.setAttribute('style', on ? ON_TOGGLE : OFF_TOGGLE);
  }

  for (const toggle of document.querySelectorAll<HTMLElement>(
    `.fp-visibility-toggle[data-section="${section}"]`
  )) {
    toggle.setAttribute('aria-pressed', on ? 'true' : 'false');
    toggle.setAttribute('style', on ? ON_TOGGLE : OFF_TOGGLE);
    const mark = toggle.lastElementChild;
    if (mark) mark.textContent = on ? '●' : '○';
  }
}

/** True when the control currently says "public". */
function isOn(section: string): boolean {
  const any = document.querySelector<HTMLElement>(
    `.fp-visibility-toggle[data-section="${section}"], .fp-visibility-pill[data-section="${section}"]`
  );
  return any?.getAttribute('aria-pressed') === 'true';
}

let inFlight = false;

async function save(section: string, next: boolean): Promise<void> {
  if (inFlight) return;
  inFlight = true;

  const previous = !next;
  paint(section, next);

  try {
    const response = await fetch(endpoint, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [section]: next }),
    });

    const body = (await response.json()) as { sections?: Sections; error?: string };
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);

    // Repaint from what the server STORED, not from what we asked for.
    for (const [name, on] of Object.entries(body.sections ?? {})) paint(name, on);
  } catch (error) {
    console.error('profile settings:', error);
    paint(section, previous);
    announce(`couldn't save — ${section} is still ${previous ? 'public' : 'private'}`);
  } finally {
    inFlight = false;
  }
}

/**
 * A live region, created on first use.
 *
 * A toggle that silently fails to save is the worst outcome here, and the
 * visual rollback alone is invisible to anyone not watching that one pill.
 */
function announce(message: string): void {
  let region = document.getElementById('fp-visibility-status');
  if (!region) {
    region = document.createElement('div');
    region.id = 'fp-visibility-status';
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    region.className = 'sr-only fixed bottom-2 left-2 font-mono text-[11px] text-fp-rose';
    document.body.appendChild(region);
  }
  region.textContent = message;
}

document.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLElement>(
    '.fp-visibility-pill, .fp-visibility-toggle'
  );
  const section = button?.dataset.section;
  if (!section) return;
  void save(section, !isOn(section));
});
