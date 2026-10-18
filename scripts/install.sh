#!/bin/sh
# clawd.gg CLI installer.
#
#   curl -fsSL https://clawd.gg/install | sh
#
# Downloads the standalone binary for this OS/arch/libc from GitHub Releases,
# verifies its SHA-256 against a checksum list served by clawd.gg, and installs
# it to ~/.clawdgg/bin/clawdgg. No sudo, nothing written outside your home
# directory, and nothing is run until the checksum matches.
#
# Why the checksums come from clawd.gg and not from the release: so that
# swapping a release asset is not enough. An attacker who takes the GitHub
# release still has to make clawd.gg serve a matching hash, and an attacker who
# takes clawd.gg still has to put a matching binary on GitHub. One without the
# other fails here, loudly.
#
# Everything lives inside main() so that a truncated download of THIS script
# cannot execute a half-read function body — `sh` runs what it has read so far,
# and a partial file ends before `main "$@"` is reached.
#
# Environment:
#   CLAWDGG_VERSION         install a specific release (e.g. 2.0.0); default: latest
#   CLAWDGG_INSTALL_DIR     where the binary goes; default: ~/.clawdgg/bin
#   CLAWDGG_DOWNLOAD_BASE   fetch the binary from here instead of GitHub Releases
#                           (an internal mirror, an airgapped copy). Must be
#                           https unless CLAWDGG_ALLOW_INSECURE_DOWNLOAD=1.
#   CLAWDGG_CHECKSUM_BASE   where the checksum lists live; default clawd.gg
#   CLAWDGG_ALLOW_INSECURE_DOWNLOAD=1
#                           permit a plain-http base. For testing against a
#                           local fixture, never for a real install.

set -eu

REPO="mael-ha/clawdgg"
DEFAULT_CHECKSUM_BASE="https://clawd.gg/install/checksums"

RED=''; GREEN=''; YELLOW=''; CYAN=''; DIM=''; BOLD=''; RESET=''
if [ -t 1 ]; then
  RED=$(printf '\033[31m'); GREEN=$(printf '\033[32m'); YELLOW=$(printf '\033[33m')
  CYAN=$(printf '\033[36m'); DIM=$(printf '\033[2m'); BOLD=$(printf '\033[1m')
  RESET=$(printf '\033[0m')
fi

say()  { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%s⚠%s %s\n' "$YELLOW" "$RESET" "$*"; }
die()  { printf '%s✗%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "\`$1\` is required but not installed."; }

# ── transport ───────────────────────────────────────────────────────────────
#
# TLS is pinned: --proto '=https' refuses to follow a redirect down to plain
# http, which is the one thing that would turn a verified download into an
# unverified one midway. An explicitly insecure base opts out.
insecure_allowed() { [ "${CLAWDGG_ALLOW_INSECURE_DOWNLOAD:-}" = 1 ]; }

require_https() { # require_https <url> <what>
  case "$1" in
    https://*) return 0 ;;
    *)
      insecure_allowed ||
        die "$2 must be https: $1
    Set CLAWDGG_ALLOW_INSECURE_DOWNLOAD=1 only if you really mean it."
      ;;
  esac
}

fetch() { # fetch <url> <dest>
  if command -v curl >/dev/null 2>&1; then
    if insecure_allowed; then
      curl -fsSL "$1" -o "$2"
    else
      curl --proto '=https' --tlsv1.2 -fsSL "$1" -o "$2"
    fi
  elif insecure_allowed; then
    wget -qO "$2" "$1"
  else
    wget --https-only -qO "$2" "$1"
  fi
}

# ── platform ────────────────────────────────────────────────────────────────
#
# Three axes, all of which produce a binary that does not merely misbehave but
# fails to start: OS, architecture, and — on Linux x64 — libc and AVX2.
is_musl() {
  # Alpine and friends. `ldd --version` prints "musl libc" on stderr and exits
  # non-zero, hence the redirect and the `|| true`.
  if command -v ldd >/dev/null 2>&1; then
    { ldd --version 2>&1 || true; } | grep -qi musl && return 0
  fi
  [ -e /lib/ld-musl-x86_64.so.1 ] && return 0
  [ -e /lib/ld-musl-aarch64.so.1 ] && return 0
  return 1
}

has_avx2() {
  if [ -r /proc/cpuinfo ]; then
    grep -qm1 '\bavx2\b' /proc/cpuinfo && return 0
    return 1
  fi
  if command -v sysctl >/dev/null 2>&1; then
    sysctl -n machdep.cpu.leaf7_features 2>/dev/null | grep -qi avx2 && return 0
  fi
  # Unknown: assume yes. A baseline binary runs everywhere but slower, so the
  # wrong guess here costs performance in one direction and a SIGILL in the
  # other — and we only reach this branch on something exotic.
  return 0
}

detect_target() {
  os=$(uname -s)
  arch=$(uname -m)

  case "$os" in
    Darwin) os_name=darwin ;;
    Linux)  os_name=linux ;;
    *)      die "Unsupported OS: $os. clawdgg ships binaries for macOS and Linux." ;;
  esac

  case "$arch" in
    arm64|aarch64) arch_name=arm64 ;;
    x86_64|amd64)  arch_name=x64 ;;
    *)             die "Unsupported architecture: $arch." ;;
  esac

  suffix=''
  if [ "$os_name" = linux ]; then
    is_musl && suffix="-musl"
    if [ "$arch_name" = x64 ] && ! has_avx2; then
      # Without this the binary dies with "Illegal instruction" and no clue why.
      suffix="$suffix-baseline"
    fi
  fi

  printf '%s-%s%s' "$os_name" "$arch_name" "$suffix"
}

sha256_of() { # sha256_of <file>
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    die "Need \`sha256sum\` or \`shasum\` to verify the download."
  fi
}

