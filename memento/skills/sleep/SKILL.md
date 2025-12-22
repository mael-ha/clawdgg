---
name: memento-sleep
description: This skill should be used at the end of a session, when the user says "save context", "end session", "we're done for now", "save progress", or before ending a conversation.
version: 1.0.0
---

# /memento sleep

Save context at session end. This is the "sleep" protocol.

## What This Does

Updates memento files to preserve context for next session:
1. Updates `now.md` with current state
2. Appends entry to `history/log.md`
3. Updates any other files if needed

## Protocol

1. **Check if memento exists**
   - If `.claude/memento/` doesn't exist, suggest `/memento init`

2. **Gather session info**
   - What did we accomplish this session?
   - What was the outcome?
   - What's the immediate next priority?
   - Any new warnings/gotchas discovered?

3. **Update now.md**
   ```markdown
   # Current State

   ## Status
   {update status section}

   ## Last Session ({current timestamp})
   **Did:** {what we accomplished}
   **Outcome:** {result}
   **Loose ends:** {unfinished items}

   ## Next Priority
   {immediate next thing}
   ```

4. **Append to history/log.md**
   Add at top of file:
   ```markdown
   ## {YYYY-MM-DD HH:MM}

   **Context:** {what user wanted}
   **Did:** {what was accomplished}
   **Outcome:** {result}
   **Next:** {priority}

   ---
   ```

5. **Update beware.md (if new gotchas)**
   If we discovered new warnings, add them.

6. **Confirm**
   ```
   Memory saved for next session.

   Updated:
   ✓ now.md — Current state and last session
   ✓ history/log.md — Session entry appended

   Next priority: {what we set}

   See you next time!
   ```

## When to Use

- **End of every session** — Before user leaves
- **Before long break** — To preserve context
- **After major milestone** — To record achievement

## Example

```
User: /memento sleep

Claude: Let me save the session context.

What did we accomplish?
> Built the Memento plugin with 7 skills and templates

What was the outcome?
> Successful - all files created, ready for testing

What's the next priority?
> Migrate clawd.gg CLAUDE.md to memento structure

Any new gotchas discovered?
> None this session

Updating memento files...

Memory saved for next session.

Updated:
✓ now.md — Current state and last session
✓ history/log.md — Session entry appended

Next priority: Migrate clawd.gg CLAUDE.md to memento structure

See you next time!
```

## Notes

- Keep session entries concise (4-5 lines)
- Focus on OUTCOMES, not play-by-play
- Set a SPECIFIC next priority
