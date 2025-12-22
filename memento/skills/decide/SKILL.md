---
name: memento-decide
description: This skill should be used when making an important decision, when the user says "record this decision", "ADR", "why did we choose", or when documenting architectural or design choices for future reference.
version: 1.0.0
---

# /memento decide

Record a decision with rationale (ADR - Architecture Decision Record).

## What This Does

Adds an entry to `knowledge/decisions.md` documenting what was decided and why.

## Usage

```
/memento decide <decision>
```

## Protocol

1. **Gather decision details**
   - Title: What was decided?
   - Context: What situation prompted this?
   - Decision: What did we choose?
   - Alternatives: What else was considered?
   - Rationale: Why this choice?

2. **Append to decisions.md**
   ```markdown
   ## {YYYY-MM-DD}: {Decision Title}

   **Context:** {situation}

   **Decision:** {what we chose}

   **Alternatives Considered:**
   - {Option A} — {why not}
   - {Option B} — {why not}

   **Rationale:** {why this choice}

   ---
   ```

3. **Confirm**
   ```
   📝 Decision recorded in knowledge/decisions.md

   {title}
   ```

## Examples

```
User: /memento decide We're using HTMX instead of React

Claude: Let me record this decision.
- What prompted this decision?
> Need to build leaderboard UI, choosing frontend approach
- What alternatives were considered?
> React + shadcn - familiar, good components
> Vanilla JS - simple but limited
- Why HTMX?
> Terminal aesthetic is our brand, HTMX fits better
> Simpler for server-rendered pages
> Can migrate to React later if needed
> YAGNI - prove product first

📝 Decision recorded in knowledge/decisions.md

2025-12-22: HTMX over React for Frontend
```

## When to Use

- **Architectural choices** — Stack, patterns, libraries
- **Design decisions** — UI/UX approaches
- **Trade-off resolutions** — When weighing options
- **Future reference** — "Why did we do this?"

## Notes

- Focus on the "why", not just the "what"
- Include alternatives even if obvious
- Future you will thank present you
