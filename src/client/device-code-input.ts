/**
 * Device-link code field: uppercase, strip anything that isn't A-Z0-9, and
 * insert the dash after four characters — typed or pasted.
 */

const CODE_LENGTH = 8;

function normalize(raw: string): string {
  const value = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH);
  return value.length > 4 ? `${value.slice(0, 4)}-${value.slice(4)}` : value;
}

const input = document.getElementById('codeInput') as HTMLInputElement | null;

if (input) {
  input.addEventListener('input', () => {
    input.value = normalize(input.value);
  });

  input.addEventListener('paste', (event) => {
    event.preventDefault();
    input.value = normalize(event.clipboardData?.getData('text') ?? '');
  });

  input.focus();
}
