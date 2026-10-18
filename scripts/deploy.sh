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
# docker-compose.staging.yml and the Caddyfile ARE synced, and they are the two
# files here that can take the site down, so they are shown item by item on
# every run. The compose file carries no values — every secret in it is a
# ${NAME} that compose reads from /opt/clawdgg/.env, which is not in this repo
# and is never touched from here.
#
# docker-compose.yml is NOT synced: it is the LOCAL full stack, and a copy of
# it on the server is an invitation to run the wrong file in the right
# directory.
#
# Run it with --dry-run first. It is the only way to see whether the server's
# compose file or Caddyfile have drifted from the repo's before you overwrite
# them.

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
      sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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

# The two that decide whether the site answers. Always itemized, dry run or
# not: an unexpected line here means the server's copy was edited by hand and
# this run is about to discard that edit.
say "the live compose file and Caddyfile → $HOST:$REMOTE_DIR/   (itemized)"
echo "    a line below means the server's copy differs from this repo's."
rsync "${RSYNC_FLAGS[@]}" --itemize-changes \
  "$COMPOSE_FILE" \
  Caddyfile \
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

  NEVER add --remove-orphans to any compose command in $REMOTE_DIR. Until the
  server's own docker-compose.yml is retired (see below), Caddy is defined in
  a file this one does not know about, and --remove-orphans deletes it.

  .claude/memento/procedures/deploy.md has the rollback.
EOF

# ---------------------------------------------------------------------------
# ONE-TIME: bring Caddy under the production compose file.
#
# Caddy is defined in the SERVER's own docker-compose.yml, while everything it
# proxies is in docker-compose.staging.yml. Both files are in /opt/clawdgg, so
# both resolve to the same compose project (`clawdgg`, after the directory) and
# the same container names — which is the whole reason this adoption works at
# all, and the reason the staging file must never grow a `name:` or a
# `container_name:`.
# ---------------------------------------------------------------------------
if [ "${SHOW_SWITCHOVER:-1}" = 1 ]; then
cat <<EOF

$(printf '\033[1;33m!\033[0m') ONE-TIME SWITCH-OVER — Caddy moves into $COMPOSE_FILE.
  Do this once, by hand, reading each answer before the next command.

  0. Pre-flight, read-only. Confirm the names Caddy's certificates live under:
       ssh $HOST 'cd $REMOTE_DIR && docker compose -f $COMPOSE_FILE config -q && echo PARSES'
       ssh $HOST 'docker ps --format "{{.Names}}\t{{.Image}}\t{{.Ports}}"'
       ssh $HOST 'docker volume ls | grep clawdgg'
     Expect a container named clawdgg-caddy-1 and volumes clawdgg_caddy_data
     and clawdgg_caddy_config. Different names mean STOP: adopting would start
     a second Caddy with an empty /data, which orders a new certificate.

  1. Back both files up on the server, BEFORE any sync overwrites them:
       ssh $HOST 'cd $REMOTE_DIR && cp -n docker-compose.staging.yml docker-compose.staging.yml.bak && cp -n docker-compose.yml docker-compose.yml.bak'

  2. Check whether the Caddyfile about to be synced is the one running:
       ssh $HOST 'cat $REMOTE_DIR/Caddyfile' | diff - Caddyfile && echo IDENTICAL
     A diff is not a reason to stop, but it is a reason to read it: this file
     is what terminates TLS for clawd.gg.

  3. Sync and build (this script, no flags), then adopt Caddy:
       ssh $HOST 'cd $REMOTE_DIR && docker compose -f $COMPOSE_FILE up -d caddy'
     Compose finds service \`caddy\` already running in project clawdgg. It
     either reports it up to date or recreates it in place — either way there
     is ONE container, keeping its name and its two volumes, so the
     certificate is not reissued. A few seconds of refused connections if it
     recreates.

  4. Verify before retiring anything:
       curl -fsS https://clawd.gg/health
       curl -sI http://clawd.gg | head -1          # redirect to https
       ssh $HOST 'docker ps --format "{{.Names}}\t{{.Ports}}" | sort'
     Exactly one caddy container. The app published on 127.0.0.1:3000 only —
     if 0.0.0.0:3000 is still there, the app did not get recreated yet.

  5. Only now retire the server's own compose file, so nobody runs it again:
       ssh $HOST 'cd $REMOTE_DIR && mv docker-compose.yml docker-compose.yml.retired'
     After this, --remove-orphans is no longer a loaded gun, because every
     service lives in one file.

  ROLLBACK (at any point, Caddy's data volume is untouched throughout):
       ssh $HOST 'cd $REMOTE_DIR && cp docker-compose.staging.yml.bak docker-compose.staging.yml'
       ssh $HOST 'cd $REMOTE_DIR && [ -f docker-compose.yml ] || mv docker-compose.yml.retired docker-compose.yml'
       ssh $HOST 'cd $REMOTE_DIR && docker compose -f docker-compose.yml up -d caddy'
       ssh $HOST 'cd $REMOTE_DIR && docker compose -f docker-compose.staging.yml up -d app'

  Set SHOW_SWITCHOVER=0 to stop printing this once it is done.
EOF
fi
