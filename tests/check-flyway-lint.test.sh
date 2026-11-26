#!/usr/bin/env bash
# =============================================================================
# check-flyway-lint.test.sh — regression tests for .github/workflows/flyway-lint.yml
# and scripts/lint-migrations.sh
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKFLOW="$REPO_ROOT/.github/workflows/flyway-lint.yml"
HOOK_SCRIPT="$REPO_ROOT/scripts/lint-migrations.sh"

TMP="$(mktemp -d 2>/dev/null || mktemp -d -t 'flyway-lint-test.XXXXXX')"
trap 'rm -rf "$TMP"' EXIT

extract_step() {
  local step_name="$1"
  local out_file="$2"
  awk -v name="$step_name" '
    $0 == ("      - name: " name) { in_step=1; next }
    in_step && /^      - name: / { exit }
    in_step && /^        run: \|$/ { in_run=1; next }
    in_run && /^          / { print substr($0, 11); next }
    in_run && /^$/ { print ""; next }
    in_run && !/^          / { exit }
  ' "$WORKFLOW" > "$out_file"
  if [ ! -s "$out_file" ]; then
    echo "FAIL: failed to extract step '$step_name'" >&2
    exit 1
  fi
}

DETECT_SH="$TMP/detect.sh"
NAMING_SH="$TMP/naming.sh"
BREAKING_SH="$TMP/breaking.sh"
MIGRATOR_SH="$TMP/migrator.sh"
extract_step "Detect new/changed migration files" "$DETECT_SH"
extract_step "Validate naming convention" "$NAMING_SH"
extract_step "Check for breaking SQL patterns" "$BREAKING_SH"
extract_step "Validate migrator profile safety" "$MIGRATOR_SH"

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

echo "=== 1. MIGRATION_PATH injection & traversal rejection ==="
R_INJ="$TMP/repo-inj"
mkdir -p "$R_INJ/src/main/resources/db/migration"
(cd "$R_INJ" && git init -q && git config user.name T && git config user.email t@example.invalid && printf 'SELECT 1;\n' > src/main/resources/db/migration/V1__init.sql && git add . && git commit -qm init)

for bad_path in \
  'src/main/resources/db/migration"; touch pwned; #' \
  '../escape' \
  '/abs/path' \
  '-flag'; do
  assert_exit "detect rejects invalid MIGRATION_PATH ($bad_path)" 1 \
    bash -c 'cd "$1" && MIGRATION_PATH="$2" GITHUB_OUTPUT="$3" GITHUB_ENV="$4" bash "$5"' _ \
      "$R_INJ" "$bad_path" "$TMP/out.txt" "$TMP/env.txt" "$DETECT_SH"
  assert_exit "naming rejects invalid MIGRATION_PATH ($bad_path)" 1 \
    bash -c 'cd "$1" && MIGRATION_PATH="$2" bash "$3"' _ "$R_INJ" "$bad_path" "$NAMING_SH"
done
if [ -e "$R_INJ/pwned" ]; then
  echo "FAIL: injection payload created file!" >&2
  exit 1
fi

echo "=== 2. GITHUB_ENV delimiter injection & no-trailing-LF SQL bypass ==="
R_NO_LF="$TMP/repo-nolf"
mkdir -p "$R_NO_LF/src/main/resources/db/migration"
(
  cd "$R_NO_LF"
  git init -q
  git config user.name T
  git config user.email t@example.invalid
  printf 'CREATE TABLE t (id INT);\n' > src/main/resources/db/migration/V1__init.sql
  git add .
  git commit -qm init
  # File without trailing newline containing DROP TABLE + another file named EOF_probe
  printf 'DROP TABLE users;' > src/main/resources/db/migration/V2__drop.sql
  printf 'SELECT 1;\n' > src/main/resources/db/migration/EOF
  git add .
  git commit -qm breaking
)

GH_OUT="$TMP/nolf_out.txt"
GH_ENV="$TMP/nolf_env.txt"
: > "$GH_OUT"
: > "$GH_ENV"
(cd "$R_NO_LF" && MIGRATION_PATH="src/main/resources/db/migration" GITHUB_OUTPUT="$GH_OUT" GITHUB_ENV="$GH_ENV" bash "$DETECT_SH")
if ! grep -q '^has_db_changes=true$' "$GH_OUT"; then
  echo "FAIL: detect did not output has_db_changes=true" >&2
  exit 1
fi
# Ensure GITHUB_ENV uses randomized delimiter, not static <<EOF
if grep -q 'CHANGED_FILES<<EOF$' "$GH_ENV"; then
  echo "FAIL: static <<EOF delimiter found in GITHUB_ENV" >&2
  exit 1
fi
echo "PASS  GITHUB_ENV uses randomized delimiter against EOF filename injection"
PASS=$((PASS + 1))

# Extract CHANGED_FILES from GITHUB_ENV and run breaking check (must fail on no-trailing-LF DROP TABLE)
CHANGED_VAL="$(awk 'NR==1{ sub(/^CHANGED_FILES<</,""); d=$0; next } $0==d{ exit } { print }' "$GH_ENV")"
assert_exit "flyway-lint catches single-line DROP TABLE without trailing LF" 1 \
  bash -c 'cd "$1" && CHANGED_FILES="$2" bash "$3"' _ "$R_NO_LF" "$CHANGED_VAL" "$BREAKING_SH"

