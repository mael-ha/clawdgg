# clawd.gg CLI

Official CLI tool for syncing your Claude Code stats to [clawd.gg](https://clawd.gg).

## Installation

```bash
# Install globally with Bun
bun install -g clawd-gg

# Or install globally with npm
npm install -g clawd-gg
```

## Usage

### Login

Authenticate with GitHub to start syncing your stats:

```bash
clawd-gg login
```

This will open your browser for GitHub OAuth authentication.

### Sync Stats

Upload your latest Claude Code stats to clawd.gg:

```bash
clawd-gg sync
```

### Check Status

View your current stats and authentication status:

```bash
clawd-gg status
```

## Commands

- `clawd-gg login` - Authenticate with GitHub
- `clawd-gg sync` - Sync your stats to clawd.gg
- `clawd-gg status` - Show current stats summary
- `clawd-gg help` - Show help message

## Configuration

- Stats are read from: `~/.claude/stats-cache.json`
- Auth token is stored in: `~/.clawd-gg/config.json`

## Development

```bash
# Install dependencies
bun install

# Run locally
bun run dev status

# Build
bun run build
```

## Environment Variables

- `CLAWD_API_URL` - Override the API base URL (default: `https://clawd.gg`)

## License

MIT
