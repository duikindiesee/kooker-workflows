#!/usr/bin/env bash
# Execute the actual reusable bump step in disposable Git consumer checkouts.
# Optional NODE_BUMP_CONSUMER_DIR points to an exact reviewed Client checkout.
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
WORKFLOW="$ROOT/.github/workflows/node-version-bump.yml"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
BUMP="$TMP/bump.sh"
awk '
  /^      - name: Detect bump type and write version to package.json$/ { step=1; next }
  step && /^        run: \|$/ { run=1; next }
  run && /^        env:$/ { exit }
  run && /^          / { print substr($0,11); next }
  run && /^$/ { print ""; next }
' "$WORKFLOW" > "$BUMP"
if ! grep -q 'npm version "${NEW_VERSION}"' "$BUMP" || ! grep -q 'bumped=true' "$BUMP"; then
  printf 'FAIL: exact version-bump step extraction\n' >&2
  exit 1
fi

setup_case() {
  local dir="$1" mode="$2"
  mkdir -p "$dir/fixtures/canonical-world" "$dir/src/colony/multiplayer"
  if [ "$mode" = real ]; then
    local consumer="$NODE_BUMP_CONSUMER_DIR"
    test "$(git -C "$consumer" rev-parse HEAD)" = 143897ba14a7bb4a2e1d1220babcfd81d6d1b264
    grep -qF 'duikindiesee/kooker-workflows/.github/workflows/node-version-bump.yml@main' "$consumer/.github/workflows/docker.yml"
    cp "$consumer/package.json" "$dir/package.json"
    cp "$consumer/package-lock.json" "$dir/package-lock.json"
    cp "$consumer/fixtures/canonical-world/seed-4242-layout-r0.json" "$dir/fixtures/canonical-world/seed-4242-layout-r0.json"
    cp "$consumer/src/colony/multiplayer/multiplayerClient.ts" "$dir/src/colony/multiplayer/multiplayerClient.ts"
    local actual
    actual="$(sha256sum "$dir/fixtures/canonical-world/seed-4242-layout-r0.json")"
    test "${actual%% *}" = ba13be286091aabce8fc04e0cfee054c3fc618f525e90be453217df7d668cca0
  else
    printf '{"name":"fixture-byte-guard","version":"0.60.4","private":true}\n' > "$dir/package.json"
    printf '{"name":"fixture-byte-guard","version":"0.60.4","lockfileVersion":3,"packages":{"":{"name":"fixture-byte-guard","version":"0.60.4"}}}\n' > "$dir/package-lock.json"
    printf '{"seed":4242,"paths":[1,2]}\n' > "$dir/fixtures/canonical-world/seed-4242-layout-r0.json"
    printf 'export const preserved={x:1,y:2};\n' > "$dir/src/colony/multiplayer/multiplayerClient.ts"
  fi
  (cd "$dir" && git init -q && git add package.json package-lock.json fixtures src && git -c user.name=Fixture -c user.email=fixture@local commit -qm 'reviewed consumer bytes')
}

run_step() {
  local dir="$1" message="$2"
  # Keep workflow outputs outside the consumer checkout: the source guard
  # rightly treats unrelated untracked files inside it as an error.
  (cd "$dir" && COMMIT_MSG="$message" GITHUB_OUTPUT="$TMP/${dir##*/}-output.txt" GH_TOKEN='' bash "$BUMP" > "$TMP/step-stdout.txt" 2> "$TMP/step-stderr.txt")
}

assert_clean_bump() {
  local label="$1" mode="${2:-synthetic}" message="${3:-fix: reviewed source merge}" expected="${4:-0.60.5}" dir="$TMP/$1"
  if [ "$mode" = tagged ]; then
    setup_case "$dir" synthetic
    (cd "$dir" && git tag v0.60.5)
  else
    setup_case "$dir" "$mode"
  fi
  local fixture=fixtures/canonical-world/seed-4242-layout-r0.json
  local source=src/colony/multiplayer/multiplayerClient.ts
  local fixture_before source_before fixture_after source_after changed
  fixture_before="$(cd "$dir" && git rev-parse "HEAD:$fixture")"
  source_before="$(cd "$dir" && git rev-parse "HEAD:$source")"
  if ! run_step "$dir" "$message"; then
    printf 'FAIL %s: workflow step failed before version-only proof\n' "$label" >&2
    return 1
  fi
  fixture_after="$(cd "$dir" && git rev-parse "HEAD:$fixture")"
  source_after="$(cd "$dir" && git rev-parse "HEAD:$source")"
  changed="$(cd "$dir" && git diff --name-only HEAD^ HEAD)"
  if [ "$fixture_before" != "$fixture_after" ] || [ "$source_before" != "$source_after" ] ||
     [ "$changed" != "$(printf 'package-lock.json\npackage.json')" ] ||
     ! grep -q "^new-version=${expected}$" "$TMP/${dir##*/}-output.txt" ||
     ! grep -q '^bumped=true$' "$TMP/${dir##*/}-output.txt"; then
    printf 'FAIL %s: fixture/source bytes or package-only diff violated\n' "$label" >&2
    return 1
  fi
  printf 'PASS %s: actual workflow step changes only package metadata; fixture/source blobs preserved\n' "$label"
}

assert_clean_bump synthetic
assert_clean_bump feat-minor synthetic 'feat: reviewed feature merge' 0.61.0
assert_clean_bump breaking-major synthetic 'feat!: reviewed breaking merge' 1.0.0
assert_clean_bump existing-tag tagged 'fix: advance past reserved tag' 0.60.6
if [ -n "${NODE_BUMP_CONSUMER_DIR:-}" ]; then
  assert_clean_bump reviewed-client real
fi

DIRTY="$TMP/dirty-worktree"
setup_case "$DIRTY" synthetic
printf 'unexpected tracked mutation\n' >> "$DIRTY/src/colony/multiplayer/multiplayerClient.ts"
base_head="$(cd "$DIRTY" && git rev-parse HEAD)"
if run_step "$DIRTY" 'fix: reviewed source merge' || [ "$(cd "$DIRTY" && git rev-parse HEAD)" != "$base_head" ]; then
  printf 'FAIL dirty-worktree: unexpected source diff must abort before commit\n' >&2
  exit 1
fi
printf 'PASS dirty-worktree: unexpected non-package diff fails closed\n'

UNTRACKED="$TMP/untracked-worktree"
setup_case "$UNTRACKED" synthetic
printf 'unexpected untracked mutation\n' > "$UNTRACKED/unexpected.txt"
base_head="$(cd "$UNTRACKED" && git rev-parse HEAD)"
if run_step "$UNTRACKED" 'fix: reviewed source merge' || [ "$(cd "$UNTRACKED" && git rev-parse HEAD)" != "$base_head" ]; then
  printf 'FAIL untracked-worktree: unexpected file must abort before commit\n' >&2
  exit 1
fi
printf 'PASS untracked-worktree: unexpected untracked file fails closed\n'

RELEASE="$TMP/release-loop"
setup_case "$RELEASE" synthetic
base_head="$(cd "$RELEASE" && git rev-parse HEAD)"
run_step "$RELEASE" 'chore(release): bump to 0.60.5'
if [ "$(cd "$RELEASE" && git rev-parse HEAD)" != "$base_head" ] ||
   ! grep -q '^new-version=0.60.4$' "$TMP/release-loop-output.txt" ||
   ! grep -q '^bumped=false$' "$TMP/release-loop-output.txt"; then
  printf 'FAIL release-loop: loop guard regressed\n' >&2
  exit 1
fi
printf 'PASS release-loop: no second bump\n'
