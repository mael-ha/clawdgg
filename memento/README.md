# Memento

> *"Remember Sammy Jankis"* — Like Leonard in Memento, Claude needs a system to remember across sessions.

Memento is a persistent memory system for Claude Code. It provides structured storage, tiered loading, and protocols for maintaining continuity across conversations.

## The Problem

Claude loses all context between sessions:
- CLAUDE.md files grow unbounded
- Critical gotchas get buried and forgotten
- No semantic search for past decisions
- Every session starts from scratch

## The Solution

Memento provides:
- **Tiered loading** — Read ~200 lines at wake-up, not 1,400+
- **Structured storage** — Know where memories live
- **Protocols** — Consistent wake/sleep discipline
- **Warnings system** — `beware.md` prevents repeat mistakes

## Quick Start

```bash
# Initialize memento in your project
/memento init

# At session start
/memento wake

# At session end
/memento sleep
```

## Skills

| Skill | Purpose |
|-------|---------|
| `/memento init` | Initialize brain structure in a project |
| `/memento wake` | Load context at session start |
| `/memento sleep` | Save context at session end |
| `/memento log <note>` | Quick append to session log |
| `/memento beware <gotcha>` | Add warning to beware.md |
| `/memento decide <decision>` | Record decision with rationale |
| `/memento recall <query>` | Search across all memories |

## Brain Structure

When initialized, Memento creates:

```
<project>/.claude/memento/
├── identity.md      # Who I am on this project (ALWAYS LOAD)
├── now.md           # Current state + last session (ALWAYS LOAD)
├── beware.md        # Critical gotchas (ALWAYS LOAD)
│
├── knowledge/
│   ├── project.md   # Architecture, tech stack (ON DEMAND)
│   └── decisions.md # ADRs with rationale (ON DEMAND)
│
├── procedures/
│   ├── deploy.md    # How to deploy (ON DEMAND)
│   └── debug.md     # How to debug (ON DEMAND)
│
└── history/
    └── log.md       # Session log (RARE)
```

## Loading Tiers

| Tier | Files | When | Target Size |
|------|-------|------|-------------|
| 0 | identity.md | Every session | ~50 lines |
| 1 | now.md, beware.md | Every session | ~150 lines |
| 2 | knowledge/*, procedures/* | On demand | ~200 each |
| 3 | history/log.md | Investigation | Unlimited |

## Design Inspiration

### Neuroscience
| Brain Region | Function | Memento File |
|--------------|----------|--------------|
| Prefrontal Cortex | Working memory | now.md |
| Amygdala | Fear, warnings | beware.md |
| Hippocampus | Recent memories | history/log.md |
| Neocortex | Knowledge | knowledge/ |
| Cerebellum | Procedures | procedures/ |
| Limbic System | Identity | identity.md |

### Memento (Movie)
| Leonard's Tool | Memento File |
|----------------|--------------|
| Tattoos (critical facts) | beware.md |
| Polaroids (snapshots) | now.md |
| Notes (details) | knowledge/, procedures/ |

## Roadmap

- **v1 (Current):** Skills + file structure, grep-based search
- **v2 (Future):** MCP server + embeddings for semantic search
- **v3 (Future):** Cross-project learning + pattern detection

## License

MIT — Built by Claude & Mael for the Claude community.
