# clawd.gg

## Now (sync with now.md at session end)
🟢 HTTP | Blocked: domain | Next: Dashboard V2 Phase 1 (archetype system, hero redesign)
Last: Deep planning for Dashboard V2. Full plan in `.claude/memento/knowledge/dashboard-v2-plan.md`

## Deploy
```bash
rsync -avz src/ clawdgg:/opt/clawdgg/src/ && ssh clawdgg 'cd /opt/clawdgg && docker compose -f docker-compose.staging.yml up -d --force-recreate app'
```

## Burned In
```typescript
// Cookie — NEVER use NODE_ENV
secure: APP_URL.startsWith('https://')
```
```bash
# Docker — restart WON'T reload .env
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
