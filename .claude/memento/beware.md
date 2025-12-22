# Beware

Critical warnings. Read every session. These are my tattoos.

---

## 🔴 CRITICAL

### Cookie Secure Flag (HAPPENED 3 TIMES!)

**The bug:** Secure cookies only work over HTTPS. On HTTP, browser silently drops them.

**Wrong pattern:**
```typescript
secure: process.env.NODE_ENV === 'production'  // WRONG! Production can be HTTP
```

**Correct pattern:**
```typescript
const isHttps = (process.env.APP_URL || '').startsWith('https://');
secure: isHttps
```

**Files fixed:**
- `src/routes/auth.ts` — `github_oauth_state` cookie
- `src/lib/session.ts` — `session` cookie
- `src/routes/auth.ts` — `device_code` cookie

**When we have HTTPS:** Just set `APP_URL=https://clawd.gg` — no code changes needed.

---

### SQL Injection in Leaderboard Sort

**The bug:** Sort parameter used directly in `sql.raw()` without validation.

**Fix:** Whitelist validation before sql.raw():
```typescript
const VALID_SORT_COLUMNS: Record<string, string> = {
  prompts: 'promptCount',
  tokens: 'tokenCount',
  // ...
};
const sortColumn = VALID_SORT_COLUMNS[sort];
if (!sortColumn) return c.json({ error: 'Invalid sort' }, 400);
```

---

## 🟡 CAUTION

### Docker Restart Doesn't Reload .env

**Issue:** `docker compose restart` does NOT reload `.env` files. Container keeps old env vars.

**Symptoms:** Changed `.env` on VPS, restarted, but container still uses old values.

**Fix:** Use `down && up` or `--force-recreate`:
```bash
# Option 1: Full recreate
docker compose -f docker-compose.staging.yml down && docker compose -f docker-compose.staging.yml up -d

# Option 2: Force recreate specific service
docker compose -f docker-compose.staging.yml up -d --force-recreate app
```

---

### better-sqlite3 Native Module

**Issue:** Doesn't work in Docker unless you add build tools.

**Fix in Dockerfile:**
```dockerfile
RUN apt-get update && apt-get install -y python3 make g++
```

### drizzle-kit in Docker

**Issue:** `drizzle-kit migrate` fails in container (native module).

**Workaround:** Use `run-migrations.ts` script:
```bash
ssh clawdgg 'docker cp /opt/clawdgg/run-migrations.ts clawdgg-app-1:/app/ && docker exec clawdgg-app-1 bun /app/run-migrations.ts'
```

### Double Server Start (EADDRINUSE)

**Issue:** `export default app` causes Bun to start server twice.

**Fix:** Use `export { app }` instead.

---

## 🟢 REMINDERS

### GitHub OAuth Callback URL

Must be EXACTLY `/auth/callback`, not `/auth/github/callback`.

Current: `http://46.224.85.32:3000/auth/callback`
When domain ready: `https://clawd.gg/auth/callback`

### ClickHouse Config Permissions

Config files need `chmod 644`:
```bash
chmod 644 docker/clickhouse/config.xml
chmod 644 docker/clickhouse/init/*.sql
```

### stats-cache.json is Unreliable

- Undercounts by ~50%
- Misses agent sessions entirely
- CLI parses raw `.jsonl` files directly instead
