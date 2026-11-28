#!/usr/bin/env bash
# =============================================================================
# check-version-bumps.test.sh — regression suite for:
#   - .github/workflows/android-version-bump.yml
#   - .github/workflows/maven-version-bump.yml
#   - .github/workflows/auto-version.yml
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

TMP="$(mktemp -d 2>/dev/null || mktemp -d -t 'version-bumps-test.XXXXXX')"
trap 'rm -rf "$TMP"' EXIT

extract_step() {
  local wf="$1" step_name="$2" out_file="$3"
  awk -v name="$step_name" '
    $0 == ("      - name: " name) { in_step=1; next }
    in_step && /^      - name: / { exit }
    in_step && /^        run: \|$/ { in_run=1; next }
    in_run && /^          / { print substr($0, 11); next }
    in_run && /^$/ { print ""; next }
    in_run && !/^          / { exit }
  ' "$wf" > "$out_file"
  if [ ! -s "$out_file" ]; then
    echo "FAIL: failed to extract step '$step_name' from $wf" >&2
    exit 1
  fi
}

PASS=0
FAIL=0

assert_exit() {
  local label="$1" expected="$2"; shift 2
  set +e
  local out
  out="$("$@" 2>&1)"
  local actual=$?
  set -e
  if [ "$actual" -eq "$expected" ]; then
    echo "PASS  $label (exit $actual)"
    PASS=$((PASS + 1))
  else
    echo "FAIL  $label — expected exit $expected, got $actual" >&2
    printf '%s\n' "$out" | sed 's/^/  | /' >&2
    FAIL=$((FAIL + 1))
  fi
}

# =============================================================================
# 1. android-version-bump.yml
# =============================================================================
ANDROID_WF="$REPO_ROOT/.github/workflows/android-version-bump.yml"
ANDROID_SH="$TMP/android_bump.sh"
extract_step "$ANDROID_WF" "Detect bump type and apply version" "$ANDROID_SH"

make_android_repo() {
  local dir="$1" quote_char="$2" version="${3:-1.2.3}"
  mkdir -p "$dir/remote.git"
  git init --bare -q "$dir/remote.git"
  git clone -q "$dir/remote.git" "$dir/work"
  mkdir -p "$dir/work/my-app/app"
  cat > "$dir/work/my-app/app/build.gradle" <<GRADLE
android {
    defaultConfig {
        versionCode 123
        versionName ${quote_char}${version}${quote_char}
    }
}
GRADLE
  (cd "$dir/work" && git config user.name T && git config user.email t@example.invalid && git add . && git commit -qm init && git push -q -u origin HEAD)
}

echo "=== 1. android-version-bump.yml ==="
for bad_dir in '../escape' '-flag' 'dir with spaces' '/abs/dir'; do
  A_BAD="$TMP/a-bad-$(printf '%s' "$bad_dir" | tr -dc 'A-Za-z0-9')"
  make_android_repo "$A_BAD" "'"
  assert_exit "android rejects invalid app-dir ($bad_dir)" 1 \
    bash -c 'cd "$1" && APP_DIR="$2" COMMIT_MSG="fix: x" GH_TOKEN="" GITHUB_OUTPUT="$3" bash "$4"' _ \
      "$A_BAD/work" "$bad_dir" "$A_BAD/out.txt" "$ANDROID_SH"
done

# Non-semver versionName fails closed
A_BADVER="$TMP/a-badver"
make_android_repo "$A_BADVER" "'" "1.2.bad"
assert_exit "android rejects non-semver versionName" 1 \
  bash -c 'cd "$1" && APP_DIR="my-app" COMMIT_MSG="fix: x" GH_TOKEN="" GITHUB_OUTPUT="$2" bash "$3"' _ \
    "$A_BADVER/work" "$A_BADVER/out.txt" "$ANDROID_SH"

# Single-quoted versionName feat: bump -> 1.3.0 (130)
A_SINGLE="$TMP/a-single"
make_android_repo "$A_SINGLE" "'" "1.2.3"
: > "$A_SINGLE/out.txt"
(cd "$A_SINGLE/work" && APP_DIR="my-app" COMMIT_MSG="feat: new screen" GH_TOKEN="" GITHUB_OUTPUT="$A_SINGLE/out.txt" bash "$ANDROID_SH")
grep -q '^new-version=1.3.0$' "$A_SINGLE/out.txt" && grep -q '^new-version-code=130$' "$A_SINGLE/out.txt" && grep -q '^bumped=true$' "$A_SINGLE/out.txt"
echo "PASS  android single-quoted versionName feat: bumps 1.2.3 -> 1.3.0 (130)"
PASS=$((PASS + 1))

