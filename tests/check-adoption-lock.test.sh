#!/usr/bin/env bash
# =============================================================================
# check-adoption-lock.test.sh — unit tests for CityLife adoption lock & GitOps
#
# Validates:
# 1. Step order and barrier placement in .github/workflows/gitops-sync.yml
# 2. Execution of actual workflow run block for the adoption lock guard,
#    including canonical path resolution, equivalent spellings (./, .., trailing slash),
#    escaping paths, missing paths, and unrelated services.
# 3. Execution of actual workflow run block for the approval/merge barrier across
#    all equivalent spellings.
# 4. Standalone CLI behavior of scripts/check-adoption-lock.sh across all equivalent
#    spellings and invalid paths.
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

# Create mock infra repo structure with overlays
mkdir -p "$TMPDIR_ROOT/infra/manifests/adoption-locks"
mkdir -p "$TMPDIR_ROOT/infra/manifests/overlays/develop/citylife"
mkdir -p "$TMPDIR_ROOT/infra/manifests/overlays/develop/citylife-server"
mkdir -p "$TMPDIR_ROOT/infra/manifests/overlays/develop/kooker-web"
mkdir -p "$TMPDIR_ROOT/infra/manifests/overlays/develop/sportifine-web"

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

# 2a. Unrelated overlays proceed unhindered (literal, ./, trailing slash, ..)
assert_exit "guard: unrelated overlay (kooker-web) exits 0" 0 \
  run_workflow_guard "manifests/overlays/develop/kooker-web" "ghcr.io/duikindiesee/kooker-web" "0.125.0" "$TMPDIR_ROOT"

assert_exit "guard: unrelated overlay with ./ exits 0" 0 \
  run_workflow_guard "./manifests/overlays/develop/kooker-web" "ghcr.io/duikindiesee/kooker-web" "0.125.0" "$TMPDIR_ROOT"

assert_exit "guard: unrelated overlay with trailing slash exits 0" 0 \
  run_workflow_guard "manifests/overlays/develop/kooker-web/" "ghcr.io/duikindiesee/kooker-web" "0.125.0" "$TMPDIR_ROOT"

assert_exit "guard: unrelated overlay with .. exits 0" 0 \
  run_workflow_guard "manifests/overlays/develop/../develop/kooker-web" "ghcr.io/duikindiesee/kooker-web" "0.125.0" "$TMPDIR_ROOT"

# 2b. Unavailable infra directory fails closed
assert_exit "guard: unavailable infra dir fails closed (exit 1)" 1 \
  run_workflow_guard "manifests/overlays/develop/citylife" "ghcr.io/duikindiesee/citylife" "0.61.0" "$EMPTY_DIR"

assert_contains "guard: unavailable infra dir error message" "Infra directory 'infra' is not available" \
  run_workflow_guard "manifests/overlays/develop/citylife" "ghcr.io/duikindiesee/citylife" "0.61.0" "$EMPTY_DIR"

# 2c. Escaping and invalid paths fail closed
assert_exit "guard: escaping path ../../.. fails closed (exit 1)" 1 \
  run_workflow_guard "../../.." "ghcr.io/duikindiesee/citylife" "0.61.0" "$TMPDIR_ROOT"

assert_contains "guard: escaping path error message" "escapes infra root" \
  run_workflow_guard "../../.." "ghcr.io/duikindiesee/citylife" "0.61.0" "$TMPDIR_ROOT"

assert_exit "guard: absolute path fails closed (exit 1)" 1 \
  run_workflow_guard "/manifests/overlays/develop/citylife" "ghcr.io/duikindiesee/citylife" "0.61.0" "$TMPDIR_ROOT"

assert_contains "guard: absolute path error message" "Invalid or absolute kustomize_path" \
  run_workflow_guard "/manifests/overlays/develop/citylife" "ghcr.io/duikindiesee/citylife" "0.61.0" "$TMPDIR_ROOT"

