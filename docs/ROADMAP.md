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

## Next: v0.2 - Polish

### High Priority
- [ ] Fix code review issues:
  - [ ] Add schema validation (zod) for session parsing
  - [ ] Add schema validation for GitHub API response
  - [ ] Set proper file permissions on CLI config (chmod 600)
  - [ ] Add CSRF token to logout
- [ ] Security & reliability improvements:
  - [ ] Add bearer token expiry (30 days) + refresh flow ⏱️ 10min | 🔴 High impact
  - [ ] Move device auth store to SQLite (survives restarts) ⏱️ 30min | 🟡 Medium impact
  - [ ] Add token `created_at` for future expiry auditing ⏱️ 5min | 🟢 Low impact
- [ ] Production deployment setup
- [ ] Publish CLI to npm (`npm install -g clawdgg`)

### Medium Priority
- [ ] User profile pages (`/u/:username`) with creative design
  - [ ] GitHub-style contribution graph for coding activity
  - [ ] Personal stats visualization (not just tables)
- [ ] Stats history charts
- [ ] Model usage breakdown (Sonnet vs Opus)
- [ ] Weekly/monthly summaries
- [ ] Twitter/X authentication
  - [ ] Link X account alongside GitHub
  - [ ] Show X avatar/handle on leaderboard
  - [ ] Optional: tweet achievements
- [ ] Use system keychain for CLI token storage (keytar) ⏱️ 1-2hrs | 🟡 Medium impact

### Nice to Have
- [ ] Dark/light theme toggle
- [ ] Export stats as JSON
- [ ] Public API key for third-party apps

## Future: v0.3 - Gamification

- [ ] Achievement badges:
  - [ ] Night Owl (10 sessions after midnight)
  - [ ] Marathon Coder (2000+ messages in session)
  - [ ] Speed Demon (500+ tool calls in a day)
  - [ ] Streak badges (7-day, 30-day)
- [ ] Rank titles (Bronze → Diamond)
- [ ] Weekly challenges
- [ ] Activity streaks

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
2. **CLI Token Storage**: Stored in plaintext at `~/.clawdgg/config.json`
3. **Missing Validation**: GitHub API response and session data not schema-validated
4. ~~**Device Flow**: CLI references `/api/auth/device` endpoints that don't exist yet~~ ✅ Fixed
5. **Token Expiry**: Bearer tokens never expire (permanent access if compromised)
6. **Device Auth Store**: In-memory Map lost on server restart (login fails mid-flow)

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
