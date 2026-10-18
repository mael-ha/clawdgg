import { describe, expect, it } from 'bun:test';
import { shellJoin, shellQuote, shellSplit } from './shell';

describe('shellQuote', () => {
  it('leaves an ordinary path alone', () => {
    expect(shellQuote('/Users/x/.clawdgg/bin/clawdgg')).toBe('/Users/x/.clawdgg/bin/clawdgg');
    expect(shellQuote('otel-headers')).toBe('otel-headers');
    expect(shellQuote('--no-env-file')).toBe('--no-env-file');
  });

  it('quotes whitespace and shell metacharacters', () => {
    expect(shellQuote('/Users/x/My Projects/clawdgg')).toBe("'/Users/x/My Projects/clawdgg'");
    expect(shellQuote('a;rm -rf ~')).toBe("'a;rm -rf ~'");
    expect(shellQuote('$HOME')).toBe("'$HOME'");
    expect(shellQuote('`id`')).toBe("'`id`'");
    expect(shellQuote('a&&b')).toBe("'a&&b'");
    expect(shellQuote('')).toBe("''");
  });

  it("escapes an embedded single quote the only way a shell allows", () => {
    expect(shellQuote("O'Hara")).toBe(`'O'\\''Hara'`);
  });
});

describe('shellQuote → shellSplit round-trips', () => {
  // The quoting is only worth anything if it survives the shell's own parsing,
  // and shellSplit is how we read a value back out of settings.json.
  const cases = [
    ['/Users/x/.clawdgg/bin/clawdgg', 'otel-headers'],
    ["/Users/Mael O'Hara/My Projects/clawdgg", 'statusline'],
    ['/opt/bun', '--no-env-file', '/src/my cli/index.ts', 'statusline'],
    ['a;rm -rf ~', '$HOME', '`id`', 'otel-headers'],
    ['', 'otel-headers'],
  ];

  for (const argv of cases) {
    it(`round-trips ${JSON.stringify(argv)}`, () => {
      expect(shellSplit(shellJoin(argv))).toEqual(argv);
    });
  }
});

describe('shellSplit', () => {
  it('handles double quotes and backslash escapes', () => {
    expect(shellSplit('"/Users/x/My Projects/clawdgg" statusline')).toEqual([
      '/Users/x/My Projects/clawdgg',
      'statusline',
    ]);
    expect(shellSplit('/Users/x/My\\ Projects/clawdgg statusline')).toEqual([
      '/Users/x/My Projects/clawdgg',
      'statusline',
    ]);
  });

  it('collapses runs of whitespace and ignores a trailing one', () => {
    expect(shellSplit('  npx   clawdgg  statusline  ')).toEqual(['npx', 'clawdgg', 'statusline']);
  });

  it('is empty for an empty command', () => {
    expect(shellSplit('')).toEqual([]);
    expect(shellSplit('   ')).toEqual([]);
  });
});

describe('shellSplit comments', () => {
  it('stops at an unquoted # that starts a word', () => {
    // `starship prompt # clawdgg statusline` must not look like ours.
    expect(shellSplit('starship prompt # clawdgg statusline')).toEqual(['starship', 'prompt']);
  });

  it('keeps a # inside a word or inside quotes', () => {
    expect(shellSplit('/tmp/a#b statusline')).toEqual(['/tmp/a#b', 'statusline']);
    expect(shellSplit(`'/tmp/a #b/clawdgg' statusline`)).toEqual(['/tmp/a #b/clawdgg', 'statusline']);
  });
});
