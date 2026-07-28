#!/usr/bin/env bash
# =============================================================================
# check-jdk25-baseline.test.sh — unit tests for scripts/check-jdk25-baseline.sh
#
# Zero external dependencies (no bats, no network, no Maven) — plain bash
# assertions against the fixture directories in tests/fixtures/. Run directly:
#
#   bash tests/check-jdk25-baseline.test.sh
#
# Exits 0 if every test passes, 1 otherwise (so it doubles as a CI step).
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GUARD="$REPO_ROOT/scripts/check-jdk25-baseline.sh"
FIXTURES="$SCRIPT_DIR/fixtures"

PASS_COUNT=0
FAIL_COUNT=0

run_guard() {
  # Runs the guard, capturing stdout+exit code without letting `set -e`
  # (not set here, but be explicit) abort the test runner on a nonzero exit.
  local out
  out="$("$GUARD" "$@" 2>&1)"
  local code=$?
  printf '%s' "$out"
  return "$code"
}

assert_exit() {
  local name="$1" expected="$2"; shift 2
  local output
  output="$(run_guard "$@")"
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
  output="$(run_guard "$@")"
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

assert_not_contains() {
  local name="$1" needle="$2"; shift 2
  local output
  output="$(run_guard "$@")"
  if echo "$output" | grep -qF -- "$needle"; then
    echo "FAIL  $name — expected output NOT to contain '$needle'"
    echo "      output:"
    echo "$output" | sed 's/^/      | /'
    FAIL_COUNT=$((FAIL_COUNT + 1))
  else
    echo "PASS  $name (output correctly omits '$needle')"
    PASS_COUNT=$((PASS_COUNT + 1))
  fi
}

echo "=== check-jdk25-baseline.sh — fixture matrix ==="

# ── Required proof: 24 fails ────────────────────────────────────────────────
assert_exit    "below (Java 24) fails"                 1 --root "$FIXTURES/below"
assert_contains "below (Java 24) names the violation"   "maven.compiler.release = 24  (< 25)" --root "$FIXTURES/below"

# ── Required proof: 25 passes ───────────────────────────────────────────────
assert_exit    "equal (Java 25) passes"                 0 --root "$FIXTURES/equal"
assert_not_contains "equal (Java 25) is never flagged as conflicting" "CONFLICTING" --root "$FIXTURES/equal"

# ── Required proof: 26 (above) passes ───────────────────────────────────────
assert_exit    "above (Java 26) passes"                  0 --root "$FIXTURES/above"

# ── Required proof: absent fails closed ─────────────────────────────────────
assert_exit    "absent fails closed by default"          1 --root "$FIXTURES/absent"
assert_contains "absent names fail-closed reason"         "declare no Java version" --root "$FIXTURES/absent"
assert_exit    "absent with --allow-absent defers (exit 2)" 2 --root "$FIXTURES/absent" --allow-absent

# ── Required proof: conflicting declarations fail closed ───────────────────
assert_exit    "conflicting declarations fail"            1 --root "$FIXTURES/conflicting"
assert_contains "conflicting names both disagreeing values" "CONFLICTING" --root "$FIXTURES/conflicting"

# ── Toolchain requirement below minimum also fails ──────────────────────────
assert_exit    "toolchain jdk version below minimum fails" 1 --root "$FIXTURES/toolchain-below"
assert_contains "toolchain finding names the tag"           "toolchain-jdk-version = 17" --root "$FIXTURES/toolchain-below"

# ── ${property} interpolation resolves correctly ────────────────────────────
assert_exit    "interpolated \${java.version}=26 passes"   0 --root "$FIXTURES/interpolated-above"

# ── Legacy 1.N notation is recognized and evaluated, not skipped ───────────
assert_exit    "legacy 1.8 notation fails (resolves to 8)" 1 --root "$FIXTURES/legacy-notation"
assert_contains "legacy notation reports resolved value 8" "= 8  (< 25)" --root "$FIXTURES/legacy-notation"

# ── Multi-module: a violation in ANY module fails the whole repo ───────────
assert_exit    "multi-module: module-b's 23 fails the repo" 1 --root "$FIXTURES/multi-module"
assert_contains "multi-module names the offending module"    "module-b" --root "$FIXTURES/multi-module"

# ── --minimum is genuinely configurable, not hardcoded ──────────────────────
assert_exit    "below (24) passes when --minimum is lowered to 20" 0 --root "$FIXTURES/below" --minimum 20

# ── A pure aggregator (packaging=pom, nothing to compile) is never required
#    to declare a Java version — it is excluded, not treated as absent. ─────
assert_exit    "pure aggregator (packaging=pom) passes on its own"  0 --root "$FIXTURES/aggregator-only"
assert_not_contains "pure aggregator is never listed as absent"      "absent" --root "$FIXTURES/aggregator-only"

# ── Hybrid repo: a compliant module must NEVER mask a silent sibling module.
#    module-a declares 25 (fine); module-b (default jar packaging) declares
#    nothing — the aggregator itself is correctly excluded, but module-b must
#    still be caught even though "some declaration exists in this repo". ───
assert_exit    "hybrid repo: silent sibling module fails closed"     1 --root "$FIXTURES/hybrid-absent-module"
assert_contains "hybrid repo names the silent module, not the aggregator" "module-b" --root "$FIXTURES/hybrid-absent-module"
assert_exit    "hybrid repo defers with --allow-absent (exit 2)"     2 --root "$FIXTURES/hybrid-absent-module" --allow-absent

echo
echo "=== $PASS_COUNT passed, $FAIL_COUNT failed ==="
[ "$FAIL_COUNT" -eq 0 ]
