---
name: memento-beware
description: This skill should be used when discovering a bug that might recur, when the user says "remember this gotcha", "add warning", "don't forget this bug", or when something has bitten us that we shouldn't repeat.
version: 1.0.0
---

# /memento beware

Add a warning to the gotcha checklist.

## What This Does

Adds an entry to `beware.md` - the file read every session to prevent repeat mistakes.

## Usage

```
/memento beware <gotcha>
```

## Protocol

1. **Gather warning details**
   - Title: What's the issue called?
   - Problem: What goes wrong?
   - Solution: How to fix/avoid?
   - Files: Which files are affected?
   - Severity: 🔴 Critical / 🟡 Caution / 🟢 Reminder

2. **Append to beware.md**
   Under the appropriate severity section:
   ```markdown
   ### {Title}
   **Problem:** {what goes wrong}
   **Solution:** {how to fix/avoid}
   **Files:** {relevant files}
   **Last occurred:** {today's date}
   ```

3. **Confirm**
   ```
   ⚠️ Added to beware.md

   {severity emoji} {title}
   This will be shown at every /memento wake.
   ```

## Examples

```
User: /memento beware Cookie secure flag issue

Claude: Let me add this warning. Tell me:
- What goes wrong?
> Cookies with secure:true don't work on HTTP
- How to fix/avoid?
> Use APP_URL.startsWith('https://') not NODE_ENV
- Which files?
> src/lib/session.ts, src/routes/auth.ts
- Severity?
> Critical (it's bitten us 3 times)

⚠️ Added to beware.md

🔴 Cookie secure flag issue
This will be shown at every /memento wake.
```

## When to Use

- **After fixing a tricky bug** — So it doesn't recur
- **After deployment issues** — Environment gotchas
- **After security fixes** — Critical patterns to remember
- **After wasted debugging time** — Lessons learned

## Notes

- Reserve 🔴 Critical for things that have actually caused problems
- Be specific about the solution
- Include file paths for easy reference