assert_exit "guard: nonexistent target directory fails closed (exit 1)" 1 \
  run_workflow_guard "manifests/overlays/develop/nonexistent" "ghcr.io/duikindiesee/citylife" "0.61.0" "$TMPDIR_ROOT"

assert_contains "guard: nonexistent target error message" "does not exist in infra" \
  run_workflow_guard "manifests/overlays/develop/nonexistent" "ghcr.io/duikindiesee/citylife" "0.61.0" "$TMPDIR_ROOT"

# 2d. Missing lock file fails closed
NO_LOCK_DIR="$TMPDIR_ROOT/no_lock_infra"
mkdir -p "$NO_LOCK_DIR/infra/manifests/overlays/develop/citylife"
assert_exit "guard: protected client missing lock file fails closed (exit 1)" 1 \
  run_workflow_guard "manifests/overlays/develop/citylife" "ghcr.io/duikindiesee/citylife" "0.61.0" "$NO_LOCK_DIR"

assert_contains "guard: missing lock file error message" "Missing adoption lock file" \
  run_workflow_guard "manifests/overlays/develop/citylife" "ghcr.io/duikindiesee/citylife" "0.61.0" "$NO_LOCK_DIR"

# 2e. Image name mismatch fails closed
assert_exit "guard: client overlay with server image exits 1" 1 \
  run_workflow_guard "manifests/overlays/develop/citylife" "ghcr.io/duikindiesee/citylife-server" "0.61.0" "$TMPDIR_ROOT"

assert_contains "guard: client image mismatch message" "Image name mismatch" \
  run_workflow_guard "manifests/overlays/develop/citylife" "ghcr.io/duikindiesee/citylife-server" "0.61.0" "$TMPDIR_ROOT"

assert_exit "guard: server overlay with client image exits 1" 1 \
  run_workflow_guard "manifests/overlays/develop/citylife-server" "ghcr.io/duikindiesee/citylife" "0.4.0" "$TMPDIR_ROOT"

# 2f. Equivalent path spellings for protected client fail closed
assert_exit "guard: literal client overlay path exits 1" 1 \
  run_workflow_guard "manifests/overlays/develop/citylife" "ghcr.io/duikindiesee/citylife" "0.61.0" "$TMPDIR_ROOT"

assert_contains "guard: literal client blocked message" "Single-service automated adoption is strictly blocked" \
  run_workflow_guard "manifests/overlays/develop/citylife" "ghcr.io/duikindiesee/citylife" "0.61.0" "$TMPDIR_ROOT"

assert_exit "guard: client with leading ./ exits 1" 1 \
  run_workflow_guard "./manifests/overlays/develop/citylife" "ghcr.io/duikindiesee/citylife" "0.61.0" "$TMPDIR_ROOT"

assert_contains "guard: client with ./ blocked message" "Single-service automated adoption is strictly blocked for manifests/overlays/develop/citylife" \
  run_workflow_guard "./manifests/overlays/develop/citylife" "ghcr.io/duikindiesee/citylife" "0.61.0" "$TMPDIR_ROOT"

assert_exit "guard: client with trailing slash exits 1" 1 \
  run_workflow_guard "manifests/overlays/develop/citylife/" "ghcr.io/duikindiesee/citylife" "0.61.0" "$TMPDIR_ROOT"

assert_contains "guard: client with trailing slash blocked message" "Single-service automated adoption is strictly blocked for manifests/overlays/develop/citylife" \
  run_workflow_guard "manifests/overlays/develop/citylife/" "ghcr.io/duikindiesee/citylife" "0.61.0" "$TMPDIR_ROOT"

assert_exit "guard: client with .. navigation exits 1" 1 \
  run_workflow_guard "manifests/overlays/develop/../develop/citylife" "ghcr.io/duikindiesee/citylife" "0.61.0" "$TMPDIR_ROOT"

