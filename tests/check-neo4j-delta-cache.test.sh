#!/usr/bin/env bash
# =============================================================================
# check-neo4j-delta-cache.test.sh — security & runtime tests for
# .github/workflows/neo4j-delta-cache.yml
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKFLOW="$REPO_ROOT/.github/workflows/neo4j-delta-cache.yml"

TMP="$(mktemp -d 2>/dev/null || mktemp -d -t 'neo4j-delta-test.XXXXXX')"
trap 'rm -rf "$TMP"' EXIT

extract_step() {
  local step_name="$1" out_file="$2"
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

META_SH="$TMP/meta.sh"
UPSERT_SH="$TMP/upsert.sh"
FILES_SH="$TMP/files.sh"
CLEANUP_SH="$TMP/cleanup.sh"
extract_step "Resolve metadata" "$META_SH"
extract_step "Upsert Commit node" "$UPSERT_SH"
extract_step "Cache changed files" "$FILES_SH"
extract_step "Cleanup temporary delta workspace" "$CLEANUP_SH"

# Check python3 & jq availability (on Windows Git Bash, provide shims if absent)
mkdir -p "$TMP/bin"
if ! command -v python3 >/dev/null 2>&1; then
  cat > "$TMP/bin/python3" <<'SH'
#!/usr/bin/env bash
exec python "$@"
SH
  chmod +x "$TMP/bin/python3"
fi
if ! command -v jq >/dev/null 2>&1; then
  cat > "$TMP/bin/jq" <<'SH'
#!/usr/bin/env bash
node -e '
const fs = require("node:fs");
const args = process.argv.slice(1);
let raw = false;
let nullInput = false;
const vars = {};
const rest = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-r") { raw = true; }
  else if (a === "-n") { nullInput = true; }
  else if (a === "--arg") { vars[args[++i]] = args[++i]; }
  else if (a === "--argjson") { vars[args[++i]] = JSON.parse(args[++i]); }
  else { rest.push(a); }
}
const expr = rest[0] || ".";
const file = rest[1];
if (nullInput) {
  const stmtMatch = expr.match(/statement:\s*"((?:[^"\\]|\\.)*)"/);
  const statement = stmtMatch ? stmtMatch[1] : "";
  const paramMatch = expr.match(/parameters:\s*\{([^}]*)\}/);
  const params = {};
  if (paramMatch) {
    for (const part of paramMatch[1].split(",")) {
      const m = part.trim().match(/^(\w+):\s*\$(\w+)$/);
      if (m) params[m[1]] = vars[m[2]];
    }
  }
  console.log(JSON.stringify({ statements: [{ statement, parameters: params }] }));
  process.exit(0);
}
const obj = JSON.parse(fs.readFileSync(file, "utf8"));
if (expr === ".errors | length") {
  console.log(Array.isArray(obj.errors) ? obj.errors.length : 0);
} else if (expr === ".errors") {
  console.log(JSON.stringify(obj.errors || []));
} else {
  console.log(raw ? String(obj) : JSON.stringify(obj));
}
' -- "$@"
SH
  chmod +x "$TMP/bin/jq"
fi
export PATH="$TMP/bin:$PATH"

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

# Create git repo with normal file + single-quote injection filename
REPO="$TMP/repo"
mkdir -p "$REPO/docs"
(
  cd "$REPO"
  git init -q
  git config user.name T
  git config user.email t@example.invalid
  printf 'initial\n' > docs/init.md
  git add .
  git commit -qm init
  BASE_SHA="$(git rev-parse HEAD)"
  printf '%s' "$BASE_SHA" > "$TMP/base_sha"
  printf '# hello\n' > "docs/evil'quote';import os;open('pwned','w').write('x');#.md"
  git add .
  git commit -qm "feat: add quoted file"
  git rev-parse HEAD > "$TMP/head_sha"
)
BASE_SHA="$(cat "$TMP/base_sha")"
HEAD_SHA="$(cat "$TMP/head_sha")"

echo "=== 1. URL & input validation ==="
assert_exit "non-HTTPS remote neo4j_base_url rejected" 1 \
  bash -c 'cd "$1" && NEO4J_URL="http://neo4j.example.invalid" HEAD_SHA="$2" BASE_SHA="$3" COMMIT_MSG="hi" GITHUB_REPOSITORY="org/r" GITHUB_OUTPUT="$4" RUNNER_TEMP="$5" bash "$6"' _ \
    "$REPO" "$HEAD_SHA" "$BASE_SHA" "$TMP/bad_out.txt" "$TMP" "$META_SH"

assert_exit "invalid head_sha rejected" 1 \
  bash -c 'cd "$1" && NEO4J_URL="https://neo4j.example.invalid" HEAD_SHA="not-a-sha" BASE_SHA="$2" COMMIT_MSG="hi" GITHUB_REPOSITORY="org/r" GITHUB_OUTPUT="$3" RUNNER_TEMP="$4" bash "$5"' _ \
    "$REPO" "$BASE_SHA" "$TMP/bad_out2.txt" "$TMP" "$META_SH"

echo "=== 2. Mock Neo4j HTTP server + single-quote filename injection check ==="
REQ_LOG="$TMP/neo4j_requests.jsonl"
SERVER_INFO="$TMP/server_port.txt"
: > "$REQ_LOG"

node -e '
const http = require("node:http");
const fs = require("node:fs");
const reqLog = process.argv[1];
const portFile = process.argv[2];

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", c => { body += c; });
  req.on("end", () => {
    fs.appendFileSync(reqLog, JSON.stringify({
      url: req.url,
      auth: req.headers.authorization || "",
      body: JSON.parse(body || "{}")
    }) + "\n");
    if (process.env.MOCK_MODE === "error500") {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ errors: [{ code: "Err", message: "boom" }] }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ results: [], errors: [] }));
  });
});
server.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(portFile, String(server.address().port));
});
' "$REQ_LOG" "$SERVER_INFO" &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true; rm -rf "$TMP"' EXIT

