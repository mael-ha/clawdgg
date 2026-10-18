/**
 * Hover tooltip for the 365-day contribution graph.
 *
 * Numbers and the date go through src/lib/format, the same module the server
 * rendered the page with — the inline version had its own formatNum and its
 * own month table, and read the UTC date key with local getters.
 */

import { formatCost, formatDateLong, formatTokens } from '../lib/format';

const container = document.getElementById('contribution-graph-container');
const tooltip = document.getElementById('contrib-tooltip');

if (container && tooltip) {
  const num = (value: string | undefined): number | undefined =>
    value === undefined ? undefined : Number.parseInt(value, 10) || 0;

  container.addEventListener('mouseover', (event) => {
    const cell = (event.target as HTMLElement).closest<HTMLElement>('.contrib-cell');
    if (!cell?.dataset.date) return;

    const { date, tokens, linesAdded, linesRemoved, cost } = cell.dataset;
    const count = num(cell.dataset.count) ?? 0;

    const rows: string[] = [];
    if (count > 0) {
      rows.push(`<div class="text-white">${count} prompts</div>`);
    } else if (tokens !== undefined && (num(tokens) ?? 0) > 0) {
      rows.push('<div class="text-gray-500 text-xs italic">backfilled — prompt count unavailable</div>');
    }

    if (tokens !== undefined) {
      rows.push(`<div class="text-cyan-400">${formatTokens(num(tokens) ?? 0)} tokens</div>`);
    }

    if (linesAdded !== undefined || linesRemoved !== undefined) {
      const added = formatTokens(num(linesAdded) ?? 0);
      // OTEL days track removals, legacy days don't — only then is +/- honest.
      rows.push(
        linesRemoved !== undefined
          ? `<div><span class="text-green-400">+${added}</span> / <span class="text-red-400">-${formatTokens(num(linesRemoved) ?? 0)}</span> lines</div>`
          : `<div><span class="text-green-400">+${added} lines</span></div>`,
      );
    }

    if (cost !== undefined) {
      rows.push(`<div class="text-amber-400">${formatCost(Math.round((Number.parseFloat(cost) || 0) * 100))}</div>`);
    }

    tooltip.innerHTML =
      `<div class="text-gray-300 mb-1">${formatDateLong(date)}</div>` +
      `<div class="border-t border-gray-700 pt-1 mt-1 space-y-0.5">${rows.join('')}</div>`;
    tooltip.classList.remove('hidden');

    const cellRect = cell.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    tooltip.style.left = `${cellRect.left - containerRect.left + cellRect.width / 2}px`;
    tooltip.style.top = `${cellRect.top - containerRect.top - tooltip.offsetHeight - 8}px`;
  });

  container.addEventListener('mouseout', (event) => {
    if (!(event.target as HTMLElement).closest('.contrib-cell')) return;
    tooltip.classList.add('hidden');
  });
}
