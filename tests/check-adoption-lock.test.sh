#!/usr/bin/env bash
# =============================================================================
# check-adoption-lock.test.sh — unit tests for CityLife adoption lock & GitOps
#
# Validates:
# 1. Step order and barrier placement in .github/workflows/gitops-sync.yml
# 2. Execution of the actual workflow run block for the adoption lock guard
# 3. Execution of the actual workflow run block for the approval/merge barrier
# 4. Standalone CLI behavior of scripts/check-adoption-lock.sh
#
# Zero external dependencies beyond bash + node/python. Run directly:
#   bash tests/check-adoption-lock.test.sh
#
# Exits 0 if every test passes, 1 otherwise.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKFLOW_FILE="$REPO_ROOT/.github/workflows/gitops-sync.yml"
GUARD_SCRIPT="$REPO_ROOT/scripts/check-adoption-lock.sh"

TMPDIR_ROOT="$(mktemp -d 2>/dev/null || mktemp -d -t 'adoption-lock-test')"
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

mkdir -p "$TMPDIR_ROOT/infra/manifests/adoption-locks"
VALID_LOCK="$TMPDIR_ROOT/infra/manifests/adoption-locks/citylife-multiplayer.lock"
cat << 'EOF' > "$VALID_LOCK"
{
  "lockVersion": 1,
  "service": "citylife-multiplayer",
  "status": "LOCKED",
  "reason": "Single-service automatic adoption is blocked"
}
EOF

