# clawd.gg

**Live:** https://clawd.gg | **Server:** clawdgg (46.224.85.32)

## Now (sync with now.md at session end)
Telemetry restored after 2026-01-23 → 05-06 blackout (30-day token cliff). Tokens now never-expire with `token_gen` revocation; `clawdgg doctor` exits.
Last: Bearer-token fix + JSONL backfill (~$6.6k cost, ~4.7k prompts recovered).

## Three Codebases
```
src/   → Web app (Hono + JSX)
cli/   → CLI tool (clawdgg)
bot/   → X bot (changelog + Reddit)
```

## Deploy
```bash
# Web (MUST use --build to rebuild image)
rsync -avz src/ clawdgg:/opt/clawdgg/src/ && ssh clawdgg 'cd /opt/clawdgg && docker compose -f docker-compose.staging.yml up -d --build app'

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
```sql
-- Revoke a leaked CLI bearer token (forces re-login on next clawdgg use)
UPDATE users SET token_gen = token_gen + 1 WHERE id = 'github_<id>';
```
```bash
# Roll back the prod app to the pre-token-fix image (image was tagged 2026-05-06)
ssh clawdgg 'cd /opt/clawdgg && docker compose -f docker-compose.staging.yml stop app \
  && docker tag clawdgg-app:pre-token-fix-2026-05-06 clawdgg-app:latest \
  && docker compose -f docker-compose.staging.yml up -d app'
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

## Data Integrity
Data integrity is non-negotiable. Users trust us with their usage data - any inconsistency erodes that trust. Every number displayed must be:
- **Accurate** — Matches what's stored, no rounding surprises
- **Consistent** — Same metric = same number everywhere
- **Traceable** — Can trace display → query → storage → ingestion

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
