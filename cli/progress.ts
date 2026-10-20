// A one-line progress report for the two long phases of `clawdgg import`.
//
// Both of them used to print one line and then nothing: "Reading 3645
// transcript files" sat there for minutes while ~3.9 GB went through
// readFile, and the only honest reading of a silent terminal is that
// something has hung.
//
// Two shapes, because a pty and a pipe want opposite things:
//
//   on a TTY   one line, rewritten in place with \r and cleared at the end,
//              throttled so a 4,000-file loop does not spend its time on
//              terminal writes.
//   off a TTY  a plain line each time another ~10% is done. No \r, no \x1b:
//              a CI log or a `| tee` file holds exactly what it shows.
//
// `note()` is how a message gets out mid-bar without breaking it, which on a
// TTY means the bar is erased, the note is printed on its own line, and the bar
// is redrawn under it.
// `status()` is for a message that is only true for now — "waiting for a slot
// (5s)" — and rides on the end of the bar until the next update replaces it,
// so ten minutes of waits are one line, not a hundred.

/** ~10 redraws a second. */
const MIN_REDRAW_MS = 100;

const BAR_CELLS = 10;

/** Clear the current line and put the cursor back at its start. */
const CLEAR_LINE = "\r\x1b[K";

export interface ProgressOptions {
  /** Left of the counter, printed verbatim: "Reading transcripts". */
  label: string;
  total: number;
  /** After the counter: "12 / 40 batches". */
  unit?: string;
  /** Defaults to stdout's own answer. */
  isTTY?: boolean;
  /**
   * Dim the line. Defaults to off when NO_COLOR is set — this is the only
   * place in the CLI that reads that variable so far, so new output honours it
   * and nothing that already shipped changes behaviour.
   */
  color?: boolean;
  write?: (text: string) => void;
  now?: () => number;
}

export interface Progress {
  /** Report that `done` of `total` units are finished. */
  update(done: number): void;
  /** Print one line beside the bar, without disturbing it. */
  note(text: string): void;
  /** Show `text` at the end of the bar until the next update. */
  status(text: string): void;
  /** Stop reporting: clears the bar on a TTY, completes the log off one. */
  finish(): void;
}

/** `▕██████░░░░▏` for a fraction of 1. */
export function progressBar(fraction: number, cells: number = BAR_CELLS): string {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const filled = Math.round(clamped * cells);
  return `▕${"█".repeat(filled)}${"░".repeat(cells - filled)}▏`;
}

/**
 * The line itself, with no control characters in it.
 *
 * A total of 0 reads as done rather than as NaN%: the caller has nothing to do,
 * and 0/0 is the one case where "finished" and "not started" are the same.
 */
export function renderProgressLine(opts: {
  label: string;
  done: number;
  total: number;
  unit?: string;
}): string {
  const { label, done, total, unit } = opts;
  const fraction = total > 0 ? done / total : 1;
  const percent = Math.floor(fraction * 100);
  const counter = `${done.toLocaleString()} / ${total.toLocaleString()}${unit ? ` ${unit}` : ""}`;
  return `${label}  ${counter}  ${progressBar(fraction)} ${percent}%`;
}

export function createProgress(options: ProgressOptions): Progress {
  const { label, total, unit } = options;
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const now = options.now ?? (() => Date.now());
  const isTTY = options.isTTY ?? Boolean(process.stdout.isTTY);
  const color = options.color ?? !process.env.NO_COLOR;

  // The current status(), drawn after the bar on a TTY.
  let suffix = "";

  const line = (done: number) => {
    const text = `${renderProgressLine({ label, done, total, unit })}${suffix}`;
    return color ? `\x1b[2m${text}\x1b[0m` : text;
  };

  let lastDrawnAt = 0;
  let lastDone = 0;
  let drawn = false;
  // Off a TTY: which tenth was last reported. -1 so the first update always
  // says something — "0 / 3,645" is the line that proves the loop started.
  let lastTenth = -1;

  function draw(done: number): void {
    write(`${CLEAR_LINE}${line(done)}`);
    lastDrawnAt = now();
    drawn = true;
  }

  return {
    update(done: number): void {
      lastDone = done;
      const hadStatus = suffix !== "";
      suffix = "";

      if (!isTTY) {
        const tenth = total > 0 ? Math.floor((done / total) * 10) : 10;
        if (tenth <= lastTenth) return;
        lastTenth = tenth;
        write(`${renderProgressLine({ label, done, total, unit })}\n`);
        return;
      }

      // The first and the last update always draw, whatever the throttle says:
      // the first is the one that proves the loop started, and the last is the
      // state the user is left looking at.
      if (!hadStatus && drawn && done < total && now() - lastDrawnAt < MIN_REDRAW_MS) return;
      draw(done);
    },

    status(text: string): void {
      if (!isTTY) {
        write(`${text.trim()}\n`);
        return;
      }
      suffix = `  ${text.trim()}`;
      draw(lastDone);
    },

    note(text: string): void {
      if (!isTTY) {
        write(`${text}\n`);
        return;
      }
      write(`${CLEAR_LINE}${text}\n`);
      // Redraw at once rather than wait for the next update: the next one may
      // be tens of seconds away, and a visible bar is what says the import is
      // waiting rather than wedged.
      draw(lastDone);
    },

    finish(): void {
      if (isTTY) {
        if (drawn) write(CLEAR_LINE);
        drawn = false;
        return;
      }
      // A loop that ended short of `total` still gets a closing line, so a log
      // never trails off at 70% with no word about why.
      if (lastTenth < 10 && total > 0) {
        write(`${renderProgressLine({ label, done: lastDone, total, unit })}\n`);
        lastTenth = 10;
      }
    },
  };
}
