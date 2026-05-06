# Debug Procedures

## Local Development

```bash
# Start server
bun run dev

# Test homepage
curl http://localhost:3000/

# Test profile
curl http://localhost:3000/u/mael-ha

# Test API
curl http://localhost:3000/api/leaderboard?period=all&sort=prompts
```

## CLI Testing

```bash
# Must set API URL for local testing
export CLAWDGG_API_URL="http://localhost:3000"

# Test commands
bun cli/index.ts login
bun cli/index.ts status
bun cli/index.ts setup
```

## Common Issues

### OAuth Login Fails

**Symptom:** Redirects back to login, no session created.

**Check:**
1. Cookie secure flag — See `beware.md`
2. Callback URL matches GitHub app settings
3. `APP_URL` env var is correct

**Debug:**
```bash
# Check cookies in browser devtools
# Application → Cookies → look for 'session'
```

### Leaderboard Empty

**Check:**
1. Database has data: `sqlite3 data/clawd.db "SELECT COUNT(*) FROM users"`
2. Sync job running: Check logs for "Sync completed"
3. ClickHouse connected: `curl http://localhost:3000/health`

### OTel Data Not Appearing

**Check:**
1. User ran `clawdgg setup`
2. Token valid: Check `users.token_expires_at`
3. ClickHouse receiving: Query `metrics_raw` table

**Debug:**
```bash
# Check raw metrics
ssh clawdgg 'docker exec clawdgg-clickhouse-1 clickhouse-client --query "SELECT COUNT(*) FROM metrics_raw"'
```

### CLI Shows Wrong Stats

**Cause:** Usually stale cache.

**Fix:**
```bash
rm ~/.config/clawdgg/cache.json
clawdgg status  # Re-parses all files
```

## Database Queries

### Check user data
```sql
SELECT id, github_username, total_prompts, total_tokens, otel_enabled
FROM users
ORDER BY total_prompts DESC
LIMIT 10;
```

### Check daily stats
```sql
SELECT date, SUM(prompt_count), SUM(token_count)
FROM daily_stats
GROUP BY date
ORDER BY date DESC
LIMIT 7;
```

### Check ClickHouse metrics
```sql
SELECT
  toDate(timestamp) as day,
  COUNT(*) as metrics
FROM metrics_raw
GROUP BY day
ORDER BY day DESC
LIMIT 7;
```

## Log Locations

| Service | Location |
|---------|----------|
| App | `docker logs clawdgg-app-1` |
| ClickHouse | `docker logs clawdgg-clickhouse-1` |
| Caddy | `docker logs clawdgg-caddy-1` (when using HTTPS) |
