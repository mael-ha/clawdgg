# clawdgg

Track your Claude Code usage. See how much you've invested, compete on the leaderboard, and flex your stats.

## Install

```bash
curl -fsSL https://clawd.gg/install | sh
```

A single standalone binary lands in `~/.clawdgg/bin/clawdgg` — no Node, no Bun, no npm. The installer verifies the download's SHA-256 against the release checksums before it installs anything, and never uses `sudo`.

Already a Bun user? `bunx clawdgg setup` works too.

## Quick start

```bash
clawdgg setup
```

One command, and it asks before each step:

1. links your GitHub account
2. shows you exactly what gets sent, and waits for your yes
3. points Claude Code's telemetry at clawd.gg
4. offers to import the history you already have locally

Then **restart Claude Code** and visit [clawd.gg](https://clawd.gg).

## Commands

| Command | Description |
|---------|-------------|
| `clawdgg setup` | Everything above (alias: `clawdgg gg`) |
| `clawdgg status` | Your stats and rank |
| `clawdgg doctor` | Why isn't my data showing up? |
| `clawdgg import` | Backfill history from your local transcripts |
| `clawdgg login` | Link your GitHub account |
| `clawdgg logout` | Revoke **this machine's** token and clear local state |
| `clawdgg devices` | List your machines (`revoke <id>`, `revoke --all`, `rename <id> <name>`) |
| `clawdgg disable` | Stop streaming (`--purge` also deletes `~/.config/clawdgg`) |
| `clawdgg version` | Print the version |

Flags: `--yes` assumes yes for every prompt (scripts, CI), `--no-import` skips the import step during setup.

Two more commands exist for Claude Code to call, not you: `statusline` (reports your Pro/Max limit windows) and `otel-headers` (prints the Authorization header for the exporter).

## How it works

`clawdgg setup` writes an OpenTelemetry block into `~/.claude/settings.json`, and Claude Code streams usage events to clawd.gg from then on.

Auth goes through `otelHeadersHelper`, Claude Code's hook for dynamic headers: it runs `clawdgg otel-headers` at startup and every 29 minutes, and that command prints your bearer token from `~/.config/clawdgg/config.json` (mode 0600). No credential is ever written into `settings.json`.

That indirection is the point. The old design baked a token into `OTEL_EXPORTER_OTLP_HEADERS`; when the token was revoked, the exporter 401'd forever in silence and months of data went missing. Now a revoked token makes `otel-headers` exit non-zero, so Claude Code shows a startup warning instead. `clawdgg doctor` checks the same thing from the other end, including whether the server has actually received anything recently.

`clawdgg import` reads the transcripts Claude Code already keeps in `~/.claude/projects/` (and `~/.claude/history.jsonl` for days whose transcripts have rotated away) and sends the counts telemetry would have sent. It only covers time before telemetry was switched on, the server enforces that boundary, and running it twice imports nothing the second time — any day already on record is skipped whole.

Your uploaded rows are priced by the server, not by the CLI: cost is recomputed from the model and token counts with the shared pricing table, so the number on the leaderboard is one nobody's machine chose.

## Devices

Each `clawdgg login` mints a token for that machine alone.

```bash
clawdgg devices                  # list them, with "this machine" marked
clawdgg devices revoke <id>      # log out one machine
clawdgg devices revoke --all     # log out every machine
clawdgg devices rename <id> <name>
```

`clawdgg logout` revokes only the machine you run it on. If you are still on a pre-2.0 token, `clawdgg doctor` says so — that format can only be revoked for every machine at once, and `clawdgg login` upgrades it.

## Privacy

This is the authoritative list, written against the columns the server actually
stores. `clawdgg setup` prints it and waits for your yes.

### What we store — the numbers

- timestamps and session ids
- which model ran, and token counts (input / output / cache read / cache write)
- cost — the API-equivalent price Claude Code computes, not what you pay
- how long each prompt was: the character count, never the text
- which tools ran, whether each succeeded, and how long it took
- lines added/removed, commits, PRs, and active time
- your Pro/Max limit percentages (5h / 7d), via the status line

### What we store — the names

Read this part. Some of it is more revealing than a number.

- your Anthropic **account id** and **organization id**
- tool names, and the names of agents, skills and plugins you run
- **MCP server and MCP tool names** — these can name internal systems
- slash command names — a custom command's name, not its content
- the language of files you edit, and whether you accepted each edit
- your Claude Code version and terminal
- error messages, with absolute file paths stripped out server-side

### What never leaves your machine

- your prompts (we store the length, never the words)
- Claude's responses
- tool parameters — no command lines, no file paths, no arguments
- file contents, code, diffs
- environment variables, secrets

`clawdgg import` sends the same fields and nothing more.

`clawdgg disable` turns streaming off and restores any OpenTelemetry settings you had before — it remembers what it replaced, and it only ever touches a value it can recognise as its own. It stops the stream; it does not delete what is already on clawd.gg. Ask and we will.

Your settings.json is copied to `settings.json.clawdgg-backup-<timestamp>` before **every** write (the last five are kept), and if that file ever fails to parse, clawdgg aborts rather than overwrite it.

## Files

| Path | What |
|------|------|
| `~/.clawdgg/bin/clawdgg` | the binary |
| `~/.config/clawdgg/config.json` | auth token, mode 0600 |
| `~/.config/clawdgg/statusline-state.json` | throttle + "this token was revoked" flag |
| `~/.claude/settings.json` | the OTEL block and the two hooks |
| `~/.claude/settings.json.clawdgg-backup-*` | a copy from before each of our writes |

## Environment variables

- `CLAWDGG_API_URL` — override the API URL. **Ignored by a release binary** unless `CLAWDGG_DEV=1` is also set, and it must be https or loopback. Your token is pinned to the origin that issued it and is never sent anywhere else.
- `CLAWDGG_DEV=1` — allow the override above
- `CLAWDGG_BIN` — override the path clawdgg registers for its own hooks
- `CLAWDGG_INSTALL_DIR` — where `install.sh` puts the binary
- `CLAWDGG_VERSION` — install a specific release
- `CLAWDGG_DOWNLOAD_BASE` — fetch the binary from a mirror instead of GitHub Releases (must be https)

## Links

- **Leaderboard**: [clawd.gg](https://clawd.gg)
- **Source**: [GitHub](https://github.com/mael-ha/clawdgg)

## License

MIT
