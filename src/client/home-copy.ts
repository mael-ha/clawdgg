/**
 * The copy button on the homepage's install line.
 *
 * Separate from profile-share.ts, which hands the profile's URL to the share
 * sheet and lives on profiles: this one is the only JavaScript the homepage
 * loads, and bundling it with that would ship the profile's island to every
 * first-time visitor.
 *
 * Delegated from document, so the button needs no id and no re-binding.
 */

const RESTORE_AFTER_MS = 2000;

document.addEventListener('click', async (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-copy-install]');
  if (!button) return;

  const command = button.dataset.copyInstall ?? '';
  const original = button.dataset.copyLabel ?? button.textContent ?? 'copy';
  button.dataset.copyLabel = original;

  try {
    await navigator.clipboard.writeText(command);
    button.textContent = '✓ copied';
  } catch {
    // No clipboard (an insecure origin, or a browser that refused): say so
    // rather than show a tick for something that did not happen. The command
    // is visible beside the button and can be selected by hand.
    button.textContent = '✗ select it';
  }

  setTimeout(() => {
    button.textContent = original;
  }, RESTORE_AFTER_MS);
});