assert_contains "guard: client with .. blocked message" "Single-service automated adoption is strictly blocked for manifests/overlays/develop/citylife" \
  run_workflow_guard "manifests/overlays/develop/../develop/citylife" "ghcr.io/duikindiesee/citylife" "0.61.0" "$TMPDIR_ROOT"

# 2g. Equivalent path spellings for protected server fail closed
assert_exit "guard: literal server overlay path exits 1" 1 \
  run_workflow_guard "manifests/overlays/develop/citylife-server" "ghcr.io/duikindiesee/citylife-server" "0.4.0" "$TMPDIR_ROOT"

assert_exit "guard: server with leading ./ exits 1" 1 \
  run_workflow_guard "./manifests/overlays/develop/citylife-server" "ghcr.io/duikindiesee/citylife-server" "0.4.0" "$TMPDIR_ROOT"

assert_exit "guard: server with trailing slash exits 1" 1 \
  run_workflow_guard "manifests/overlays/develop/citylife-server/" "ghcr.io/duikindiesee/citylife-server" "0.4.0" "$TMPDIR_ROOT"

assert_exit "guard: server with .. navigation exits 1" 1 \
  run_workflow_guard "manifests/overlays/develop/../develop/citylife-server" "ghcr.io/duikindiesee/citylife-server" "0.4.0" "$TMPDIR_ROOT"

echo ""
echo "=== 3. Testing actual gitops-sync.yml approve/merge barrier ==="

run_workflow_merge() {
  local kustomize_path="$1"
  local work_dir="$2"
  (
    cd "$work_dir"
    KUSTOMIZE_PATH="$kustomize_path" \
    GH_TOKEN="mock_token" \
    PR_URL="https://github.com/duikindiesee/kooker-infra/pull/999" \
    bash "$WORKFLOW_MERGE_SCRIPT"
  )
}

assert_exit "barrier: literal client overlay exits 1" 1 \
  run_workflow_merge "manifests/overlays/develop/citylife" "$TMPDIR_ROOT"

assert_contains "barrier: literal client error message" "Auto-approval and auto-merge is strictly forbidden" \
  run_workflow_merge "manifests/overlays/develop/citylife" "$TMPDIR_ROOT"

assert_exit "barrier: client with leading ./ exits 1" 1 \
  run_workflow_merge "./manifests/overlays/develop/citylife" "$TMPDIR_ROOT"

assert_contains "barrier: client with ./ error message" "Auto-approval and auto-merge is strictly forbidden for protected CityLife overlays: manifests/overlays/develop/citylife" \
  run_workflow_merge "./manifests/overlays/develop/citylife" "$TMPDIR_ROOT"

assert_exit "barrier: client with trailing slash exits 1" 1 \
  run_workflow_merge "manifests/overlays/develop/citylife/" "$TMPDIR_ROOT"

assert_exit "barrier: client with .. navigation exits 1" 1 \
  run_workflow_merge "manifests/overlays/develop/../develop/citylife" "$TMPDIR_ROOT"

assert_exit "barrier: server with leading ./ exits 1" 1 \
  run_workflow_merge "./manifests/overlays/develop/citylife-server" "$TMPDIR_ROOT"

assert_exit "barrier: server with trailing slash exits 1" 1 \
  run_workflow_merge "manifests/overlays/develop/citylife-server/" "$TMPDIR_ROOT"

assert_exit "barrier: escaping path fails closed (exit 1)" 1 \
  run_workflow_merge "../../.." "$TMPDIR_ROOT"

assert_contains "barrier: escaping path error message" "escapes infra root" \
  run_workflow_merge "../../.." "$TMPDIR_ROOT"

echo ""
echo "=== 4. Testing standalone scripts/check-adoption-lock.sh ==="

run_guard_script() {
  (
    cd "$TMPDIR_ROOT"
    bash "$GUARD_SCRIPT" "$@"
  )
}

