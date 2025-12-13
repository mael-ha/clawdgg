# Setup Guide

## Prerequisites

- [Bun](https://bun.sh) runtime installed
- GitHub OAuth app (for auth)

## Quick Start

```bash
# Install dependencies
bun install

# Copy environment file
cp .env.example .env

# Edit .env with your values
# - GITHUB_CLIENT_ID
# - GITHUB_CLIENT_SECRET
# - SESSION_SECRET (generate with: openssl rand -hex 32)

# Push database schema
bun run db:generate
bunx drizzle-kit push

# Seed test data (optional)
bun run db:seed

# Start dev server
bun run dev
```

Server runs at http://localhost:3000

## Environment Variables

```env
# GitHub OAuth (create at https://github.com/settings/developers)
GITHUB_CLIENT_ID=your_client_id
GITHUB_CLIENT_SECRET=your_client_secret

# Session secret (32+ chars)
SESSION_SECRET=your_random_secret

# App URL (for OAuth callback)
APP_URL=http://localhost:3000

# Database path
DATABASE_PATH=./data/clawd.db

# Port (optional, default 3000)
PORT=3000
```

## GitHub OAuth Setup

1. Go to https://github.com/settings/developers
2. Click "New OAuth App"
3. Fill in:
   - Application name: `clawd.gg (dev)`
   - Homepage URL: `http://localhost:3000`
   - Authorization callback URL: `http://localhost:3000/auth/callback`
4. Copy Client ID and Client Secret to `.env`

## NPM Scripts

```bash
bun run dev          # Start dev server with hot reload
bun run start        # Start production server
bun run db:generate  # Generate Drizzle migrations
bun run db:migrate   # Apply migrations
bun run db:seed      # Seed test data
bun run typecheck    # Run TypeScript type check
```

## Testing the CLI

```bash
cd cli
bun run index.ts status   # Show local stats
bun run index.ts help     # Show help
```

## Troubleshooting

### Port 3000 in use
```bash
lsof -i :3000 | grep LISTEN | awk '{print $2}' | xargs kill -9
```

### Database issues
```bash
rm -rf data/clawd.db*
bunx drizzle-kit push
bun run db:seed
```
