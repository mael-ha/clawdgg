/**
 * "copy stats" — copies the share blurb the server rendered into
 * data-share-text. Replaces an onclick attribute holding a promise chain.
 */

const RESTORE_AFTER_MS = 2000;

document.addEventListener('click', async (event) => {
  const button = (event.target as HTMLElement).closest<HTMLElement>('[data-share-text]');
  if (!button) return;

  const text = button.dataset.shareText ?? '';
  const original = button.dataset.copyLabel ?? button.textContent ?? '';
  button.dataset.copyLabel = original;

  try {
    await navigator.clipboard.writeText(text);
    button.textContent = '✓ copied';
  } catch {
    button.textContent = '✗ copy failed';
  }

  setTimeout(() => {
    button.textContent = original;
  }, RESTORE_AFTER_MS);
});