# Double-quoted versionName fix: bump -> 1.2.4 (124)
A_DOUBLE="$TMP/a-double"
make_android_repo "$A_DOUBLE" '"' "1.2.3"
: > "$A_DOUBLE/out.txt"
(cd "$A_DOUBLE/work" && APP_DIR="my-app" COMMIT_MSG="fix: bug" GH_TOKEN="" GITHUB_OUTPUT="$A_DOUBLE/out.txt" bash "$ANDROID_SH")
grep -q '^new-version=1.2.4$' "$A_DOUBLE/out.txt" && grep -q '^new-version-code=124$' "$A_DOUBLE/out.txt" && grep -q '^bumped=true$' "$A_DOUBLE/out.txt"
echo "PASS  android double-quoted versionName fix: bumps 1.2.3 -> 1.2.4 (124)"
PASS=$((PASS + 1))

# Loop guard chore(release): skips bump
: > "$A_DOUBLE/loop.txt"
(cd "$A_DOUBLE/work" && APP_DIR="my-app" COMMIT_MSG="chore(release): bump my-app to 1.2.4" GH_TOKEN="" GITHUB_OUTPUT="$A_DOUBLE/loop.txt" bash "$ANDROID_SH")
grep -q '^bumped=false$' "$A_DOUBLE/loop.txt"
echo "PASS  android chore(release): loop guard skips bump"
PASS=$((PASS + 1))

# =============================================================================
# 2. maven-version-bump.yml
# =============================================================================
MAVEN_WF="$REPO_ROOT/.github/workflows/maven-version-bump.yml"
MAVEN_SH="$TMP/maven_bump.sh"
MAVEN_REL_SH="$TMP/maven_release.sh"
extract_step "$MAVEN_WF" "Detect bump type and apply version" "$MAVEN_SH"
extract_step "$MAVEN_WF" "Create GitHub Release" "$MAVEN_REL_SH"

BIN_DIR="$TMP/bin"
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/mvn" <<'SH'
#!/usr/bin/env bash
if [[ "$*" == *"help:evaluate"* ]]; then
  echo "${MOCK_MVN_VERSION:-1.0.3}"
  exit 0
fi
if [[ "$*" == *"versions:set"* ]]; then
  newv="${MOCK_NEW_VERSION:-}"
  for arg in "$@"; do
    case "$arg" in
      -DnewVersion=*) newv="${arg#-DnewVersion=}" ;;
    esac
  done
  find . -name "pom.xml" -not -path "./.git/*" -exec sed -i "s/<version>[^<]*<\/version>/<version>${newv}<\/version>/" {} +
  if [ "${MOCK_DIRTY_SOURCE:-0}" = "1" ]; then
    echo "tampered" > src_tampered.txt
  fi
  exit 0
fi
exit 1
SH
chmod +x "$BIN_DIR/mvn"

cat > "$BIN_DIR/gh" <<'SH'
#!/usr/bin/env bash
echo "$*" >> "${GH_LOG:?}"
if [ "$1" = "release" ] && [ "$2" = "view" ]; then
  exit 1
fi
exit 0
SH
chmod +x "$BIN_DIR/gh"

echo "=== 2. maven-version-bump.yml ==="
M_WORK="$TMP/m-work"
mkdir -p "$M_WORK/sub dir with spaces"
printf '<project><version>1.0.3</version></project>\n' > "$M_WORK/pom.xml"
printf '<project><version>1.0.3</version></project>\n' > "$M_WORK/sub dir with spaces/pom.xml"
(cd "$M_WORK" && git init -q && git config user.name T && git config user.email t@example.invalid && git add . && git commit -qm init)
: > "$TMP/maven-out.txt"
(cd "$M_WORK" && PATH="$BIN_DIR:$PATH" COMMIT_MSG="feat: add endpoint" GITHUB_ACTOR="bot" GITHUB_TOKEN="t" GITHUB_OUTPUT="$TMP/maven-out.txt" bash "$MAVEN_SH")
grep -q '^new-version=1.1.0$' "$TMP/maven-out.txt" && grep -q '^bumped=true$' "$TMP/maven-out.txt"
echo "PASS  maven bump handles paths with spaces and bumps feat: 1.0.3 -> 1.1.0"
PASS=$((PASS + 1))

# Non-semver version fails closed
assert_exit "maven rejects non-semver project.version" 1 \
  bash -c 'cd "$1" && PATH="$2:$PATH" MOCK_MVN_VERSION="bad-ver" COMMIT_MSG="fix: x" GITHUB_ACTOR="bot" GITHUB_TOKEN="t" GITHUB_OUTPUT="$4" bash "$3"' _ \
    "$M_WORK" "$BIN_DIR" "$MAVEN_SH" "$TMP/maven-bad.txt"

