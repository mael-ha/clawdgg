#!/usr/bin/env bash
# Ship the web app to clawdgg:/opt/clawdgg and build the image there.
#
#   scripts/deploy.sh --dry-run    # show exactly what would change
#   scripts/deploy.sh              # sync, then `docker compose build app`
#
# It BUILDS ONLY. Nothing restarts, nothing swaps: the runbook
# (.claude/memento/procedures/deploy.md) decides when to `up -d`, because that
# is the step with the downtime and the rollback.
#
# What it syncs is exactly what the Dockerfile copies into the image, and
# nothing else — the point of listing the paths instead of sending the whole
# tree is that `.env`, `data/*.db`, `dist/` (60MB+ of compiled binaries) and
# every local experiment stay here. src/ syncs with --delete so a file deleted
# locally stops existing on the server; a stale route left behind on the server
# is a bug that cannot be reproduced anywhere else.
#
# docker-compose.staging.yml is NOT synced. It lives only on the server,
# because it carries the production environment.

set -euo pipefail

HOST="${CLAWDGG_DEPLOY_HOST:-clawdgg}"
REMOTE_DIR="${CLAWDGG_DEPLOY_DIR:-/opt/clawdgg}"
COMPOSE_FILE="docker-compose.staging.yml"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) DRY_RUN=1 ;;
    --help|-h)
      sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown flag: $arg (try --dry-run)" >&2
      exit 1
      ;;
  esac
done

RSYNC_FLAGS=(-avz --human-readable)
if [ "$DRY_RUN" = 1 ]; then
  RSYNC_FLAGS+=(--dry-run --itemize-changes)
  echo "DRY RUN — nothing is written to $HOST and no image is built."
  echo
fi

say() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }

# Directories. src/ is the only one with --delete: it is wholly ours, and a
# file removed locally must not survive on the server.
say "src/ → $HOST:$REMOTE_DIR/src/   (with --delete)"
rsync "${RSYNC_FLAGS[@]}" --delete \
  --exclude '*.test.ts' \
  src/ "$HOST:$REMOTE_DIR/src/"

say "scripts/ → $HOST:$REMOTE_DIR/scripts/"
# install.sh is served by GET /install, so this is a user-visible path.
rsync "${RSYNC_FLAGS[@]}" --delete scripts/ "$HOST:$REMOTE_DIR/scripts/"

say "cli/ → $HOST:$REMOTE_DIR/cli/"
# cli/checksums/ is what GET /install/checksums/<version> serves; without it a
# fresh release is uninstallable, which is the intended failure but not a
# pleasant one to discover after announcing it.
rsync "${RSYNC_FLAGS[@]}" --delete \
  --exclude 'dist' \
  --exclude 'node_modules' \
  --exclude '*.test.ts' \
  cli/ "$HOST:$REMOTE_DIR/cli/"

say "drizzle/ → $HOST:$REMOTE_DIR/drizzle/"
rsync "${RSYNC_FLAGS[@]}" drizzle/ "$HOST:$REMOTE_DIR/drizzle/"

say "docker/ → $HOST:$REMOTE_DIR/docker/"
# ClickHouse init + migrations. No --delete: an applied migration file is a
# record of what the database has had done to it.
rsync "${RSYNC_FLAGS[@]}" --exclude '*.test.ts' docker/ "$HOST:$REMOTE_DIR/docker/"

say "public/ → $HOST:$REMOTE_DIR/public/   (sources only)"
# public/build is produced inside the image by `bun run build`. Sending the
# host's copy would shadow it with assets built against a different source.
mkdir -p public
rsync "${RSYNC_FLAGS[@]}" --exclude 'build' public/ "$HOST:$REMOTE_DIR/public/"

say "root files → $HOST:$REMOTE_DIR/"
rsync "${RSYNC_FLAGS[@]}" \
  package.json \
  bun.lock \
  tsconfig.json \
  drizzle.config.ts \
  Dockerfile \
  .dockerignore \
  "$HOST:$REMOTE_DIR/"

if [ "$DRY_RUN" = 1 ]; then
  say "Would then run, on $HOST:"
  echo "    cd $REMOTE_DIR && docker compose -f $COMPOSE_FILE build app"
  echo
  echo "Nothing was changed."
  exit 0
fi

say "Building the image on $HOST (build only — nothing restarts)"
ssh "$HOST" "cd $REMOTE_DIR && docker compose -f $COMPOSE_FILE build app"

cat <<EOF

$(printf '\033[1;32m✓\033[0m') Image built on $HOST. NOTHING IS LIVE YET.

  Roll it out when you're ready:
    ssh $HOST 'cd $REMOTE_DIR && docker compose -f $COMPOSE_FILE up -d app'

  Then check it:
    curl -fsS https://clawd.gg/health
    curl -fsSL https://clawd.gg/install | head -5

  .claude/memento/procedures/deploy.md has the rollback.
EOF
