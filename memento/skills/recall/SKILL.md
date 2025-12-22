---
name: memento-recall
description: This skill should be used when searching for past memories, when the user asks "what did we decide about", "find memories about", "search notes for", or when looking for information in the brain structure.
version: 1.0.0
---

# /memento recall

Search across all memento files for relevant memories.

## What This Does

Searches the `.claude/memento/` directory for content matching the query.

## Usage

```
/memento recall <query>
```

## Protocol

1. **Get the query**
   - From command argument, or
   - Ask: "What are you looking for?"

2. **Search all memento files**
   ```bash
   grep -r -i "<query>" .claude/memento/
   ```

3. **Display results**
   Group by file, show context:
   ```
   Found {n} matches for "{query}":

   📄 beware.md:
   > {matching line with context}

   📄 knowledge/decisions.md:
   > {matching line with context}

   📄 history/log.md:
   > {matching line with context}
   ```

4. **Offer to load files**
   ```
   Want me to read any of these files in full?
   ```

## Examples

```
User: /memento recall authentication

Found 3 matches for "authentication":

📄 beware.md:
> 🔴 Cookie secure flag issue
> Affects authentication flow...

📄 knowledge/decisions.md:
> ## 2025-12-16: Device Auth Flow
> Chose 8-character codes for CLI authentication...

📄 history/log.md:
> ## 2025-12-18: Fixed OAuth authentication
> Device flow now working...

Want me to read any of these files in full?
```

```
User: /memento recall deploy

Found 5 matches for "deploy":

📄 procedures/deploy.md:
> Full deployment guide...

📄 history/log.md:
> ## 2025-12-22: Deployed to Hetzner VPS
> Fixed 8 deployment issues...

Want me to read procedures/deploy.md?
```

## Future Enhancement (v2)

In v2 with embeddings, this will use semantic search:
- Query gets embedded
- Find k-nearest memories by meaning
- Return semantically similar results, not just text matches

## Notes

- Search is case-insensitive
- Shows line context for relevance
- For full file contents, follow up with Read tool
