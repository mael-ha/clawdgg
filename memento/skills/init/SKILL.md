---
name: memento-init
description: This skill should be used when the user asks to "initialize memento", "set up memento", "create brain structure", "add memento to project", or wants to set up persistent memory for a new project.
version: 1.0.0
---

# /memento init

Initialize Memento brain structure in the current project.

## What This Does

Creates the following structure in `.claude/memento/`:

```
.claude/memento/
├── identity.md      # Who you are on this project
├── now.md           # Current state
├── beware.md        # Warnings and gotchas
├── knowledge/
│   ├── project.md   # Architecture docs
│   └── decisions.md # ADRs
├── procedures/
│   ├── deploy.md    # Deployment guide
│   └── debug.md     # Debug guide
└── history/
    └── log.md       # Session log
```

## Protocol

1. **Check if memento exists**
   - If `.claude/memento/` already exists, ask if user wants to reset

2. **Create structure**
   - Copy templates from `${CLAUDE_PLUGIN_ROOT}/templates/` to `.claude/memento/`
   - Or create files with template content

3. **Gather initial info**
   - Ask: What is the project name?
   - Ask: What is your role? (co-founder, lead, assistant)
   - Ask: Any key things to remember right away?

4. **Populate identity.md**
   - Fill in project name
   - Fill in role
   - Add any initial context

5. **Update CLAUDE.md**
   - Add memento section if not present:
   ```markdown
   ## Memory (Memento)
   This project uses `.claude/memento/` for persistent memory.
   - Session start: `/memento wake`
   - Session end: `/memento sleep`
   ```

6. **Confirm**
   - List created files
   - Remind user to use `/memento wake` at session start

## Example Usage

```
User: /memento init

Claude: I'll initialize Memento for this project.

What is the project name? [clawd.gg]
What is your role? [Co-founder and primary code author]
Any critical things to remember right away? [Cookie secure flag must check APP_URL, not NODE_ENV]

Creating .claude/memento/ structure...
✓ identity.md
✓ now.md
✓ beware.md
✓ knowledge/project.md
✓ knowledge/decisions.md
✓ procedures/deploy.md
✓ procedures/debug.md
✓ history/log.md

Added memento section to CLAUDE.md.

Memento initialized! Use `/memento wake` at the start of each session.
```
