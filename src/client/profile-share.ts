/**
 * The profile's "share" button.
 *
 * The link IS the share: /u/<username> carries the card as its og:image, so
 * handing the URL to the OS share sheet unfurls into the card wherever it is
 * pasted. Where there is no share sheet — or the sheet errors — the URL goes
 * to the clipboard instead and the label says so.
 */

const RESTORE_AFTER_MS = 2000;

document.addEventListener('click', async (event) => {
  const button = (event.target as HTMLElement).closest<HTMLElement>('[data-share-url]');
  if (!button) return;

  const url = button.dataset.shareUrl ?? '';

  if (navigator.share && navigator.canShare?.({ url }) !== false) {
    try {
      await navigator.share({ url, title: document.title });
      return;
    } catch (error) {
      // A dismissed sheet is not a failure: the user said no, so say nothing
      // and leave the label alone. Anything else falls through to the copy.
      if (error instanceof DOMException && error.name === 'AbortError') return;
    }
  }

  const original = button.dataset.copyLabel ?? button.textContent ?? '';
  button.dataset.copyLabel = original;

  try {
    await navigator.clipboard.writeText(url);
    button.textContent = '✓ copied';
  } catch {
    button.textContent = '✗ copy failed';
  }

  setTimeout(() => {
    button.textContent = original;
  }, RESTORE_AFTER_MS);
});
