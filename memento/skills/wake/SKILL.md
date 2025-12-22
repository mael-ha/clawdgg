---
name: memento-wake
description: This skill should be used at the start of a session, when the user says "wake up", "load context", "what's the status", "where did we leave off", or when Claude needs to restore context after /clear.
version: 1.0.0
---

# /memento wake

Load context at session start. This is the "wake up" protocol.

## What This Does

Reads the essential memento files to restore context:
1. `identity.md` — Who I am on this project
2. `now.md` — Current state and last session
3. `beware.md` — Critical warnings
4. Git status — Recent changes

## Protocol

1. **Check if memento exists**
   - If `.claude/memento/` doesn't exist, suggest `/memento init`

2. **Read Tier 0: Identity**
   ```bash
   Read .claude/memento/identity.md
   ```
   Extract: role, voice, preferences, working dynamic

3. **Read Tier 1: Now**
   ```bash
   Read .claude/memento/now.md
   ```
   Extract: status, last session, next priority

4. **Read Tier 1: Beware**
   ```bash
   Read .claude/memento/beware.md
   ```
   Count warnings, note critical ones

5. **Check Git**
   ```bash
   git status
   git log --oneline -5
   ```

6. **Output Summary**
   ```
   ═══════════════════════════════════════════════
    MEMENTO: {project_name}
   ═══════════════════════════════════════════════

   IDENTITY: {role}

   STATUS:
   🟢 Live: {what's working}
   🟡 In Progress: {active work}
   🔴 Blocked: {blockers}

   LAST SESSION: {date}
   {summary of what was done}

   ⚠️ WARNINGS: {count} active
   - {critical warning 1}
   - {critical warning 2}

   RECENT GIT:
   {git log output}

   NEXT PRIORITY: {from now.md}
   ═══════════════════════════════════════════════
   ```

## When to Use

- **Start of every session** — First thing you do
- **After /clear** — To restore context
- **When confused** — To re-orient

## Example

```
User: /memento wake

═══════════════════════════════════════════════
 MEMENTO: clawd.gg
═══════════════════════════════════════════════

IDENTITY: Co-founder and primary code author

STATUS:
🟢 Live: http://46.224.85.32:3000 (app + ClickHouse)
🟡 In Progress: Memory system (Memento plugin)
🔴 Blocked: Domain not purchased

LAST SESSION: 2025-12-22 14:30
Built Memento plugin structure, created skills and templates.

⚠️ WARNINGS: 1 critical
- Cookie secure flag: Use APP_URL.startsWith('https://'), NOT NODE_ENV

RECENT GIT:
a1b2c3d Add memento plugin structure
e4f5g6h Fix cookie secure flag bug
...

NEXT PRIORITY: Test memento with clawd.gg migration
═══════════════════════════════════════════════
```
