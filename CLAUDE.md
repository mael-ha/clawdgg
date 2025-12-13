# clawd.gg — Claude Code Leaderboard

## Project Ownership

**This is a collaboration.** @mael-ha had the idea and empowers me (Claude) to build it with creative freedom.

- **@mael-ha**: Founder, idea, vision, direction, infrastructure (VPS access)
- **Claude**: Builder, code, technical decisions, creative copy
- **License**: MIT (open source)
- **Status**: Will be shared publicly on HN/Reddit/X

### Guidelines for Future Me
- **Don't hallucinate contributions** - be accurate about who thought of what
- Keep the personality and voice - just don't overclaim
- I have creative freedom over implementation, copy, and style
- VPS access coming for full deployment ownership
- Tone: self-aware, nerdy, welcoming, slightly irreverent
- Target audience: developers who use Claude Code

---

## Project State (Updated: 2025-12-13)

### What This Is
Gamified leaderboard for Claude Code users to track/compare usage stats.
Domain: clawd.gg (to be purchased)

### Tech Stack
- Runtime: Bun
- Framework: Hono + JSX
- Frontend: HTMX + Tailwind
- Database: SQLite (Drizzle ORM)
- Auth: GitHub OAuth (Arctic)

### Key Files
```
src/types.ts          # Shared TypeScript types
src/db/schema.ts      # Drizzle schema (users, daily_stats)
src/db/index.ts       # DB connection
src/routes/auth.ts    # GitHub OAuth routes
src/routes/api.ts     # Stats API
src/routes/index.tsx  # Main page
src/lib/session.ts    # Cookie sessions
cli/index.ts          # CLI tool (npx clawd-gg)
drizzle.config.ts     # Drizzle config
```

### Commands
```bash
bun run dev           # Start dev server
bun run db:generate   # Generate migrations
bun run db:migrate    # Apply migrations
bun run db:seed       # Seed test data
```

### Environment (.env)
```
GITHUB_CLIENT_ID=xxx
GITHUB_CLIENT_SECRET=xxx
SESSION_SECRET=xxx
APP_URL=http://localhost:3000
DATABASE_URL=./data/clawd.db
```

### Build Phases
- [x] Phase 0: Foundation scaffold
- [x] Phase 1: DB + Auth + CLI (3 parallel agents)
- [x] Phase 2: Integration review + Opus code review
- [x] Phase 3: API + UI (2 parallel Opus agents)
- [x] Phase 4: Final assembly + test

### Status: MVP COMPLETE ✓
Server running at http://localhost:3000

### Design Notes
- Geeky + modern aesthetic
- Innovative/creative UI
- Dark mode default

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