for _ in $(seq 1 50); do
  [ -s "$SERVER_INFO" ] && break
  sleep 0.05
done
PORT="$(cat "$SERVER_INFO")"
MOCK_URL="http://127.0.0.1:${PORT}"

GH_OUT="$TMP/meta_out.txt"
: > "$GH_OUT"
(
  cd "$REPO"
  NEO4J_URL="$MOCK_URL" \
  BASE_SHA="$BASE_SHA" \
  HEAD_SHA="$HEAD_SHA" \
  COMMIT_MSG="feat: add quoted file" \
  COMMIT_TS="2026-11-26T00:00:00Z" \
  REPO_INPUT="kooker-workflows" \
  GITHUB_REPOSITORY="duikindiesee/kooker-workflows" \
  GITHUB_OUTPUT="$GH_OUT" \
  RUNNER_TEMP="$TMP" \
  bash "$META_SH"
)
DELTA_DIR="$(grep '^delta_dir=' "$GH_OUT" | cut -d= -f2-)"
if [ ! -d "$DELTA_DIR" ]; then
  echo "FAIL: delta_dir not created inside RUNNER_TEMP" >&2
  exit 1
fi
echo "PASS  metadata resolved using isolated mktemp workspace ($DELTA_DIR)"
PASS=$((PASS + 1))

(
  cd "$REPO"
  NEO4J_URL="$MOCK_URL" NEO4J_USER="neo4j" NEO4J_PASS="synthetic-pass" \
  REPO="kooker-workflows" SHA="$HEAD_SHA" TS="2026-11-26T00:00:00Z" DELTA_DIR="$DELTA_DIR" \
  bash "$UPSERT_SH"
)
(
  cd "$REPO"
  NEO4J_URL="$MOCK_URL" NEO4J_USER="neo4j" NEO4J_PASS="synthetic-pass" \
  REPO="kooker-workflows" SHA="$HEAD_SHA" DELTA_DIR="$DELTA_DIR" \
  bash "$FILES_SH"
)

if [ -e "$REPO/pwned" ] || [ -e "$TMP/pwned" ]; then
  echo "FAIL: single-quote filename executed Python injection!" >&2
  exit 1
fi
echo "PASS  single-quote filename serialized safely via sys.argv[1] without code execution"
PASS=$((PASS + 1))

# Verify auth header was sent and file content was serialized
node -e '
const fs = require("node:fs");
const assert = require("node:assert/strict");
const lines = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").map(l => JSON.parse(l));
assert.equal(lines.length, 2, "Expected 2 Neo4j calls (commit + 1 changed file)");
assert.equal(lines[0].auth, "Basic " + Buffer.from("neo4j:synthetic-pass").toString("base64"));
const fileParams = lines[1].body.statements[0].parameters;
assert.ok(fileParams.path.includes("evil'\''quote"), "Crafted filename must reach Neo4j parameter intact");
assert.equal(fileParams.content, "# hello\n", "File content must be JSON-serialized");
' "$REQ_LOG"
echo "PASS  Neo4j received Basic auth via curl config and serialized file content"
PASS=$((PASS + 1))

# Verify cleanup step removes DELTA_DIR
(RUNNER_TEMP="$TMP" DELTA_DIR="$DELTA_DIR" bash "$CLEANUP_SH")
if [ -e "$DELTA_DIR" ]; then
  echo "FAIL: cleanup step did not remove DELTA_DIR" >&2
  exit 1
fi
echo "PASS  cleanup step removed temporary delta workspace"
PASS=$((PASS + 1))

# Verify workflow contains zero hardcoded /tmp/commit_message.txt or -u argv
if grep -qE '/tmp/(commit_message|changed_files)\.txt' "$WORKFLOW" || grep -qE 'curl .*-u ' "$WORKFLOW"; then
  echo "FAIL: hardcoded /tmp/ path or curl -u argv found in neo4j-delta-cache.yml" >&2
  exit 1
fi
echo "PASS  no hardcoded /tmp files or curl -u argv credentials in neo4j-delta-cache.yml"
PASS=$((PASS + 1))

# Verify HTTP 500 fails closed
kill "$SERVER_PID" 2>/dev/null || true
SERVER_INFO2="$TMP/server_port2.txt"
node -e '
const http = require("node:http");
const fs = require("node:fs");
const server = http.createServer((req, res) => {
  res.writeHead(500, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ errors: [{ code: "Err", message: "boom" }] }));
});
server.listen(0, "127.0.0.1", () => fs.writeFileSync(process.argv[1], String(server.address().port)));
' "$SERVER_INFO2" &
SERVER_PID=$!
for _ in $(seq 1 50); do
  [ -s "$SERVER_INFO2" ] && break
  sleep 0.05
done
PORT2="$(cat "$SERVER_INFO2")"
ERR_DELTA="$(mktemp -d "$TMP/neo4j-delta-err-XXXXXX")"
printf 'msg\n' > "$ERR_DELTA/commit_message.txt"
assert_exit "HTTP 500 from Neo4j fails closed" 1 \
  bash -c 'cd "$1" && NEO4J_URL="$2" NEO4J_USER="u" NEO4J_PASS="p" REPO="r" SHA="$3" TS="2026-11-26T00:00:00Z" DELTA_DIR="$4" bash "$5"' _ \
    "$REPO" "http://127.0.0.1:${PORT2}" "$HEAD_SHA" "$ERR_DELTA" "$UPSERT_SH"

echo "=== Summary: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
