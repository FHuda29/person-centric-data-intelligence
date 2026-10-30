#!/usr/bin/env bash
#
# Deploy / update the PCDI stack on a Biznet VPS.
# Run from your local machine (Git Bash on Windows, or any bash):
#
#   bash infra/deploy/deploy.sh                 # target "layanan" (default): bundle -> transfer -> build -> up -d
#   bash infra/deploy/deploy.sh --target=cari   # target from infra/deploy/targets/cari.env
#   bash infra/deploy/deploy.sh --with-caddy    # also (re)install the target's Caddy site + reload Caddy
#   bash infra/deploy/deploy.sh --yes           # skip the confirmation prompt
#   bash infra/deploy/deploy.sh --no-build      # redeploy current images without rebuilding
#
# It never touches /opt/pcdi/.env or the data volumes. First-time setup (.env with secrets,
# creating /opt/pcdi) is NOT done here — see infra/deploy/README or the deployment memory.
#
set -euo pipefail

WITH_CADDY=0
ASSUME_YES=0
DO_BUILD=1
TARGET=layanan
for arg in "$@"; do
  case "$arg" in
    --with-caddy) WITH_CADDY=1 ;;
    --yes|-y)     ASSUME_YES=1 ;;
    --no-build)   DO_BUILD=0 ;;
    --target=*)   TARGET="${arg#--target=}" ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

# ---- resolve repo root (two levels up from this script) --------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

# ---- config: targets/<name>.env, then environment overrides ----------------
TARGET_FILE="$SCRIPT_DIR/targets/$TARGET.env"
[ -f "$TARGET_FILE" ] || { echo "Unknown target '$TARGET' (no $TARGET_FILE)" >&2; exit 2; }
KEYS="VPS_HOST VPS_USER SSH_KEY REMOTE_DIR DOMAIN CADDY_CONTAINER CADDY_SITE_FILE CADDY_SITE_DEST CADDY_CONFIG"
for k in $KEYS; do [ -n "${!k:-}" ] && printf -v "_ovr_$k" '%s' "${!k}"; done
# shellcheck disable=SC1090
. "$TARGET_FILE"
# explicit environment variables win over the target file
for k in $KEYS; do v="_ovr_$k"; [ -n "${!v:-}" ] && printf -v "$k" '%s' "${!v}"; done
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ -f "$SSH_KEY" ] || die "SSH key not found: $SSH_KEY (set SSH_KEY=...)"
[ -f "$REPO_ROOT/$COMPOSE_FILE" ] || die "$COMPOSE_FILE not found in repo root"
command -v ssh  >/dev/null || die "ssh not found in PATH"
command -v scp  >/dev/null || die "scp not found in PATH"

# ---- secure a 0600 copy of the key (Windows files are world-readable) ------
KEY_TMP="$(mktemp)"; cp "$SSH_KEY" "$KEY_TMP"; chmod 600 "$KEY_TMP"
TAR_TMP="$(mktemp -u).tar.gz"
cleanup() { rm -f "$KEY_TMP" "$TAR_TMP"; }
trap cleanup EXIT
SSH=(ssh -i "$KEY_TMP" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20)
REMOTE="$VPS_USER@$VPS_HOST"

say "Target: $REMOTE:$REMOTE_DIR   (build=$DO_BUILD, caddy=$WITH_CADDY)"
if [ "$ASSUME_YES" -ne 1 ]; then
  read -r -p "Deploy to this PRODUCTION host? [y/N] " ans
  [ "$ans" = "y" ] || [ "$ans" = "Y" ] || die "Aborted."
fi

# ---- 1. bundle source (no node_modules / dist / .env / .git) ---------------
say "Bundling source"
tar --exclude-vcs \
    --exclude='node_modules' --exclude='**/node_modules' \
    --exclude='dist' --exclude='**/dist' \
    --exclude='dist-test' --exclude='**/dist-test' \
    --exclude='.angular' --exclude='**/.angular' \
    --exclude='.env' --exclude='*.tar.gz' \
    -czf "$TAR_TMP" .
printf 'bundle size: %s\n' "$(du -h "$TAR_TMP" | cut -f1)"

# ---- 2. preflight: remote dir + .env must already exist --------------------
say "Checking remote prerequisites"
"${SSH[@]}" "$REMOTE" "test -d '$REMOTE_DIR' || { echo MISSING_DIR; exit 3; }; test -f '$REMOTE_DIR/.env' || { echo MISSING_ENV; exit 4; }" \
  || die "Remote $REMOTE_DIR or its .env is missing — run first-time setup before using this script."

# ---- 3. transfer + extract (tar overwrites tracked files, keeps .env/volumes)
say "Transferring and extracting"
scp -i "$KEY_TMP" -o StrictHostKeyChecking=accept-new "$TAR_TMP" "$REMOTE:$REMOTE_DIR/_deploy.tar.gz"
"${SSH[@]}" "$REMOTE" "cd '$REMOTE_DIR' && tar -xzf _deploy.tar.gz && rm -f _deploy.tar.gz && docker compose -f '$COMPOSE_FILE' config --quiet && echo CONFIG_OK"

# ---- 4. build + up ---------------------------------------------------------
if [ "$DO_BUILD" -eq 1 ]; then
  say "Building images on the VPS (cached; may take a few minutes)"
  "${SSH[@]}" "$REMOTE" "cd '$REMOTE_DIR' && docker compose -f '$COMPOSE_FILE' build"
fi
say "Starting / updating containers"
"${SSH[@]}" "$REMOTE" "cd '$REMOTE_DIR' && docker compose -f '$COMPOSE_FILE' up -d"

# ---- 5. optional: (re)install the Caddy site + reload (shared proxy) --------
if [ "$WITH_CADDY" -eq 1 ]; then
  say "Installing Caddy site and reloading (atomic — bad config keeps the old one)"
  "${SSH[@]}" "$REMOTE" "
    set -e
    cp '$REMOTE_DIR/$CADDY_SITE_FILE' '$CADDY_SITE_DEST'
    docker exec '$CADDY_CONTAINER' caddy validate --config '$CADDY_CONFIG' --adapter caddyfile
    docker exec '$CADDY_CONTAINER' caddy reload   --config '$CADDY_CONFIG' --adapter caddyfile
    echo CADDY_RELOADED"
fi

# ---- 6. report -------------------------------------------------------------
say "Status"
"${SSH[@]}" "$REMOTE" "cd '$REMOTE_DIR' && docker compose -f '$COMPOSE_FILE' ps --format 'table {{.Service}}\t{{.Status}}' && echo '--- health ---' && docker exec pcdi-api-1 wget -qO- http://127.0.0.1:3000/health 2>/dev/null || true"

say "Done. If the domain is wired: https://$DOMAIN"
