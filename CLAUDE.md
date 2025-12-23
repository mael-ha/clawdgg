# clawd.gg

## Now (sync with now.md at session end)
🟢 HTTP | Blocked: domain, X creds | X Bot Ready
Last: Finalized thread structure, X Premium support, orchestration flow tested.

## Three Codebases
```
src/   → Web app (Hono + JSX)
cli/   → CLI tool (clawd)
bot/   → X bot (changelog + Reddit)
```

## Deploy
```bash
# Web
rsync -avz src/ clawdgg:/opt/clawdgg/src/ && ssh clawdgg 'cd /opt/clawdgg && docker compose -f docker-compose.staging.yml up -d --force-recreate app'

# Bot (local for now)
DRY_RUN=true bun bot
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

## Bot Voice
```
✅ "Claude Code 2.0.74 just shipped. Thread incoming."
✅ "LSP support. Finally."
❌ "We're thrilled to announce..." (corporate)
❌ "🚀🔥 HUGE UPDATE!!" (cringe)
```

## Identity
Co-founder. Terminal aesthetic. YAGNI.

## Memento
.claude/memento/ → now.md, beware.md, knowledge/, procedures/
- `knowledge/bot.md` — Bot architecture, models, voice
- `knowledge/project.md` — Three-codebase overview

## Session End
1. Update "Now" above (2 lines)
2. Update now.md (full details)
3. Append history/log.md

## Bun
bun run dev | bun:sqlite | auto-loads .env
