// Shell quoting for the command strings we register in ~/.claude/settings.json.
//
// `otelHeadersHelper` and `statusLine` are COMMAND STRINGS: Claude Code runs
// them through a shell, not as an argv. Our own path goes inside them, and that
// path is `homedir()`-derived — so a user called "Mael O'Hara", a checkout in
// "~/My Projects/", or anything with a `$`, a backtick or a `;` in it would
// otherwise be re-parsed by the shell. Single quotes make every byte literal;
// the only escape inside them is to close, add a literal quote, and reopen.

const SAFE_UNQUOTED = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Quote one argv element so a POSIX shell passes it through verbatim. */
export function shellQuote(arg: string): string {
  if (arg === "") return "''";
  if (SAFE_UNQUOTED.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Quote every element of an argv and join it into one command string. */
export function shellJoin(argv: readonly string[]): string {
  return argv.map(shellQuote).join(" ");
}

/**
 * Split a command string back into its argv, well enough to inspect a value we
 * find in settings.json: single and double quotes, backslash escapes outside
 * quotes, whitespace separators. Not a shell — expansion, redirection and
 * operators are treated as ordinary characters, which is right for "is the last
 * word `statusline`?" and wrong for anything that would need to run it.
 */
export function shellSplit(command: string): string[] {
  const argv: string[] = [];
  let current = "";
  let started = false;
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;

    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === "\\" && i + 1 < command.length) current += command[++i];
      else current += char;
      continue;
    }

    // An unquoted `#` that starts a word begins a comment, exactly as a shell
    // reads it — `starship prompt # clawdgg statusline` does NOT run ours.
    if (char === "#" && !started) break;

    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (char === "\\" && i + 1 < command.length) {
      current += command[++i];
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) argv.push(current);
      current = "";
      started = false;
      continue;
    }
    current += char;
    started = true;
  }

  if (started) argv.push(current);
  return argv;
}
