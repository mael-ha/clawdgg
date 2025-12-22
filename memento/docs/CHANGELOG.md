# Changelog

All notable changes to Memento.

---

## [1.0.0] - 2025-12-22

### Added

- Initial plugin structure
- Plugin manifest (`.claude-plugin/plugin.json`)
- README with full documentation

**Templates:**
- `identity.md` - Role, voice, preferences
- `now.md` - Current state, last session
- `beware.md` - Warnings and gotchas
- `knowledge/project.md` - Architecture docs
- `knowledge/decisions.md` - ADR format
- `procedures/deploy.md` - Deployment guide
- `procedures/debug.md` - Debug guide
- `history/log.md` - Session log

**Skills:**
- `/memento init` - Initialize brain structure
- `/memento wake` - Load context at session start
- `/memento sleep` - Save context at session end
- `/memento log` - Quick append to log
- `/memento beware` - Add warning
- `/memento decide` - Record decision
- `/memento recall` - Search memories

**Documentation:**
- VISION.md - Full vision including v2/v3 plans
- CHANGELOG.md - This file

### Origin

Built during a conversation about Claude's memory on 2025-12-22. The insight: Claude needs a structured brain, not just a giant CLAUDE.md file. Inspired by the movie Memento and neuroscience.