# ── version ─────────────────────────────────────────────────────────────────
#
# Resolved from the /releases/latest REDIRECT, not api.github.com: no token
# needed, no rate limit to hit on a shared NAT, no JSON to parse with sed.
resolve_version() {
  if [ -n "${CLAWDGG_VERSION:-}" ]; then
    printf '%s' "${CLAWDGG_VERSION#v}"
    return
  fi

  latest_url="https://github.com/$REPO/releases/latest"
  target=''
  if command -v curl >/dev/null 2>&1; then
    target=$(curl --proto '=https' --tlsv1.2 -fsSLI -o /dev/null -w '%{url_effective}' \
      "$latest_url" 2>/dev/null || true)
  else
    target=$(wget --https-only -q -S --max-redirect=0 -O /dev/null "$latest_url" 2>&1 |
      sed -n 's/^[[:space:]]*Location:[[:space:]]*\([^[:space:]]*\).*/\1/p' | tail -1)
  fi

  tag=$(printf '%s' "$target" | sed -n 's|.*/releases/tag/||p')
  [ -n "$tag" ] ||
    die "Could not determine the latest release. Set CLAWDGG_VERSION=x.y.z and retry."
  printf '%s' "${tag#cli-v}"
}

# ── main ────────────────────────────────────────────────────────────────────
main() {
  command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 ||
    die "Need \`curl\` or \`wget\` to download."
  need uname

  INSTALL_DIR="${CLAWDGG_INSTALL_DIR:-$HOME/.clawdgg/bin}"
  BIN_PATH="$INSTALL_DIR/clawdgg"

  printf '\n%s%sclawd.gg%s %s— installing the CLI%s\n\n' "$BOLD" "$CYAN" "$RESET" "$DIM" "$RESET"

  TARGET=$(detect_target)
  VERSION=$(resolve_version)
  TAG="cli-v$VERSION"
  ASSET="clawdgg-$TARGET"
  BASE="${CLAWDGG_DOWNLOAD_BASE:-https://github.com/$REPO/releases/download/$TAG}"
  CHECKSUM_BASE="${CLAWDGG_CHECKSUM_BASE:-$DEFAULT_CHECKSUM_BASE}"

  require_https "$BASE" "the download base"
  require_https "$CHECKSUM_BASE" "the checksum base"

  say "${DIM}platform:${RESET} $TARGET"
  say "${DIM}version: ${RESET} $VERSION"
  say ""

  # The temp file goes in the INSTALL DIR, not /tmp: `mv` is only atomic within
  # one filesystem, and /tmp is frequently another one.
  mkdir -p "$INSTALL_DIR" || die "Cannot create $INSTALL_DIR"
  TMP_BIN="$INSTALL_DIR/.clawdgg.tmp.$$"
  TMP_SUMS="$INSTALL_DIR/.clawdgg.sums.$$"
  cleanup() { rm -f "$TMP_BIN" "$TMP_SUMS"; }
  trap cleanup EXIT HUP INT TERM

  say "Downloading $ASSET..."
  fetch "$BASE/$ASSET" "$TMP_BIN" ||
    die "Download failed: $BASE/$ASSET
    Does release $TAG have an asset for $TARGET?"

  say "Verifying checksum..."
  fetch "$CHECKSUM_BASE/$VERSION.txt" "$TMP_SUMS" ||
    die "clawd.gg is not serving checksums for $VERSION — refusing to install.
    The release may not be published yet. Try again shortly, or pin
    CLAWDGG_VERSION to a version that is."

  EXPECTED=$(grep -E "[[:space:]]\*?$ASSET\$" "$TMP_SUMS" | cut -d' ' -f1 | head -1)
  [ -n "$EXPECTED" ] || die "No checksum published for $ASSET in $VERSION — refusing to install."

  ACTUAL=$(sha256_of "$TMP_BIN")
  if [ "$EXPECTED" != "$ACTUAL" ]; then
    die "Checksum mismatch — NOT installing.
    expected $EXPECTED
    got      $ACTUAL
    The download does not match what clawd.gg published for $VERSION."
  fi
  ok "SHA-256 matches ($ACTUAL)"

  chmod +x "$TMP_BIN"
  # Last step, and atomic: a failed download never replaces a working binary,
  # and nobody ever sees a half-written one.
  mv -f "$TMP_BIN" "$BIN_PATH"
  ok "Installed to $BIN_PATH"

  # ── PATH ──────────────────────────────────────────────────────────────────
  case ":${PATH}:" in
    *":$INSTALL_DIR:"*) on_path=1 ;;
    *) on_path=0 ;;
  esac

  say ""
  if [ "$on_path" = 1 ]; then
    ok "$INSTALL_DIR is already on your PATH"
    say ""
    say "  Next: ${CYAN}${BOLD}clawdgg setup${RESET}"
  else
    warn "$INSTALL_DIR is not on your PATH yet."
    say ""
    say "  Add it with one of these, then open a new shell:"
    say "    ${DIM}zsh ${RESET} echo 'export PATH=\"\$HOME/.clawdgg/bin:\$PATH\"' >> ~/.zshrc"
    say "    ${DIM}bash${RESET} echo 'export PATH=\"\$HOME/.clawdgg/bin:\$PATH\"' >> ~/.bashrc"
    say "    ${DIM}fish${RESET} fish_add_path \$HOME/.clawdgg/bin"
    say ""
    say "  Or run it by path right now:"
    say "    ${CYAN}${BOLD}$BIN_PATH setup${RESET}"
  fi
  say ""
  say "${DIM}The settings.json hooks clawdgg writes use the absolute path above, so${RESET}"
  say "${DIM}they keep working whether or not PATH is set.${RESET}"
  say ""
}

main "$@"
