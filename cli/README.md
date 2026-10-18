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
| `clawdgg logout` | Revoke the token and clear local state |
| `clawdgg disable` | Stop streaming (`--purge` also deletes `~/.config/clawdgg`) |
| `clawdgg version` | Print the version |

Flags: `--yes` assumes yes for every prompt (scripts, CI), `--no-import` skips the import step during setup.

Two more commands exist for Claude Code to call, not you: `statusline` (reports your Pro/Max limit windows) and `otel-headers` (prints the Authorization header for the exporter).

## How it works

`clawdgg setup` writes an OpenTelemetry block into `~/.claude/settings.json`, and Claude Code streams usage events to clawd.gg from then on.

Auth goes through `otelHeadersHelper`, Claude Code's hook for dynamic headers: it runs `clawdgg otel-headers` at startup and every 29 minutes, and that command prints your bearer token from `~/.config/clawdgg/config.json` (mode 0600). No credential is ever written into `settings.json`.

That indirection is the point. The old design baked a token into `OTEL_EXPORTER_OTLP_HEADERS`; when the token was revoked, the exporter 401'd forever in silence and months of data went missing. A helper that exits non-zero makes Claude Code show a startup warning instead. `clawdgg doctor` checks the same thing from the other end, including whether the server has actually received anything recently.

`clawdgg import` reads the transcripts Claude Code already keeps in `~/.claude/projects/` (and `~/.claude/history.jsonl` for days whose transcripts have rotated away) and sends the metrics telemetry would have sent. It only covers time before telemetry was switched on, the server enforces that boundary, and running it twice imports nothing the second time.

## Privacy

What gets sent:

- timestamps, model names, session ids
- token counts (input / output / cache) and the cost they imply
- how long your prompts were — the character count, not the text
- which tools ran, whether they succeeded, how long they took
- lines added/removed, commit counts
- your Claude Code version, terminal, and Pro/Max limit percentages

What never leaves your machine:

- your prompts (we store the length, never the words)
- file contents, code, diffs, file paths
- tool arguments, environment variables, secrets

`clawdgg setup` prints this list and waits for you to agree. `clawdgg disable` turns streaming off and restores any OpenTelemetry settings you had before — it remembers what it replaced. Your settings.json is backed up to `settings.json.clawdgg-backup-<timestamp>` before the first change, and if that file ever fails to parse, clawdgg aborts rather than overwrite it.

## Files

| Path | What |
|------|------|
| `~/.clawdgg/bin/clawdgg` | the binary |
| `~/.config/clawdgg/config.json` | auth token, mode 0600 |
| `~/.claude/settings.json` | the OTEL block and the two hooks |

## Environment variables

- `CLAWDGG_API_URL` — override the API URL (default: `https://clawd.gg`)
- `CLAWDGG_BIN` — override the path clawdgg registers for its own hooks
- `CLAWDGG_INSTALL_DIR` — where `install.sh` puts the binary
- `CLAWDGG_VERSION` — install a specific release

## Links

- **Leaderboard**: [clawd.gg](https://clawd.gg)
- **Source**: [GitHub](https://github.com/mael-ha/clawdgg)

## License

MIT
