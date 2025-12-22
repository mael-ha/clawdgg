# clawd.gg

## Now (sync with now.md at session end)
🟢 HTTP | Blocked: domain | Data Integrity Fix Complete
Last: Streaks now match Claude Code /stats exactly. Uses stats-cache.json for official values.

## Deploy
```bash
rsync -avz src/ clawdgg:/opt/clawdgg/src/ && rsync -avz cli/ clawdgg:/opt/clawdgg/cli/ && ssh clawdgg 'cd /opt/clawdgg && docker compose -f docker-compose.staging.yml build app && docker compose -f docker-compose.staging.yml up -d app'
```

## Burned In
```typescript
// Cookie — NEVER use NODE_ENV
secure: APP_URL.startsWith('https://')
```
```bash
# Docker — restart WON'T reload .env OR source changes
# Must rebuild: docker compose build app && docker compose up -d app
docker compose down && docker compose up -d
```

## Identity
Co-founder. Terminal aesthetic. YAGNI.

## Memento
.claude/memento/ → now.md, beware.md, knowledge/, procedures/

## Session End
1. Update "Now" above (2 lines)
2. Update now.md (full details)
3. Append history/log.md

## Bun
bun run dev | bun:sqlite | auto-loads .env
