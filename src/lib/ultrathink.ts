/**
 * The ultrathink flag: one bit about a prompt, decided on the user's machine.
 *
 * Two places decide it and they MUST decide it identically, or the live count
 * and the imported count mean different things:
 *   - cli/prompt-hook.ts, Claude Code's UserPromptSubmit hook, for new prompts
 *   - mapHistoryText in src/lib/session-import.ts, for ~/.claude/history.jsonl
 * Hence one regex, in one file, with no dependencies — this module is bundled
 * into the compiled CLI binary and read by the server, so it must not reach for
 * a filesystem, a database or an environment variable.
 *
 * The matcher is deliberately NOT configurable and not server-supplied. A
 * pattern the server could choose would be a way to ask what someone typed:
 * send enough patterns and the yes/no answers reconstruct the prompt. One
 * hardcoded word cannot be used that way.
 */

/** The event name these flags are stored under. See src/db/clickhouse.ts. */
export const ULTRATHINK_EVENT_NAME = 'clawdgg.ultrathink';

/**
 * The word, on its own, in any case.
 *
 * `\b` on BOTH sides, so this matches "ultrathink this" and "(ultrathink)" and
 * does NOT match "multrathink" or "ultrathinking". The trailing boundary is a
 * deliberate choice and not an oversight: "ultrathink" is a keyword people type
 * to ask for more thinking, and a count of the keyword is the honest thing to
 * report. Widening it to any word starting with "ultrathink" would quietly
 * change what the number on the profile means.
 */
const ULTRATHINK = /\bultrathink\b/i;

export function containsUltrathink(text: unknown): boolean {
  return typeof text === 'string' && ULTRATHINK.test(text);
}
