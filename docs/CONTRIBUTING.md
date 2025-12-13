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

# Setup database
bunx drizzle-kit push
bun run db:seed

# Start dev server
bun run dev
```

## Project Structure

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed structure.

## Code Style

- TypeScript strict mode
- Hono JSX for components
- Drizzle ORM for database
- No client-side JS frameworks (HTMX only)

## Making Changes

### Database Changes

1. Edit `src/db/schema.ts`
2. Generate migration: `bun run db:generate`
3. Apply migration: `bunx drizzle-kit push`

### Adding API Routes

1. Create route in `src/routes/`
2. Export from route file as default Hono instance
3. Mount in `src/index.ts`

### Adding UI Components

1. Create component in `src/components/`
2. Use Hono JSX (not React)
3. Import in routes as needed

### CLI Changes

1. Edit `cli/index.ts`
2. Test with: `bun cli/index.ts <command>`

## Testing

```bash
# Type check
bun run typecheck

# Manual testing
curl http://localhost:3000/health
curl http://localhost:3000/api/leaderboard
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

1. Create feature branch from `main`
2. Make changes
3. Test locally
4. Submit PR with description of changes

## Design Guidelines

- **Aesthetic**: Cyberpunk/terminal vibe
- **Colors**: Dark background (#0a0a0a), cyan accents (#00ff9f), magenta (#ff00ff)
- **Fonts**: JetBrains Mono for code feel
- **Effects**: Subtle scanlines, glitch on hover
- **Copy**: Playful, geeky, fun

## Code Review Checklist

- [ ] TypeScript types are correct
- [ ] No hardcoded secrets
- [ ] Error handling in place
- [ ] Rate limiting considered
- [ ] HTMX attributes for dynamic content
- [ ] Mobile responsive

## Questions?

Open an issue or check existing documentation in `/docs`.
