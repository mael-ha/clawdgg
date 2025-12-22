# clawd.gg

## Now (sync with now.md at session end)
🟢 HTTP | Blocked: domain | Next: profile UX (token display), then domain
Last: Updated pricing from official docs, fixed cost display. TODO: "10.9M" feels small—consider showing 2.1B context.

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
