/**
 * Hover tooltip for 📅 the year.
 *
 * Reads the figures the SERVER chose to publish and nothing else: a day's
 * value, lines and 🌈 count are each in the DOM only while the section they
 * belong to is public (see Cell in src/components/profile/Year.tsx), so this
 * module shows whatever attributes it finds and never asks for a figure that
 * was deliberately withheld.
 *
 * Numbers go through the same formatters the page was rendered with, so a
 * tooltip can never print a value one way and the card above it another.
 */

import { compact, dayLabel, group, money } from '../components/profile/format';

const grid = document.getElementById('fp-year');
const tooltip = document.getElementById('fp-year-tooltip');

if (grid && tooltip) {
  const num = (value: string | undefined): number | null =>
    value === undefined ? null : Number.parseFloat(value) || 0;

  const show = (cell: HTMLElement) => {
    const { date, prompts, value, lines, ultrathinks, estimated } = cell.dataset;
    if (!date) return;

    const rows: string[] = [];
    const promptCount = num(prompts) ?? 0;

    rows.push(
      promptCount > 0
        ? `<div class="text-fp-text">${group(promptCount)} prompt${promptCount === 1 ? '' : 's'}</div>`
        : '<div class="text-fp-faint">nothing recorded</div>'
    );

    const valueUsd = num(value);
    if (valueUsd !== null && valueUsd > 0) {
      rows.push(`<div class="text-magenta-400">${money(valueUsd)}</div>`);
    }

    const lineCount = num(lines);
    if (lineCount !== null && lineCount > 0) {
      rows.push(`<div class="text-cyan-400">+${compact(lineCount)} lines</div>`);
    }

    const thinks = num(ultrathinks);
    if (thinks !== null && thinks > 0) {
      rows.push(`<div class="fp-rainbow font-bold">🌈 ${group(thinks)}</div>`);
    }

    if (estimated === '1') {
      rows.push('<div class="text-fp-faint italic">recovered, not measured live</div>');
    }

    tooltip.innerHTML =
      `<div class="text-fp-dim">${dayLabel(date)}</div>` +
      `<div class="mt-1 space-y-0.5 border-t border-fp-edge pt-1">${rows.join('')}</div>`;
    tooltip.classList.remove('hidden');

    const cellBox = cell.getBoundingClientRect();
    const gridBox = grid.getBoundingClientRect();
    tooltip.style.left = `${cellBox.left - gridBox.left + cellBox.width / 2}px`;
    tooltip.style.top = `${cellBox.top - gridBox.top - tooltip.offsetHeight - 8}px`;
  };

  grid.addEventListener('mouseover', (event) => {
    const cell = (event.target as HTMLElement).closest<HTMLElement>('.fp-day');
    if (cell) show(cell);
  });

  grid.addEventListener('mouseout', (event) => {
    if ((event.target as HTMLElement).closest('.fp-day')) tooltip.classList.add('hidden');
  });

  // Touch: a tap is the only hover a phone has, and the grid is the one place
  // on the page where the figures live nowhere else.
  grid.addEventListener(
    'touchstart',
    (event) => {
      const cell = (event.target as HTMLElement).closest<HTMLElement>('.fp-day');
      if (cell) show(cell);
    },
    { passive: true }
  );
}
