#!/bin/sh
# clawd.gg CLI installer.
#
#   curl -fsSL https://clawd.gg/install | sh
#
# Downloads the standalone binary for this OS/arch from GitHub Releases,
# verifies its SHA-256 against the release's checksums.txt, and installs it to
# ~/.clawdgg/bin/clawdgg. No sudo, nothing written outside your home directory,
# and nothing is run until the checksum matches.
#
# Environment:
#   CLAWDGG_VERSION      install a specific release (e.g. 1.0.0); default: latest
#   CLAWDGG_INSTALL_DIR  where the binary goes; default: ~/.clawdgg/bin
#   CLAWDGG_DOWNLOAD_BASE  fetch the binary and checksums.txt from here instead
#                        of GitHub Releases — for an internal mirror, an
#                        airgapped copy, or testing this script. The checksum
#                        comes from the same place as the binary, so only point
#                        this at a host you trust as much as GitHub.

set -eu

REPO="mael-ha/clawdgg"
INSTALL_DIR="${CLAWDGG_INSTALL_DIR:-$HOME/.clawdgg/bin}"
BIN_PATH="$INSTALL_DIR/clawdgg"

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

# ── platform ────────────────────────────────────────────────────────────────
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

  printf '%s-%s' "$os_name" "$arch_name"
}

# ── download helpers ────────────────────────────────────────────────────────
fetch() { # fetch <url> <dest>
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  else
    wget -qO "$2" "$1"
  fi
}

fetch_stdout() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1"
  else
    wget -qO- "$1"
  fi
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

resolve_version() {
  if [ -n "${CLAWDGG_VERSION:-}" ]; then
    printf '%s' "${CLAWDGG_VERSION#v}"
    return
  fi
  # The release tag is cli-v<version>; read it from the redirect target rather
  # than the API, so this works without a token and without jq.
  tag=$(fetch_stdout "https://api.github.com/repos/$REPO/releases/latest" |
        sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
  [ -n "$tag" ] || die "Could not determine the latest release. Set CLAWDGG_VERSION=x.y.z and retry."
  printf '%s' "${tag#cli-v}"
}

# ── install ─────────────────────────────────────────────────────────────────
command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 ||
  die "Need \`curl\` or \`wget\` to download."
need uname
need mktemp

printf '\n%s%sclawd.gg%s %s— installing the CLI%s\n\n' "$BOLD" "$CYAN" "$RESET" "$DIM" "$RESET"

TARGET=$(detect_target)
VERSION=$(resolve_version)
TAG="cli-v$VERSION"
ASSET="clawdgg-$TARGET"
BASE="${CLAWDGG_DOWNLOAD_BASE:-https://github.com/$REPO/releases/download/$TAG}"

say "${DIM}platform:${RESET} $TARGET"
say "${DIM}version: ${RESET} $VERSION"
say ""

TMP_DIR=$(mktemp -d)
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT HUP INT TERM

say "Downloading $ASSET..."
fetch "$BASE/$ASSET" "$TMP_DIR/$ASSET" ||
  die "Download failed: $BASE/$ASSET
    Does release $TAG have an asset for $TARGET?"

say "Verifying checksum..."
fetch "$BASE/checksums.txt" "$TMP_DIR/checksums.txt" ||
  die "Release $TAG has no checksums.txt — refusing to install an unverified binary."

EXPECTED=$(grep -E "[[:space:]]\*?$ASSET\$" "$TMP_DIR/checksums.txt" | cut -d' ' -f1 | head -1)
[ -n "$EXPECTED" ] || die "checksums.txt has no entry for $ASSET — refusing to install."

ACTUAL=$(sha256_of "$TMP_DIR/$ASSET")
if [ "$EXPECTED" != "$ACTUAL" ]; then
  die "Checksum mismatch — NOT installing.
    expected $EXPECTED
    got      $ACTUAL"
fi
ok "SHA-256 matches ($ACTUAL)"

mkdir -p "$INSTALL_DIR"
chmod +x "$TMP_DIR/$ASSET"
# Move into place last, so a failed download never replaces a working binary.
mv -f "$TMP_DIR/$ASSET" "$BIN_PATH"
ok "Installed to $BIN_PATH"

# ── PATH ────────────────────────────────────────────────────────────────────
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
