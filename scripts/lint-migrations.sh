#!/usr/bin/env bash
# =============================================================================
# lint-migrations.sh — Kooker pre-commit hook for Flyway migration safety.
#
# Install (from your service repo root):
#   chmod +x path/to/kooker-workflows/scripts/lint-migrations.sh
#   ln -sf ../../kooker-workflows/scripts/lint-migrations.sh .git/hooks/pre-commit
#
# Or for a self-contained copy:
#   cp kooker-workflows/scripts/lint-migrations.sh .git/hooks/pre-commit
#   chmod +x .git/hooks/pre-commit
#
# Environment overrides:
#   KOOKER_LINT_MODE=warn    — warn only (don't block commit)
#   KOOKER_LINT_MODE=error   — block commit on violation (default)
# =============================================================================
set -uo pipefail

# Validate MODE — only 'warn' or 'error' are accepted.
# Any unknown value (including typos) defaults to 'error' to prevent
# accidental bypass of the safety check.
RAW_MODE="${KOOKER_LINT_MODE:-error}"
if [ "$RAW_MODE" = "warn" ]; then
  MODE="warn"
else
  MODE="error"  # default, covers typos and unset
fi

# BREAKING_PATTERNS — aligned with flyway-lint.yml (use [^;]* for ALTER to avoid
# matching across statement boundaries, consistent with CI behaviour).
BREAKING_PATTERNS=(
  '(^|[[:space:]])DROP[[:space:]]+TABLE'
  '(^|[[:space:]])DROP[[:space:]]+COLUMN'
  '(^|[[:space:]])RENAME[[:space:]]+TABLE'
  '(^|[[:space:]])RENAME[[:space:]]+COLUMN'
  '(^|[[:space:]])TRUNCATE[[:space:]]'
  'ALTER[[:space:]]+TABLE[^;]*[[:space:]]DROP[[:space:]]'
  'ALTER[[:space:]]+TABLE[^;]*[[:space:]]MODIFY[[:space:]]+COLUMN'
  'ALTER[[:space:]]+TABLE[^;]*[[:space:]]CHANGE[[:space:]]+COLUMN'
)

NAMING_RE='^V[0-9]+(\.[0-9]+)*__[a-zA-Z0-9_]+\.sql$'

# Find staged migration SQL files (added or modified)
STAGED=$(git diff --cached --name-only --diff-filter=AM | grep -E 'db/migration/.*\.sql$' || true)

if [ -z "$STAGED" ]; then
  exit 0
fi

FAIL=0

echo "[kooker-lint] Checking staged migration files..."

while IFS= read -r file; do
  [ -z "$file" ] && continue

  # ── Naming convention ──────────────────────────────────────────────────
  fname=$(basename "$file")
  if ! echo "$fname" | grep -qE "$NAMING_RE"; then
    echo "[kooker-lint] ✖ NAMING: '$fname' must match V<N>__<description>.sql"
    FAIL=1
  fi

  # ── Breaking-change scan ───────────────────────────────────────────────
  # Read from the staged index (git show ":$file"), NOT the working tree.
  # This ensures we check exactly what will be committed, even if the
  # developer has made further edits after staging.
  LINE_NUM=0
  while IFS= read -r line; do
    LINE_NUM=$((LINE_NUM+1))
    # Skip SQL single-line comments to prevent false positives (e.g. -- DROP TABLE example)
    TRIMMED=$(echo "$line" | sed 's/^[[:space:]]*//')
    [[ "$TRIMMED" == --* ]] && continue
    echo "$line" | grep -qi 'kooker:allow-breaking' && continue
    UPPER=$(echo "$line" | tr '[:lower:]' '[:upper:]')
    for PAT in "${BREAKING_PATTERNS[@]}"; do
      if echo "$UPPER" | grep -qE "$PAT"; then
        echo "[kooker-lint] ✖ BREAKING at ${file}:${LINE_NUM} → $line"
        FAIL=1
      fi
    done
  done < <(git show ":${file}" 2>/dev/null || cat "$file")
done <<< "$STAGED"

if [ $FAIL -ne 0 ]; then
  echo ""
  echo "[kooker-lint] ┌──────────────────────────────────────────────────────┐"
  echo "[kooker-lint] │  BREAKING DB CHANGE DETECTED                         │"
  echo "[kooker-lint] │  Flyway migrations must be additive-only.            │"
  echo "[kooker-lint] │                                                      │"
  echo "[kooker-lint] │  To override a specific line, add this comment:      │"
  echo "[kooker-lint] │    -- kooker:allow-breaking                          │"
  echo "[kooker-lint] │                                                      │"
  echo "[kooker-lint] │  To run in warn-only mode (allow commit):            │"
  echo "[kooker-lint] │    KOOKER_LINT_MODE=warn git commit ...              │"
  echo "[kooker-lint] └──────────────────────────────────────────────────────┘"
  [ "$MODE" = "error" ] && exit 1
else
  echo "[kooker-lint] ✔ All migration files pass."
fi