MALFORMED_LOCK="$TMPDIR_ROOT/infra/manifests/adoption-locks/citylife-multiplayer.lock.bad"
cat << 'EOF' > "$MALFORMED_LOCK"
{ this is not valid json
EOF

PASS_COUNT=0
FAIL_COUNT=0

# Extract step run block from workflow
extract_step_run() {
  local step_name="$1"
  awk -v name="$step_name" '
    $0 ~ "name: " name { flag=1; next }
    flag && /run: \|/ { run_flag=1; next }
    flag && /^[ ]{6}- name:/ { exit }
    run_flag && /^[ ]{6}[a-zA-Z]/ { exit }
    run_flag { print }
  ' "$WORKFLOW_FILE"
}

WORKFLOW_GUARD_SCRIPT="$TMPDIR_ROOT/workflow_guard.sh"
extract_step_run "Enforce release hold and adoption lock" > "$WORKFLOW_GUARD_SCRIPT"

WORKFLOW_MERGE_SCRIPT="$TMPDIR_ROOT/workflow_merge.sh"
extract_step_run "Approve and merge as the deploy approver" > "$WORKFLOW_MERGE_SCRIPT"

assert_exit() {
  local name="$1" expected="$2"; shift 2
  local output
  output="$("$@" 2>&1)"
  local actual=$?
  if [ "$actual" -eq "$expected" ]; then
    echo "PASS  $name (exit $actual)"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "FAIL  $name — expected exit $expected, got $actual"
    echo "      output:"
    echo "$output" | sed 's/^/      | /'
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

assert_contains() {
  local name="$1" needle="$2"; shift 2
  local output
  output="$("$@" 2>&1)"
  if echo "$output" | grep -qF -- "$needle"; then
    echo "PASS  $name (output contains '$needle')"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "FAIL  $name — expected output to contain '$needle'"
    echo "      output:"
    echo "$output" | sed 's/^/      | /'
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

echo "=== 1. Validating gitops-sync.yml step order and structure ==="

# Check that Enforce step appears after Checkout kooker-infra and before Kustomize/PR/merge steps
checkout_line=$(grep -n "name: Checkout kooker-infra" "$WORKFLOW_FILE" | cut -d: -f1)
guard_line=$(grep -n "name: Enforce release hold and adoption lock" "$WORKFLOW_FILE" | cut -d: -f1)
kustomize_line=$(grep -n "name: Update Kustomize Image" "$WORKFLOW_FILE" | cut -d: -f1)
pr_line=$(grep -n "name: Open the deploy PR" "$WORKFLOW_FILE" | cut -d: -f1)
merge_line=$(grep -n "name: Approve and merge as the deploy approver" "$WORKFLOW_FILE" | cut -d: -f1)

if [ "$checkout_line" -lt "$guard_line" ]; then
  echo "PASS  guard step is placed AFTER Checkout kooker-infra (lines $checkout_line < $guard_line)"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "FAIL  guard step must be after Checkout kooker-infra"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

if [ "$guard_line" -lt "$kustomize_line" ] && [ "$guard_line" -lt "$pr_line" ] && [ "$guard_line" -lt "$merge_line" ]; then
  echo "PASS  guard step is placed BEFORE Update Kustomize, Open PR, and Approve/Merge (lines $guard_line < $kustomize_line, $pr_line, $merge_line)"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "FAIL  guard step must precede all deployment mutation steps"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# Validate extracted workflow scripts are non-empty
if [ -s "$WORKFLOW_GUARD_SCRIPT" ]; then
  echo "PASS  extracted workflow guard run block is non-empty"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "FAIL  failed to extract workflow guard run block"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

if [ -s "$WORKFLOW_MERGE_SCRIPT" ]; then
  echo "PASS  extracted workflow approve/merge run block is non-empty"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "FAIL  failed to extract workflow approve/merge run block"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

echo ""
echo "=== 2. Testing actual gitops-sync.yml guard run block ==="

run_workflow_guard() {
  local kustomize_path="$1"
  local image_name="$2"
  local new_tag="$3"
  local work_dir="$4"

  (
    cd "$work_dir"
    KUSTOMIZE_PATH="$kustomize_path" \
    IMAGE_NAME="$image_name" \
    NEW_TAG="$new_tag" \
    bash "$WORKFLOW_GUARD_SCRIPT"
  )
}

EMPTY_DIR="$TMPDIR_ROOT/empty_test_dir"
mkdir -p "$EMPTY_DIR"

assert_exit "workflow guard: unrelated overlay (kooker-web) exits 0" 0 \
  run_workflow_guard "manifests/overlays/develop/kooker-web" "ghcr.io/duikindiesee/kooker-web" "0.125.0" "$TMPDIR_ROOT"

assert_contains "workflow guard: unrelated overlay logs bypass" "adoption lock check bypassed" \
  run_workflow_guard "manifests/overlays/develop/kooker-web" "ghcr.io/duikindiesee/kooker-web" "0.125.0" "$TMPDIR_ROOT"

assert_exit "workflow guard: client missing lock file fails closed (exit 1)" 1 \
  run_workflow_guard "manifests/overlays/develop/citylife" "ghcr.io/duikindiesee/citylife" "0.61.0" "$EMPTY_DIR"

assert_contains "workflow guard: client missing lock error" "Missing adoption lock file" \
  run_workflow_guard "manifests/overlays/develop/citylife" "ghcr.io/duikindiesee/citylife" "0.61.0" "$EMPTY_DIR"

assert_exit "workflow guard: server missing lock file fails closed (exit 1)" 1 \
  run_workflow_guard "manifests/overlays/develop/citylife-server" "ghcr.io/duikindiesee/citylife-server" "0.4.0" "$EMPTY_DIR"

assert_exit "workflow guard: client image mismatch fails closed (exit 1)" 1 \
  run_workflow_guard "manifests/overlays/develop/citylife" "ghcr.io/duikindiesee/citylife-server" "0.61.0" "$TMPDIR_ROOT"

assert_contains "workflow guard: client image mismatch message" "Image name mismatch" \
  run_workflow_guard "manifests/overlays/develop/citylife" "ghcr.io/duikindiesee/citylife-server" "0.61.0" "$TMPDIR_ROOT"

assert_exit "workflow guard: server image mismatch fails closed (exit 1)" 1 \
  run_workflow_guard "manifests/overlays/develop/citylife-server" "ghcr.io/duikindiesee/citylife" "0.4.0" "$TMPDIR_ROOT"

assert_exit "workflow guard: single-service client adoption fails closed (exit 1)" 1 \
  run_workflow_guard "manifests/overlays/develop/citylife" "ghcr.io/duikindiesee/citylife" "0.61.0" "$TMPDIR_ROOT"

assert_contains "workflow guard: client single-service blocked message" "Single-service automated adoption is strictly blocked" \
  run_workflow_guard "manifests/overlays/develop/citylife" "ghcr.io/duikindiesee/citylife" "0.61.0" "$TMPDIR_ROOT"

assert_exit "workflow guard: single-service server adoption fails closed (exit 1)" 1 \
  run_workflow_guard "manifests/overlays/develop/citylife-server" "ghcr.io/duikindiesee/citylife-server" "0.4.0" "$TMPDIR_ROOT"

assert_contains "workflow guard: server single-service blocked message" "Single-service automated adoption is strictly blocked" \
  run_workflow_guard "manifests/overlays/develop/citylife-server" "ghcr.io/duikindiesee/citylife-server" "0.4.0" "$TMPDIR_ROOT"

echo ""
echo "=== 3. Testing actual gitops-sync.yml approve/merge barrier ==="

run_workflow_merge() {
  local kustomize_path="$1"
  KUSTOMIZE_PATH="$kustomize_path" \
  GH_TOKEN="mock_token" \
  PR_URL="https://github.com/duikindiesee/kooker-infra/pull/999" \
  bash "$WORKFLOW_MERGE_SCRIPT"
}

assert_exit "workflow merge barrier: client overlay exits 1" 1 \
  run_workflow_merge "manifests/overlays/develop/citylife"

assert_contains "workflow merge barrier: client error message" "Auto-approval and auto-merge is strictly forbidden" \
  run_workflow_merge "manifests/overlays/develop/citylife"

assert_exit "workflow merge barrier: server overlay exits 1" 1 \
  run_workflow_merge "manifests/overlays/develop/citylife-server"

assert_contains "workflow merge barrier: server error message" "Auto-approval and auto-merge is strictly forbidden" \
  run_workflow_merge "manifests/overlays/develop/citylife-server"

echo ""
echo "=== 4. Testing standalone scripts/check-adoption-lock.sh ==="

run_guard_script() {
  bash "$GUARD_SCRIPT" "$@"
}

assert_exit "script: unrelated overlay exits 0" 0 \
  run_guard_script --kustomize-path "manifests/overlays/develop/kooker-web" --image-name "ghcr.io/duikindiesee/kooker-web" --new-tag "0.125.0"

assert_exit "script: protected client missing lock exits 1" 1 \
  run_guard_script --kustomize-path "manifests/overlays/develop/citylife" --image-name "ghcr.io/duikindiesee/citylife" --new-tag "0.61.0" --lock-path "$TMPDIR_ROOT/nonexistent.lock"

assert_exit "script: protected client malformed lock exits 1" 1 \
  run_guard_script --kustomize-path "manifests/overlays/develop/citylife" --image-name "ghcr.io/duikindiesee/citylife" --new-tag "0.61.0" --lock-path "$MALFORMED_LOCK"

assert_exit "script: protected client locked exits 1" 1 \
  run_guard_script --kustomize-path "manifests/overlays/develop/citylife" --image-name "ghcr.io/duikindiesee/citylife" --new-tag "0.61.0" --lock-path "$VALID_LOCK"

echo ""
echo "=== Summary: $PASS_COUNT passed, $FAIL_COUNT failed ==="
if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
exit 0
