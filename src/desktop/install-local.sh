#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DESTINATION="/Applications/Botmux.app"
OPEN_AFTER_INSTALL=1
SKIP_BUILD=0
SKIP_DEPS=0
SKIP_LINK=0

usage() {
  cat <<'EOF'
Usage:
  bash src/desktop/install-local.sh [options]

Options:
  --app-path <path>   Install destination. Must end with Botmux.app.
  --no-open          Do not open the app after installation.
  --skip-build       Reuse an existing dist/mac*/Botmux.app build.
  --skip-deps        Do not run pnpm install when node_modules is missing.
  --skip-link        Do not run pnpm link --global.
  -h, --help         Show this help.
EOF
}

log() {
  printf '==> %s\n' "$*"
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-path)
      [[ $# -ge 2 ]] || fail "--app-path requires a value"
      DESTINATION="$2"
      shift 2
      ;;
    --no-open)
      OPEN_AFTER_INSTALL=0
      shift
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --skip-deps)
      SKIP_DEPS=1
      shift
      ;;
    --skip-link)
      SKIP_LINK=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

[[ "$(uname -s)" == "Darwin" ]] || fail "Botmux Desktop local install currently supports macOS only"
command -v node >/dev/null 2>&1 || fail "Node.js 22 or newer is required"
command -v pnpm >/dev/null 2>&1 || fail "pnpm is required. Try: corepack enable"
command -v codesign >/dev/null 2>&1 || fail "codesign is required on macOS"
command -v ditto >/dev/null 2>&1 || fail "ditto is required on macOS"

# Match the runtime used by the CLI/dashboard build so source installs do not
# produce a Desktop app that immediately fails against an older local Node.
NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
[[ "$NODE_MAJOR" -ge 22 ]] || fail "Node.js 22 or newer is required. Current node: $(node -v)"

case "$(basename "$DESTINATION")" in
  Botmux.app) ;;
  *) fail "--app-path must point to a bundle named Botmux.app" ;;
esac

cd "$ROOT_DIR"

if [[ "$SKIP_DEPS" -eq 0 && ! -x node_modules/.bin/tsc ]]; then
  log "Install dependencies"
  pnpm install
fi

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  log "Build CLI and dashboard"
  pnpm build

  log "Build Desktop bundle"
  pnpm desktop:bundle

  log "Package Botmux.app locally"
  pnpm exec electron-builder --mac dir --config electron-builder.yml
fi

if [[ "$SKIP_LINK" -eq 0 ]]; then
  log "Link this source checkout as the global botmux CLI"
  # The Desktop app is CLI-first. Linking keeps the App and global CLI on the
  # same source checkout without adding App installation commands to botmux CLI.
  pnpm link --global
fi

BUILT_APP=""
for candidate in \
  "$ROOT_DIR/dist/mac-arm64/Botmux.app" \
  "$ROOT_DIR/dist/mac/Botmux.app" \
  "$ROOT_DIR/dist/mac-universal/Botmux.app"; do
  if [[ -d "$candidate" ]]; then
    BUILT_APP="$candidate"
    break
  fi
done

[[ -n "$BUILT_APP" ]] || fail "dist/mac*/Botmux.app not found. Run without --skip-build first."

log "Quit running Botmux app if needed"
osascript -e 'tell application "Botmux" to quit' >/dev/null 2>&1 || true
sleep 1

log "Install to $DESTINATION"
rm -rf "$DESTINATION"
ditto "$BUILT_APP" "$DESTINATION"

log "Ad-hoc sign local app"
codesign --force --deep --sign - --options runtime --entitlements "$ROOT_DIR/build/entitlements.mac.plist" "$DESTINATION"

log "Remove quarantine attribute"
xattr -dr com.apple.quarantine "$DESTINATION" >/dev/null 2>&1 || true

log "Verify app signature"
codesign --verify --deep --strict --verbose=2 "$DESTINATION"

if [[ "$OPEN_AFTER_INSTALL" -eq 1 ]]; then
  log "Open Botmux Desktop"
  open "$DESTINATION"
fi

printf '\nBotmux Desktop installed at %s\n' "$DESTINATION"
