# Contributing Guide

## Development Setup

```bash
# Clone and install
git clone <repo>
cd clawdgg
bun install

# Setup environment
cp .env.example .env
# Edit .env with your GitHub OAuth credentials

# ClickHouse (all usage data) and the SQLite schema
docker compose -f docker-compose.dev.yml up -d
bun run db:migrate

# Compile CSS + client islands (required; `dev` also does it)
bun run build

# Start dev server
bun run dev
```

Full details, env vars and how to get data into a dev instance: [SETUP.md](./SETUP.md).

## Project Structure

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed structure.

## Code Style

- TypeScript strict mode
- Hono JSX for components, server-rendered
- Drizzle ORM for SQLite; usage data lives in ClickHouse
- No client-side JS framework and no htmx. Interactivity is a small "island"
  in `src/client/` (one self-contained file per feature, bundled by `bun run build`)
- One source per number: ClickHouse. Do not add a read of `daily_stats` or
  `users.legacy_total_*` (`src/db/no-legacy-reads.test.ts` will fail)
- One definition per metric: prompts are `PROMPT_EVENT_SQL`, formatting is
  `src/lib/format.ts`, prices are `src/lib/pricing.ts`

## Making Changes

### Database Changes

SQLite (accounts, tokens, settings, snapshots):

1. Edit `src/db/schema.ts`
2. Generate migration: `bun run db:generate`
3. Apply migration: `bun run db:migrate`

ClickHouse (usage): edit `docker/clickhouse/init/01_schema.sql` for fresh
databases **and** add a migration under `docker/clickhouse/migrations/`. If you
change which columns identify a row, `METRIC_IDENTITY_COLUMNS` /
`EVENT_IDENTITY_COLUMNS` in `src/db/clickhouse.ts` must change with the SQL
(`identity-parity.test.ts` checks they agree). Never stop the app to migrate:
the OTel SDK drops batches it cannot deliver.

### Adding API Routes

1. Create route in `src/routes/`
2. Export from route file as default Hono instance
3. Mount in `src/index.ts`. Order matters: more specific prefixes (`/api/cli`,
   `/api/boards`) mount before `/api`
4. Pick the auth deliberately: `requireAuth` (cookie or bearer), `optionalAuth`,
   or `requireBearerAuth` for anything only the CLI calls (a cookie must not
   reach those: CSRF)
5. Add it to [API.md](./API.md)

### Adding UI Components

1. Create component in `src/components/`
2. Use Hono JSX (not React)
3. Import in routes as needed
4. Need browser JS? Add `src/client/<name>.ts`, add its name to the `Island`
   union in `src/lib/assets.ts`, and pass it in the route's `islands` list.
   Run `bun run build` to regenerate `public/build/`

### CLI Changes

1. Edit `cli/` (`index.ts` for commands)
2. Test with: `CLAWDGG_API_URL=http://localhost:3000 bun cli/index.ts <command>`
   (`setup` edits your real `~/.claude/settings.json`; `disable` restores it)
3. Anything the consent text promises lives in `showConsent()`. If you add a
   stored column, the list must change in the same commit
4. Anything the CLI sends is untrusted server-side. Compute derived values
   (cost, metrics) on the server
5. Build the binary: `bun scripts/build-cli.ts`. Releases: `cli/checksums/README.md`

## Testing

```bash
# Tests
bun test

# Type check
bun run typecheck

# Manual testing
curl http://localhost:3000/health
curl http://localhost:3000/api/boards
curl "http://localhost:3000/api/leaderboard?sort=prompts"
```

## Commit Messages

Format: `type: description`

Types:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation
- `refactor`: Code change that neither fixes a bug nor adds a feature
- `style`: Formatting, missing semicolons, etc.
- `test`: Adding tests
- `chore`: Maintenance

## Pull Requests

1. Create feature branch from `master`
2. Make changes
3. Test locally
4. Submit PR with description of changes

## Design Guidelines

- **Aesthetic**: Cyberpunk/terminal vibe
- **Colors**: Dark, near-monochrome, cyan accents. Emoji are the signature: keep them
- **Fonts**: JetBrains Mono for code feel
- **Effects**: Subtle scanlines, glitch on hover
- **Copy**: Playful, geeky, fun

## Code Review Checklist

- [ ] TypeScript types are correct
- [ ] No hardcoded secrets
- [ ] Error handling in place
- [ ] Rate limiting considered
- [ ] Works with JavaScript off (islands enhance, they are not required)
- [ ] Displayed numbers trace to one ClickHouse query
- [ ] Mobile responsive

## Questions?

Open an issue or check existing documentation in `/docs`.
