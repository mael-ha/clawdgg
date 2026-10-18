import type { FC } from 'hono/jsx';
import { SectionTitle } from './parts';
import { CONTRIB_BEFORE, CONTRIB_RAMP, WEEKDAY_NAMES } from './palette';
import { cellFill, contributionGrid, type GridCell } from './geometry';
import { group } from './format';
import type { Visibility, YearData, YearFields } from './types';

/**
 * 📅 the year — a day per square, a column per week, newest on the right.
 *
 * ONE grid in the markup, 53 columns wide. A phone hides the oldest 27 columns
 * with CSS (.fp-year-col in src/styles/app.css) rather than being served a
 * second, shorter grid: two grids is two chances to be a day out of step, and
 * the saving is 189 empty divs.
 *
 * Three things a square can be that a colour ramp cannot say, so each has its
 * own treatment and its own entry in the legend:
 *   before joining — outlined and empty; there is no claim to make about it
 *   recovered      — hatched; the numbers are real but were reconstructed
 *   today onwards  — nothing at all
 */

const WEEKDAY_LABEL_ROWS = [0, 2, 4, 6];

/**
 * One square.
 *
 * Only the figures `fields` allows reach the DOM. A data attribute is as
 * public as rendered text — "view source" is one keystroke — so a section the
 * owner has hidden has to be ABSENT from the attributes, not merely left out
 * of the tooltip the island builds from them.
 */
const Cell: FC<{ cell: GridCell; fields: YearFields }> = ({ cell, fields }) => {
  const fill = cellFill(cell);
  const hatched = fill === '';

  if (cell.kind === 'future') {
    return <div class="fp-year-cell" aria-hidden="true" />;
  }

  if (cell.kind === 'before') {
    return (
      <div
        class="fp-year-cell"
        aria-hidden="true"
        style={`background:${CONTRIB_BEFORE};box-shadow:inset 0 0 0 1px #161a23`}
      />
    );
  }

  return (
    <div
      class={`fp-year-cell fp-day${hatched ? ' fp-hatch' : ''}`}
      data-date={cell.date}
      data-prompts={String(cell.prompts)}
      {...(fields.value ? { 'data-value': cell.value.toFixed(2) } : {})}
      {...(fields.lines ? { 'data-lines': String(cell.lines) } : {})}
      {...(fields.ultrathinks ? { 'data-ultrathinks': String(cell.ultrathinks) } : {})}
      data-estimated={cell.estimated ? '1' : '0'}
      style={hatched ? undefined : `background:${fill}`}
    />
  );
};

export const Year: FC<{
  year: YearData;
  joinedOn: string | null;
  visibility: Visibility | null;
  fields: YearFields;
}> = ({ year, joinedOn, visibility, fields }) => {
  const grid = contributionGrid(year.days, { today: year.today, weeks: 53, joined: joinedOn });
  const hoverable = ['prompts']
    .concat(fields.value ? ['value'] : [])
    .concat(fields.lines ? ['lines'] : [])
    .concat(fields.ultrathinks ? ['🌈'] : [])
    .join(' · ');

  return (
    <section class="flex flex-col gap-3.5">
      <SectionTitle
        title="📅 the year"
        section="year"
        isPublic={visibility?.year}
        aside={
          <>
            <span class="text-fp-text">{group(grid.activeDays)}</span> active days · streak{' '}
            <span class="text-cyan-400">{year.currentStreak}</span> · best{' '}
            <span class="text-fp-text">{year.longestStreak}</span>
          </>
        }
      />

      <div
        id="fp-year"
        class="relative rounded-2xl border border-fp-border bg-fp-card px-4 py-5 sm:px-6"
      >
        {/* The tooltip the island moves around. Empty and hidden until a hover. */}
        <div
          id="fp-year-tooltip"
          class="pointer-events-none absolute z-30 hidden rounded-lg border border-fp-edge bg-fp-ground px-3 py-2 font-mono text-[11px] shadow-xl"
          style="transform: translateX(-50%)"
        />

        <div class="flex gap-2">
          <div class="hidden w-7 shrink-0 flex-col gap-[3px] pt-[17px] font-mono text-[10px] text-fp-faint sm:flex">
            {WEEKDAY_NAMES.map((name, row) => (
              <span key={name} class="h-[14px] leading-[14px]">
                {WEEKDAY_LABEL_ROWS.includes(row) ? name : ''}
              </span>
            ))}
          </div>

          <div class="flex min-w-0 grow flex-col gap-[3px]">
            <div class="flex gap-[3px] font-mono text-[10px] text-fp-faint">
              {grid.monthLabels.map((label, column) => (
                <span key={column} class="fp-year-month min-w-0 grow basis-0 whitespace-nowrap">
                  {label}
                </span>
              ))}
            </div>
            <div class="flex gap-[3px]">
              {grid.weeks.map((week, column) => (
                <div key={column} class="fp-year-col flex min-w-0 grow basis-0 flex-col gap-[3px]">
                  {week.map((cell) => (
                    <Cell key={cell.date} cell={cell} fields={fields} />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div class="mt-3.5 flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-[10px] text-fp-faint sm:text-[11px]">
          <span class="inline-flex items-center gap-[3px]">
            less
            {CONTRIB_RAMP.map((color) => (
              <span
                key={color}
                aria-hidden="true"
                class="inline-block h-2.5 w-2.5 rounded-sm"
                style={`background:${color}`}
              />
            ))}
            more
          </span>
          <span class="inline-flex items-center gap-1.5">
            <span aria-hidden="true" class="fp-hatch-swatch inline-block h-2.5 w-2.5 rounded-sm" />
            estimated (recovered history)
          </span>
          <span class="hidden items-center gap-1.5 sm:inline-flex">
            <span
              aria-hidden="true"
              class="inline-block h-2.5 w-2.5 rounded-sm"
              style={`background:${CONTRIB_BEFORE};box-shadow:inset 0 0 0 1px #161a23`}
            />
            before joining
          </span>
          <span class="sm:ml-auto">colour = prompts · hover: {hoverable}</span>
          <span class="sm:hidden">last 26 weeks · newest on the right</span>
        </div>
      </div>
    </section>
  );
};
