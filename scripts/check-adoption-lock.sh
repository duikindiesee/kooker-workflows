#!/usr/bin/env bash
# =============================================================================
# check-adoption-lock.sh — Fail-closed adoption lock guard for GitOps sync.
#
# Inspects GitOps promotion targets in kooker-infra before any branch push,
# PR creation, PR approval, or squash-merge can execute.
#
# CONTRACT:
# 1. Unrelated overlays (e.g. manifests/overlays/develop/kooker-web) are
#    unaffected and exit 0 immediately.
# 2. Protected overlays:
#      manifests/overlays/develop/citylife
#      manifests/overlays/develop/citylife-server
#    are fail-closed:
#    - Mismatched or unexpected IMAGE_NAME fails closed (exit 1).
#    - Missing adoption lock file fails closed (exit 1).
#    - Malformed/unparseable lock file fails closed (exit 1).
#    - Status LOCKED fails closed (exit 1).
#    - Single-service automatic adoption is strictly blocked (exit 1).
#      Paired adoption must be delivered via an atomic, separately reviewed
#      single PR to kooker-infra updating both immutable image pins simultaneously.
#
# Usage:
#   check-adoption-lock.sh \
#     --kustomize-path <path> \
#     --image-name <image> \
#     --new-tag <tag> \
#     [--infra-dir <dir>] \
#     [--lock-path <path>]
#
# Exit codes:
#   0 — Unrelated overlay allowed to proceed.
#   1 — Fail closed (protected overlay hold active, missing lock, or malformed data).
# =============================================================================
set -uo pipefail

KUSTOMIZE_PATH=""
IMAGE_NAME=""
NEW_TAG=""
INFRA_DIR="infra"
LOCK_PATH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --kustomize-path)
      KUSTOMIZE_PATH="$2"
      shift 2
      ;;
    --image-name)
      IMAGE_NAME="$2"
      shift 2
      ;;
    --new-tag)
      NEW_TAG="$2"
      shift 2
      ;;
    --infra-dir)
      INFRA_DIR="$2"
      shift 2
      ;;
    --lock-path)
      LOCK_PATH="$2"
      shift 2
      ;;
    -h|--help)
      grep -E '^# ' "$0" | sed 's/^# //'
      exit 0
      ;;
    *)
      echo "ERROR: Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$KUSTOMIZE_PATH" ]]; then
  echo "ERROR: --kustomize-path is required" >&2
  exit 1
fi

PROTECTED_CLIENT="manifests/overlays/develop/citylife"
PROTECTED_SERVER="manifests/overlays/develop/citylife-server"

# Unrelated services proceed unhindered
if [[ "$KUSTOMIZE_PATH" != "$PROTECTED_CLIENT" && "$KUSTOMIZE_PATH" != "$PROTECTED_SERVER" ]]; then
  echo "INFO: Unrelated service overlay ($KUSTOMIZE_PATH); adoption lock check bypassed."
  exit 0
fi

# Protected overlay validation
echo "INFO: Evaluating fail-closed release hold for protected overlay: $KUSTOMIZE_PATH"

if [[ "$KUSTOMIZE_PATH" == "$PROTECTED_CLIENT" && "$IMAGE_NAME" != "ghcr.io/duikindiesee/citylife" ]]; then
  echo "ERROR: Mismatched image_name '$IMAGE_NAME' for protected client overlay '$KUSTOMIZE_PATH'" >&2
  exit 1
fi

if [[ "$KUSTOMIZE_PATH" == "$PROTECTED_SERVER" && "$IMAGE_NAME" != "ghcr.io/duikindiesee/citylife-server" ]]; then
  echo "ERROR: Mismatched image_name '$IMAGE_NAME' for protected server overlay '$KUSTOMIZE_PATH'" >&2
  exit 1
fi

if [[ -z "$LOCK_PATH" ]]; then
  LOCK_PATH="${INFRA_DIR}/manifests/adoption-locks/citylife-multiplayer.lock"
fi

if [[ ! -f "$LOCK_PATH" ]]; then
  echo "ERROR: Missing adoption lock file at '$LOCK_PATH'. Protected overlay fails closed; single-service automated adoption is blocked." >&2
  exit 1
fi

# Validate JSON parseability
is_valid_json=0
if command -v jq >/dev/null 2>&1; then
  if jq -e . "$LOCK_PATH" >/dev/null 2>&1; then
    is_valid_json=1
  fi
elif command -v node >/dev/null 2>&1; then
  if node -e "const fs = require('fs'); JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));" "$LOCK_PATH" >/dev/null 2>&1; then
    is_valid_json=1
  fi
elif command -v python3 >/dev/null 2>&1; then
  if python3 -c "import json, sys; json.load(open(sys.argv[1]))" "$LOCK_PATH" >/dev/null 2>&1; then
    is_valid_json=1
  fi
elif command -v python >/dev/null 2>&1; then
  if python -c "import json, sys; json.load(open(sys.argv[1]))" "$LOCK_PATH" >/dev/null 2>&1; then
    is_valid_json=1
  fi
fi

if [[ "$is_valid_json" -ne 1 ]]; then
  echo "ERROR: Malformed or unreadable adoption lock file at '$LOCK_PATH'. Fails closed." >&2
  exit 1
fi

# Automatic single-service adoption is blocked for protected overlays
echo "ERROR: Single-service automatic adoption is blocked for CityLife multiplayer ($KUSTOMIZE_PATH). Paired promotion must be performed via a separately reviewed single infra PR updating both immutable image pins simultaneously." >&2
exit 1