# 4a. Standalone CLI: unrelated overlays
assert_exit "script: unrelated overlay exits 0" 0 \
  run_guard_script --infra-dir "infra" --kustomize-path "manifests/overlays/develop/kooker-web" --image-name "ghcr.io/duikindiesee/kooker-web" --new-tag "0.125.0"

assert_exit "script: unrelated overlay with ./ exits 0" 0 \
  run_guard_script --infra-dir "infra" --kustomize-path "./manifests/overlays/develop/kooker-web" --image-name "ghcr.io/duikindiesee/kooker-web" --new-tag "0.125.0"

# 4b. Standalone CLI: unavailable infra dir fails closed (MoJoJo finding reproduction)
assert_exit "script: unavailable infra dir fails closed (exit 1)" 1 \
  run_guard_script --infra-dir "/not/available" --kustomize-path "./manifests/overlays/develop/citylife" --image-name "ghcr.io/duikindiesee/citylife" --new-tag "0.61.0"

assert_contains "script: unavailable infra dir error message" "is not available" \
  run_guard_script --infra-dir "/not/available" --kustomize-path "./manifests/overlays/develop/citylife" --image-name "ghcr.io/duikindiesee/citylife" --new-tag "0.61.0"

# 4c. Standalone CLI: equivalent path spellings fail closed
assert_exit "script: client with ./ exits 1" 1 \
  run_guard_script --infra-dir "infra" --kustomize-path "./manifests/overlays/develop/citylife" --image-name "ghcr.io/duikindiesee/citylife" --new-tag "0.61.0"

assert_contains "script: client with ./ blocked message" "Single-service automatic adoption is blocked for CityLife multiplayer (manifests/overlays/develop/citylife)" \
  run_guard_script --infra-dir "infra" --kustomize-path "./manifests/overlays/develop/citylife" --image-name "ghcr.io/duikindiesee/citylife" --new-tag "0.61.0"

assert_exit "script: client with trailing slash exits 1" 1 \
  run_guard_script --infra-dir "infra" --kustomize-path "manifests/overlays/develop/citylife/" --image-name "ghcr.io/duikindiesee/citylife" --new-tag "0.61.0"

assert_exit "script: client with .. exits 1" 1 \
  run_guard_script --infra-dir "infra" --kustomize-path "manifests/overlays/develop/../develop/citylife" --image-name "ghcr.io/duikindiesee/citylife" --new-tag "0.61.0"

assert_exit "script: server with ./ exits 1" 1 \
  run_guard_script --infra-dir "infra" --kustomize-path "./manifests/overlays/develop/citylife-server" --image-name "ghcr.io/duikindiesee/citylife-server" --new-tag "0.4.0"

assert_exit "script: server with trailing slash exits 1" 1 \
  run_guard_script --infra-dir "infra" --kustomize-path "manifests/overlays/develop/citylife-server/" --image-name "ghcr.io/duikindiesee/citylife-server" --new-tag "0.4.0"

# 4d. Standalone CLI: escaping and invalid paths fail closed
assert_exit "script: escaping path exits 1" 1 \
  run_guard_script --infra-dir "infra" --kustomize-path "../../.." --image-name "ghcr.io/duikindiesee/citylife" --new-tag "0.61.0"

assert_contains "script: escaping path error message" "escapes infra root" \
  run_guard_script --infra-dir "infra" --kustomize-path "../../.." --image-name "ghcr.io/duikindiesee/citylife" --new-tag "0.61.0"

assert_exit "script: nonexistent target exits 1" 1 \
  run_guard_script --infra-dir "infra" --kustomize-path "manifests/overlays/develop/nonexistent" --image-name "ghcr.io/duikindiesee/citylife" --new-tag "0.61.0"

echo ""
echo "=== Summary: $PASS_COUNT passed, $FAIL_COUNT failed ==="
if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
exit 0
