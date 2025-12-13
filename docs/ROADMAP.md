# Roadmap

## Current: MVP (v0.1) ✓

- [x] Database schema (users, daily_stats)
- [x] GitHub OAuth authentication
- [x] Stats submission API
- [x] Leaderboard API (period filters, sorting)
- [x] Web UI (cyberpunk theme, HTMX)
- [x] CLI tool (sync, login, status)
- [x] Rate limiting
- [x] Device flow auth for CLI
- [x] Delta sync (CLI only uploads new days)
- [x] Real leaderboard data (no more mock data)

## Next: v0.2 - Polish ✓

### Completed
- [x] Set proper file permissions on CLI config (chmod 600)
- [x] Add JSON validation for stats file parsing
- [x] Add bearer token expiry (30 days)
- [x] Move device auth store to SQLite
- [x] User profile pages (`/u/:username`) with creative design
  - [x] GitHub-style contribution graph
  - [x] Giant "TOP X%" percentile hero
  - [x] Share button (copy tweet to clipboard)
- [x] Badge system (12 badges implemented)
- [x] CLI celebration moments (new badge, #1, streak record)
- [x] Leaderboard "You are here" pill + row highlighting
- [x] CLI commands: `gg`, `logout`, `--version`

### Still Needed
- [ ] Production deployment setup (VPS)
- [ ] Publish CLI to npm (`npm install -g clawdgg`)
- [ ] Domain purchase (clawd.gg)

### Future Polish
- [ ] Twitter/X authentication
  - [ ] Link X account alongside GitHub
  - [ ] Show X avatar/handle on leaderboard
- [ ] OG meta tags for profile social previews
- [ ] Rank change indicators (↑5 since yesterday)
- [ ] Use system keychain for CLI token storage

## Future: v0.3 - Gamification (Partially Complete)

### Done
- [x] Achievement badges (12 implemented):
  - Night Owl, Early Bird, On Fire, Streak 7/30
  - Messages 1k/5k/10k, Tools 1k/5k, Marathon, OG
- [x] Activity streaks (current + longest)
- [x] Streak celebration in CLI

### Future
- [ ] Rank titles (Bronze → Diamond)
- [ ] Weekly challenges
- [ ] "Beat X to reach #Y" gamification

## Future: v0.4 - Community

- [ ] Team/org leaderboards
- [ ] Following users
- [ ] Activity feed
- [ ] Comments/reactions

## Future: v1.0 - MCP Integration

- [ ] MCP server for Claude Code
- [ ] Auto-sync daily (opt-in)
- [ ] Real-time stats updates
- [ ] Claude Code hook integration

## Infrastructure

### Deployment
- [ ] VPS setup (DigitalOcean/Hetzner)
- [ ] Domain configuration (clawd.gg)
- [ ] SSL certificate (Let's Encrypt)
- [ ] Nginx reverse proxy
- [ ] Systemd service
- [ ] SQLite backup to S3

### Monitoring
- [ ] Error tracking (Sentry)
- [ ] Uptime monitoring
- [ ] Analytics (privacy-respecting)

## Known Issues

From Opus code review (2025-12-13):

1. **Session Management**: No server-side session storage means can't revoke sessions
2. ~~**CLI Token Storage**: Stored in plaintext at `~/.clawdgg/config.json`~~ ✅ Fixed (chmod 600)
3. **Missing Validation**: GitHub API response and session data not schema-validated
4. ~~**Device Flow**: CLI references `/api/auth/device` endpoints that don't exist yet~~ ✅ Fixed
5. ~~**Token Expiry**: Bearer tokens never expire (permanent access if compromised)~~ ✅ Fixed (30-day expiry)
6. ~~**Device Auth Store**: In-memory Map lost on server restart (login fails mid-flow)~~ ✅ Fixed (SQLite)
7. ~~**CLI JSON Parsing**: No validation of stats file structure~~ ✅ Fixed (validateStats function)

## Security Considerations

### Current Architecture (MVP)

**Token Format**: HMAC-SHA256 signed JSON payload
```
{ userId: "github_12345", iat: 1702425600 } + signature
```

**Why not JWT?** Similar security, simpler implementation. JWT would add built-in expiry but marginal benefit for MVP.

**Why custom device flow?** GitHub's built-in device flow gives us a GitHub token, which we'd need to exchange anyway. Our implementation is simpler and gives us direct control.

**Why not localhost callback?** Device flow works over SSH, avoids port conflicts and firewall issues. Same UX as GitHub CLI, Vercel CLI.

### Trade-offs Made

| Decision | Trade-off | Mitigation |
|----------|-----------|------------|
| Stateless tokens | Can't revoke | Add expiry (planned) |
| In-memory device store | Lost on restart | Move to SQLite (planned) |
| Plaintext CLI config | Readable by local processes | Use keychain (planned) |
| No refresh tokens | Must re-login on expiry | Implement refresh flow (planned) |

## Ideas Parking Lot

- Browser extension for auto-sync
- Discord bot integration
- Slack app
- GitHub Action for CI stats
- VS Code extension
- Terminal dashboard widget
