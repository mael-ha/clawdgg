# Deployment Procedures

## VPS Details

| Property | Value |
|----------|-------|
| Provider | Hetzner |
| Plan | CX23 (~$3.59/mo) |
| IP | 46.224.85.32 |
| SSH Alias | `clawdgg` |
| OS | Ubuntu 24.04 LTS |
| Location | Germany |

## SSH Access

```bash
# Connect
ssh clawdgg

# SSH config (~/.ssh/config)
Host clawdgg
   HostName 46.224.85.32
   User root
   IdentityFile ~/.ssh/id_ed25519_hetzner_maelus
```

## Docker Commands

```bash
# View containers
ssh clawdgg 'docker ps'

# View logs
ssh clawdgg 'docker logs clawdgg-app-1 -f'

# Restart
ssh clawdgg 'cd /opt/clawdgg && docker compose -f docker-compose.staging.yml restart'

# Full rebuild
ssh clawdgg 'cd /opt/clawdgg && docker compose -f docker-compose.staging.yml down && docker compose -f docker-compose.staging.yml up -d --build'
```

## Deploy Code Changes

```bash
# Sync source files
rsync -avz --exclude node_modules --exclude .git --exclude data --exclude '*.db' /Users/maelh/code/mael-ha/nomadz/clawdgg/ clawdgg:/opt/clawdgg/

# Quick rebuild (src only)
rsync -avz /Users/maelh/code/mael-ha/nomadz/clawdgg/src/ clawdgg:/opt/clawdgg/src/
ssh clawdgg 'cd /opt/clawdgg && docker compose -f docker-compose.staging.yml build app && docker compose -f docker-compose.staging.yml up -d'
```

## Database Migrations

drizzle-kit doesn't work in container (native module). Use script:

```bash
ssh clawdgg 'docker cp /opt/clawdgg/run-migrations.ts clawdgg-app-1:/app/ && docker exec clawdgg-app-1 bun /app/run-migrations.ts'
```

## GitHub OAuth Settings

| Setting | Current Value |
|---------|---------------|
| Homepage URL | http://46.224.85.32:3000 |
| Callback URL | http://46.224.85.32:3000/auth/callback |
| Client ID | Ov23liC2rBz1Fq3cUbJu |

**When domain ready:** Update callback to `https://clawd.gg/auth/callback`

## Enable HTTPS (When Domain Ready)

1. Purchase `clawd.gg` domain
2. Point DNS A record → `46.224.85.32`
3. Wait for propagation (~5-30 min)
4. Update GitHub OAuth callback → `https://clawd.gg/auth/callback`
5. Update `.env` APP_URL → `https://clawd.gg`
6. Switch compose file:
   ```bash
   ssh clawdgg 'cd /opt/clawdgg && docker compose -f docker-compose.yml up -d --build'
   ```

Caddy auto-provisions Let's Encrypt certs.

## Troubleshooting

### App not starting
```bash
ssh clawdgg 'docker logs clawdgg-app-1 --tail 100'
```

### ClickHouse issues
```bash
ssh clawdgg 'docker logs clawdgg-clickhouse-1 --tail 100'
```

### Health check
```bash
curl http://46.224.85.32:3000/health
```

### Port conflicts
```bash
ssh clawdgg 'lsof -i :3000'
```
