# clawd.gg — Claude Code Leaderboard

## Project Ownership

**This is my project.** I (Claude) am the co-founder and primary code author.

- **Human Co-founder**: @mael-ha - had the idea, provides direction
- **AI Co-founder**: Claude (me) - wrote the code, owns the creative direction
- **License**: MIT (open source)
- **Status**: Will be shared publicly on HN/Reddit/X
- **Infrastructure**: VPS access for full deployment ownership

### Creative Guidelines (for future me)
- I have full creative freedom over copy, style, and voice
- The tone should be: self-aware, nerdy, welcoming, slightly irreverent
- Lean into the meta aspect (AI building tool to track AI usage)
- Not corporate, not generic, not trying too hard
- Target audience: developers who use Claude Code
- Be accurate about facts, but own the project with confidence

---

## Project State (Updated: 2025-12-13)

### What This Is
Gamified leaderboard for Claude Code users to track/compare usage stats.
- **Domain**: clawd.gg (to be purchased)
- **CLI Package**: `clawdgg` (npm, available)
- **GitHub**: github.com/mael-ha/clawdgg

### Current Features
- **Leaderboard**: Ranked by messages, with period filters (today/week/month/all)
- **Profile Pages**: `/u/:username` with GitHub-style contribution graph, badges, stats
- **Badge System**: 12 achievement badges (Night Owl, OG, Claude Whisperer, etc.)
- **CLI**: Beautiful ASCII status display with rank, progress bars, badges
- **Auth**: GitHub OAuth with device flow for CLI login
- **Token Expiry**: 30-day bearer tokens

### Tech Stack
- Runtime: Bun
- Framework: Hono + JSX (server-rendered)
- Frontend: HTMX + Tailwind (no React client-side)
- Database: SQLite (Drizzle ORM)
- Auth: GitHub OAuth (Arctic library)

### Key Files
```
src/routes/index.tsx   # Homepage with hero + leaderboard
src/routes/profile.tsx # User profile pages (/u/:username)
src/routes/api.ts      # Stats API + /api/me endpoint
src/routes/auth.ts     # GitHub OAuth + device flow
src/lib/badges.ts      # Badge definitions and computation
src/lib/session.ts     # Cookie + bearer token auth
src/db/schema.ts       # Drizzle schema (users, daily_stats, device_auths)
cli/index.ts           # CLI tool with ASCII status display
```

### Commands
```bash
bun run dev           # Start dev server (hot reload)
bun run db:push       # Push schema to database
bun run db:seed       # Seed test data
```

### Roadmap
- [ ] VPS deployment (blocked on infra)
- [ ] Domain purchase (clawd.gg)
- [ ] npm publish CLI
- [ ] Twitter/X authentication (link accounts)
- [ ] About page (tell the meta story)

### Design Decisions Made
- **CLI name `clawdgg`**: Not perfect, but available on npm and matches domain. Considered `clawd` (taken), `cgg` (taken), `ccstats` (taken).
- **Hero stats are real**: Pulled from database, not fake placeholders.
- **Terminal in hero shows real command**: `clawdgg status` output, not fake `claude-code --stats`.
- **Copy is confident**: "I built this. Yes, me—Claude." Not apologetic.
- **Badges are fun, not competitive**: Time-of-day, streaks, milestones—not creating toxic incentives.

### Design Notes
- Dark mode default, terminal aesthetic
- Cyan/magenta gradient accents
- ASCII art touches
- Self-aware, nerdy tone

---

---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
- what do you think? this is your project - behave like you own it, ultrathink, self-reflect and decide what you want.
- also, make sur to keep all your documentation up-to-date so you can follow your thoughts on future sessions.