# Also verify scripts/lint-migrations.sh catches no-trailing-LF DROP TABLE in staged index
R_HOOK="$TMP/repo-hook"
mkdir -p "$R_HOOK/src/main/resources/db/migration"
(
  cd "$R_HOOK"
  git init -q
  git config user.name T
  git config user.email t@example.invalid
  printf 'CREATE TABLE ok (id INT);\n' > src/main/resources/db/migration/V1__init.sql
  git add .
  git commit -qm init
  printf 'DROP TABLE users;' > src/main/resources/db/migration/V2__drop.sql
  git add src/main/resources/db/migration/V2__drop.sql
)
assert_exit "scripts/lint-migrations.sh catches DROP TABLE without trailing LF" 1 \
  bash -c 'cd "$1" && bash "$2"' _ "$R_HOOK" "$HOOK_SCRIPT"

echo "=== 3. Additive SQL, block comments & naming checks ==="
R_CLEAN="$TMP/repo-clean"
mkdir -p "$R_CLEAN/src/main/resources/db/migration"
(
  cd "$R_CLEAN"
  git init -q
  git config user.name T
  git config user.email t@example.invalid
  printf 'SELECT 1;\n' > src/main/resources/db/migration/V1__init.sql
  git add .
  git commit -qm init
  cat > src/main/resources/db/migration/V2__add_col.sql <<'SQL'
/* Multi-line block comment mentioning
   DROP TABLE safely in documentation */
ALTER TABLE users ADD COLUMN bio TEXT;
SQL
  git add .
  git commit -qm addcol
)
: > "$GH_OUT"
: > "$GH_ENV"
(cd "$R_CLEAN" && MIGRATION_PATH="src/main/resources/db/migration" GITHUB_OUTPUT="$GH_OUT" GITHUB_ENV="$GH_ENV" bash "$DETECT_SH")
CHANGED_CLEAN="$(awk 'NR==1{ sub(/^CHANGED_FILES<</,""); d=$0; next } $0==d{ exit } { print }' "$GH_ENV")"
assert_exit "additive SQL with /* DROP TABLE */ block comment passes" 0 \
  bash -c 'cd "$1" && CHANGED_FILES="$2" bash "$3"' _ "$R_CLEAN" "$CHANGED_CLEAN" "$BREAKING_SH"
assert_exit "valid V<N>__<desc>.sql naming passes" 0 \
  bash -c 'cd "$1" && MIGRATION_PATH="src/main/resources/db/migration" bash "$2"' _ "$R_CLEAN" "$NAMING_SH"

# Code outside /* ... */ on same line still fails
R_MIXED="$TMP/repo-mixed"
cp -R "$R_CLEAN" "$R_MIXED"
printf '/* comment */ DROP TABLE users;\n' > "$R_MIXED/src/main/resources/db/migration/V3__bad.sql"
assert_exit "code after /* ... */ on same line fails" 1 \
  bash -c 'cd "$1" && CHANGED_FILES="src/main/resources/db/migration/V3__bad.sql" bash "$2"' _ "$R_MIXED" "$BREAKING_SH"

# Invalid naming fails
printf 'SELECT 1;\n' > "$R_MIXED/src/main/resources/db/migration/bad_migration.sql"
assert_exit "invalid migration filename fails" 1 \
  bash -c 'cd "$1" && MIGRATION_PATH="src/main/resources/db/migration" bash "$2"' _ "$R_MIXED" "$NAMING_SH"

echo "=== 4. Multi-module application-migrator.y*ml checks ==="
BIN_DIR="$TMP/bin"
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/yq" <<'SH'
#!/usr/bin/env bash
query="$1"
file="$2"
node -e '
const fs = require("node:fs");
const q = process.argv[1];
const txt = fs.readFileSync(process.argv[2], "utf8");
const key = q.replace(/^\./, "");
const lines = txt.split(/\r?\n/);
const stack = [];
let found = "null";
for (const raw of lines) {
  if (!raw.trim() || raw.trim().startsWith("#")) continue;
  const indent = raw.match(/^(\s*)/)[1].length;
  const m = raw.trim().match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
  if (!m) continue;
  while (stack.length && stack[stack.length-1].indent >= indent) stack.pop();
  stack.push({ indent, key: m[1] });
  if (stack.map(s => s.key).join(".") === key) {
    found = m[2].trim();
  }
}
console.log(found);
' "$query" "$file"
SH
chmod +x "$BIN_DIR/yq"

R_MODS="$TMP/repo-mods"
mkdir -p "$R_MODS/mod-a/src/main/resources" "$R_MODS/mod-b/src/main/resources"
cat > "$R_MODS/mod-a/src/main/resources/application-migrator.yml" <<'YAML'
spring:
  cloud:
    config:
      enabled: false
eureka:
  client:
    enabled: false
management:
  endpoints:
    enabled-by-default: false
YAML
cat > "$R_MODS/mod-b/src/main/resources/application-migrator.yaml" <<'YAML'
spring:
  cloud:
    config:
      enabled: false
eureka:
  client:
    enabled: true
management:
  endpoints:
    enabled-by-default: false
YAML
assert_exit "second module unsafe application-migrator.yaml fails closed" 1 \
  bash -c 'cd "$1" && PATH="$2:$PATH" bash "$3"' _ "$R_MODS" "$BIN_DIR" "$MIGRATOR_SH"

sed -i 's/enabled: true/enabled: false/' "$R_MODS/mod-b/src/main/resources/application-migrator.yaml"
assert_exit "all safe application-migrator.y*ml pass" 0 \
  bash -c 'cd "$1" && PATH="$2:$PATH" bash "$3"' _ "$R_MODS" "$BIN_DIR" "$MIGRATOR_SH"

echo "=== Summary: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
