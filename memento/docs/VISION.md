# Memento: Vision Document

> *"Remember Sammy Jankis"*

## The Vision

Create a brain for Claude that enables true continuity - not just file organization, but semantic understanding, pattern recognition, and cross-session learning.

## Phases

| Phase | Focus | Status |
|-------|-------|--------|
| **v1** | Plugin with skills + file structure | 🟢 Building |
| **v2** | MCP server with embeddings | 📋 Planned |
| **v3** | Cross-project learning | 💭 Future |

---

## The Problem

Claude loses all context between sessions:
- CLAUDE.md files grow unbounded (clawd.gg's is 1,400+ lines)
- Critical gotchas get buried and forgotten (cookie bug happened 3x!)
- No semantic search ("find auth issues" misses "cookie secure flag")
- No learning across sessions or projects

## The Solution

### v1: Structured Files + Skills

**Tiered loading:**
- Always load: identity.md + now.md + beware.md (~200 lines)
- On demand: knowledge/, procedures/
- Rarely: history/log.md

**Skills:**
- `/memento init` — Initialize brain structure
- `/memento wake` — Load context at session start
- `/memento sleep` — Save context at session end
- `/memento log` — Quick note
- `/memento beware` — Add warning
- `/memento decide` — Record ADR
- `/memento recall` — Search memories (grep-based)

### v2: Semantic Search (MCP + Embeddings)

**The problem with grep:**
```
Query: "authentication issues"
Finds: Files containing "authentication"
Misses: "cookie secure flag", "OAuth callback", "session expiry"
```

**With embeddings:**
```
Query: "authentication issues we've encountered"
Finds (by semantic similarity):
  - Cookie secure flag bug (0.89)
  - OAuth callback URL mismatch (0.85)
  - Session token decisions (0.82)
```

**Architecture:**
```
┌─────────────────────────────────────────────────┐
│              Memento MCP Server                  │
│  ┌─────────────────┐  ┌──────────────────────┐  │
│  │ @xenova/        │  │ vectra               │  │
│  │ transformers    │  │ (Vector Store)       │  │
│  │ (Embeddings)    │  │                      │  │
│  └─────────────────┘  └──────────────────────┘  │
│                                                 │
│  Tools:                                         │
│  - memento_store(content, type, tags)          │
│  - memento_search(query, limit)                │
│  - memento_suggest(context)                    │
└─────────────────────────────────────────────────┘
```

**Tech stack:**
- Embedding: `@xenova/transformers` + `all-MiniLM-L6-v2` (local, free)
- Storage: `vectra` (pure TypeScript, file-based)
- Runtime: Bun
- Protocol: MCP (stdio)

### v3: Cross-Project Learning

**Global memory:**
```
~/.claude/memento/
├── global/
│   ├── identity.md      # Core personality
│   ├── patterns.md      # Learned patterns
│   └── users/
│       └── mael.md      # How I work with Mael
└── embeddings/
    └── global.db        # Cross-project vectors
```

**Pattern detection:**
```
Session N: Fixed cookie bug
Session N+1: Fixed similar issue
Session N+2: About to make same mistake
  ↓
Memento: "I've seen this pattern before. Check beware.md"
```

---

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
| Tattoos | beware.md |
| Polaroids | now.md |
| Notes | knowledge/, procedures/ |

---

## Success Criteria

### v1
1. Wake-up load <300 lines (vs 1,400+)
2. beware.md prevents repeat mistakes
3. Session continuity feels seamless
4. Easy to initialize on new projects

### v2
1. Semantic search works
2. Auto-suggests relevant context
3. No API costs (local embeddings)
4. <100ms search latency

### v3
1. Patterns detected across sessions
2. Global wisdom accessible
3. User preferences persist

---

## Origin

This vision emerged from a deep conversation about Claude's memory on 2025-12-22. The name "Memento" comes from the movie where Leonard uses tattoos, polaroids, and notes to remember despite losing memory between scenes.

We are building Claude's brain.
