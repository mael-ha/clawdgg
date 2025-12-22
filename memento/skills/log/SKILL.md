---
name: memento-log
description: This skill should be used when the user says "log this", "note this", "remember this", "add to log", or wants to quickly record something for future reference.
version: 1.0.0
---

# /memento log

Quick append a note to the session log.

## What This Does

Appends a timestamped entry to `history/log.md` without the full sleep protocol.

## Usage

```
/memento log <note>
```

## Protocol

1. **Get the note**
   - From command argument, or
   - Ask: "What would you like to log?"

2. **Append to history/log.md**
   ```markdown
   ## {YYYY-MM-DD HH:MM}

   {note}

   ---
   ```

3. **Confirm**
   ```
   ✓ Logged to history/log.md
   ```

## Examples

```
User: /memento log Fixed the OAuth callback URL - must be /auth/callback not /auth/github/callback

✓ Logged to history/log.md
```

```
User: /memento log
Claude: What would you like to log?
User: Discovered that stats-cache.json undercounts by 50% - agent sessions excluded
Claude: ✓ Logged to history/log.md
```

## Notes

- Keep notes concise (1-3 sentences)
- Use for quick capture, not full session summaries
- For end-of-session, use `/memento sleep` instead
