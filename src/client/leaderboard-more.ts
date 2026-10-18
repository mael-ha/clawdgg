/**
 * "Load More" on the leaderboard — the only thing htmx (48KB) was here for.
 *
 * GET /rows returns the next page of rows plus its own Load More button, so
 * appending the fragment and dropping the clicked button's container is the
 * whole behaviour. Delegated from document, so the button that arrives with
 * the fragment is live without re-binding.
 */

const ROWS_TARGET = 'leaderboard-rows';

document.addEventListener('click', async (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-load-more]');
  const url = button?.dataset.loadMore;
  const target = document.getElementById(ROWS_TARGET);
  if (!button || !url || !target) return;

  button.disabled = true;
  button.textContent = 'Loading…';

  try {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    target.insertAdjacentHTML('beforeend', await response.text());
    button.parentElement?.remove();
  } catch (error) {
    console.error('Load more failed:', error);
    button.disabled = false;
    button.textContent = 'Retry';
  }
});