# Unexpected modified/untracked file fails closed
assert_exit "maven aborts if unexpected file created during bump" 1 \
  bash -c 'cd "$1" && PATH="$2:$PATH" MOCK_DIRTY_SOURCE=1 COMMIT_MSG="fix: x" GITHUB_ACTOR="bot" GITHUB_TOKEN="t" GITHUB_OUTPUT="$4" bash "$3"' _ \
    "$M_WORK" "$BIN_DIR" "$MAVEN_SH" "$TMP/maven-dirty.txt"

# Release step uses env-bound NEW_VERSION
: > "$TMP/gh.log"
(PATH="$BIN_DIR:$PATH" GH_LOG="$TMP/gh.log" GH_TOKEN="t" NEW_VERSION="1.1.0" bash "$MAVEN_REL_SH")
grep -q '^release create v1.1.0 --title Release v1.1.0 --generate-notes$' "$TMP/gh.log"
echo "PASS  maven Create GitHub Release uses env-bound NEW_VERSION"
PASS=$((PASS + 1))

# =============================================================================
# 3. auto-version.yml
# =============================================================================
AUTO_WF="$REPO_ROOT/.github/workflows/auto-version.yml"
AUTO_COMPUTE_SH="$TMP/auto_compute.sh"
AUTO_PUSH_SH="$TMP/auto_push.sh"
extract_step "$AUTO_WF" "Compute next version tag" "$AUTO_COMPUTE_SH"
extract_step "$AUTO_WF" "Create and push tag" "$AUTO_PUSH_SH"

echo "=== 3. auto-version.yml ==="
node -e '
const fs = require("node:fs");
const assert = require("node:assert/strict");
const yaml = require("./tests/node_modules/yaml");
const wf = yaml.parse(fs.readFileSync(process.argv[1], "utf8"));
const input = wf.on.workflow_call.inputs["has-db-changes"];
assert.ok(input && input.default === "false", "auto-version must define has-db-changes input");
' "$AUTO_WF"
echo "PASS  auto-version.yml declares has-db-changes input"
PASS=$((PASS + 1))

AU_DIR="$TMP/au-repo"
mkdir -p "$AU_DIR/remote.git" "$AU_DIR/work"
git init --bare -q "$AU_DIR/remote.git"
git clone -q "$AU_DIR/remote.git" "$AU_DIR/work"
(cd "$AU_DIR/work" && git config user.name T && git config user.email t@example.invalid && printf 'hi\n' > f && git add f && git commit -qm init && git tag v1.2.3 && git push -q origin HEAD --tags)

: > "$AU_DIR/out1.txt"
(cd "$AU_DIR/work" && HAS_DB_CHANGES="false" GITHUB_OUTPUT="$AU_DIR/out1.txt" bash "$AUTO_COMPUTE_SH")
grep -q '^tag=v1.2.4$' "$AU_DIR/out1.txt"
echo "PASS  auto-version patch bump v1.2.3 -> v1.2.4"
PASS=$((PASS + 1))

(cd "$AU_DIR/work" && git tag v1.2.4)
: > "$AU_DIR/out2.txt"
(cd "$AU_DIR/work" && HAS_DB_CHANGES="true" GITHUB_OUTPUT="$AU_DIR/out2.txt" bash "$AUTO_COMPUTE_SH")
grep -q '^tag=v1.2.4.1$' "$AU_DIR/out2.txt"
echo "PASS  auto-version db micro bump v1.2.4 -> v1.2.4.1"
PASS=$((PASS + 1))

assert_exit "auto-version rejects invalid has-db-changes" 1 \
  bash -c 'cd "$1" && HAS_DB_CHANGES="yes;id" GITHUB_OUTPUT="$2" bash "$3"' _ "$AU_DIR/work" "$AU_DIR/bad.txt" "$AUTO_COMPUTE_SH"
assert_exit "auto-version tag push rejects injected TAG" 1 \
  bash -c 'cd "$1" && TAG="v1.0.0;id" GH_TOKEN="" bash "$2"' _ "$AU_DIR/work" "$AUTO_PUSH_SH"
(cd "$AU_DIR/work" && TAG="v1.2.4.1" GH_TOKEN="" bash "$AUTO_PUSH_SH")
git -C "$AU_DIR/remote.git" rev-parse -q --verify refs/tags/v1.2.4.1 >/dev/null
echo "PASS  auto-version Create and push tag creates and pushes v1.2.4.1"
PASS=$((PASS + 1))

echo "=== Summary: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
