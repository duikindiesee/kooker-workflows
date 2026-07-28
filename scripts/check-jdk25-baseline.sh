#!/usr/bin/env bash
# =============================================================================
# check-jdk25-baseline.sh — Kooker Maven Java-25 baseline guard.
#
# Statically scans every committed pom.xml (and toolchains.xml) under a repo
# root for Java version declarations — maven.compiler.release/source/target
# properties, the compiler-plugin's <release>/<source>/<target> configuration,
# and maven-toolchains-plugin / toolchains.xml <jdk><version> requirements —
# and fails the build if ANY declared value is below the required minimum
# (default 25), or if declarations within the same file disagree with each
# other (an ambiguous effective version is itself the risk being guarded
# against, independent of whether every individual value happens to clear the
# minimum).
#
# THIS SCRIPT DOES NOT RESOLVE PARENT-POM INHERITANCE. A child pom.xml that
# declares nothing of its own and inherits its Java version from an external
# parent (e.g. kooker-parent-build) will be reported ABSENT here — that is
# correct and by design: resolving inherited/effective values requires a real
# `mvn help:evaluate` against a fully resolved reactor, which needs network
# and credentials this script deliberately does not require. The companion
# reusable workflow (.github/workflows/jdk25-baseline-guard.yml) runs this
# script first for fast, deterministic, offline-safe feedback, then — only
# for files this script reports ABSENT — runs a live `mvn help:evaluate`
# effective-configuration cross-check before making the final pass/fail call.
# See docs/jdk25-baseline-adoption.md for the full two-layer contract.
#
# A pure aggregator (explicit <packaging>pom</packaging>) that declares
# nothing of its own is the one deliberate exception: it compiles no source,
# so it is excluded rather than reported ABSENT — kooker-service-user's and
# kooker-service-games's root pom.xml are exactly this shape in production.
# The exclusion never applies to a pom-packaged file that DOES declare
# something (e.g. kooker-parent-build itself, which is pom-packaged but sets
# the properties every child inherits) — that file is fully validated above
# like any other. ABSENCE is still tracked PER FILE, not once globally per
# repo, so one compliant module can never mask a silent sibling module.
#
# Usage:
#   check-jdk25-baseline.sh [--root DIR] [--minimum N] [--allow-absent]
#
#   --root DIR        Directory to scan (default: .)
#   --minimum N       Minimum acceptable Java version (default: 25)
#   --allow-absent    Do not fail when a pom.xml declares nothing at all
#                      (exit 2 instead of 1) — used by the reusable workflow,
#                      which follows up an ABSENT file with a live Maven
#                      effective-configuration check before failing for real.
#                      Without this flag (the default, and what every fixture
#                      test below exercises), absence fails closed: exit 1.
#
# Exit codes:
#   0 — every declaration found is >= minimum and internally consistent.
#   1 — at least one declaration is below the minimum, declarations within a
#       single file conflict, a declared value is unparseable, or (default,
#       --allow-absent not given) no declaration was found anywhere.
#   2 — only reachable with --allow-absent: no declared value was found in
#       any scanned file, but nothing was found to be actively wrong either;
#       the caller must resolve the effective value another way.
# =============================================================================
set -uo pipefail

ROOT="."
MINIMUM=25
ALLOW_ABSENT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --minimum) MINIMUM="$2"; shift 2 ;;
    --allow-absent) ALLOW_ABSENT=1; shift ;;
    -h|--help)
      sed -n '2,45p' "$0"
      exit 0
      ;;
    *)
      echo "[jdk25-guard] Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if ! [[ "$MINIMUM" =~ ^[0-9]+$ ]]; then
  echo "[jdk25-guard] --minimum must be a positive integer, got: $MINIMUM" >&2
  exit 1
fi

if [ ! -d "$ROOT" ]; then
  echo "[jdk25-guard] Root directory does not exist: $ROOT" >&2
  exit 1
fi

# ── Discover every pom.xml and toolchains.xml under ROOT ────────────────────
mapfile -t POM_FILES < <(find "$ROOT" \
  \( -path '*/target/*' -o -path '*/.git/*' -o -path '*/node_modules/*' \) -prune -o \
  \( -name 'pom.xml' -o -name 'toolchains.xml' \) -type f -print | sort)

if [ "${#POM_FILES[@]}" -eq 0 ]; then
  echo "[jdk25-guard] No pom.xml or toolchains.xml found under $ROOT — nothing to check."
  exit 0
fi

# ── Extract every Java-version-relevant declaration from one file ───────────
# Emits "LINE<TAB>TAG<TAB>RAWVALUE" per match, one per line, to stdout.
collect_declarations() {
  local file="$1"
  # Simple single-line tags with numeric-or-${property} content only — this
  # deliberately excludes unrelated same-named tags (e.g. an assembly
  # plugin's <source> pointing at a file path) which never hold a bare
  # number or property reference here in practice.
  grep -nE '<(maven\.compiler\.release|maven\.compiler\.source|maven\.compiler\.target|release|source|target)>[[:space:]]*(\$\{[A-Za-z0-9_.]+\}|[0-9]+(\.[0-9]+)?)[[:space:]]*</\1>' "$file" \
    | sed -E 's/^([0-9]+):[[:space:]]*<([a-zA-Z0-9_.]+)>[[:space:]]*(.*[^[:space:]])[[:space:]]*<\/\2>.*/\1\t\2\t\3/'

  # Toolchain requirement: a <jdk>...<version>N</version>...</jdk> block,
  # either inside maven-toolchains-plugin config in pom.xml or in a
  # standalone toolchains.xml. awk tracks the innermost <jdk> block by line
  # range so a <version> outside any <jdk> block (e.g. the plugin's own
  # <version>3.1.0</version>) is never mistaken for a toolchain requirement.
  awk '
    /<jdk>/ { in_jdk = 1 }
    /<\/jdk>/ { in_jdk = 0 }
    in_jdk && match($0, /<version>[[:space:]]*([0-9]+(\.[0-9]+)?|\$\{[A-Za-z0-9_.]+\})[[:space:]]*<\/version>/) {
      val = $0
      sub(/.*<version>[[:space:]]*/, "", val)
      sub(/[[:space:]]*<\/version>.*/, "", val)
      printf "%d\ttoolchain-jdk-version\t%s\n", NR, val
    }
  ' "$file"
}

# ── Resolve a raw declared value to a plain integer, or empty if unresolvable ─
# Handles legacy "1.N" notation (1.8 -> 8) and same-file ${property}
# references to maven.compiler.release/source/target/java.version, resolved
# against the properties already collected for this same file.
resolve_value() {
  local raw="$1"
  local -n props_ref="$2"
  local v="$raw"
  if [[ "$v" =~ ^\$\{([A-Za-z0-9_.]+)\}$ ]]; then
    local prop="${BASH_REMATCH[1]}"
    v="${props_ref[$prop]:-}"
    [ -z "$v" ] && { echo ""; return; }
  fi
  if [[ "$v" =~ ^1\.([0-9]+)$ ]]; then
    v="${BASH_REMATCH[1]}"
  fi
  if [[ "$v" =~ ^[0-9]+$ ]]; then
    echo "$v"
  else
    echo ""
  fi
}

OVERALL_FAIL=0
FINDINGS=()
ABSENT_FILES=()

for file in "${POM_FILES[@]}"; do
  declarations="$(collect_declarations "$file")"

  # Pass 1: build a same-file property lookup (maven.compiler.* / java.version
  # properties) so ${property}-interpolated <source>/<target>/<release>
  # values used elsewhere in the SAME file can be resolved.
  declare -A PROPS=()
  if [ -n "$declarations" ]; then
    while IFS=$'\t' read -r _line tag rawval; do
      case "$tag" in
        maven.compiler.release|maven.compiler.source|maven.compiler.target)
          PROPS["$tag"]="$rawval"
          PROPS["java.version"]="${PROPS[java.version]:-$rawval}"
          ;;
      esac
    done <<< "$declarations"
  fi
  # java.version itself may be declared directly (not just via compiler.*
  # properties) — pick it up too so a same-file ${java.version} reference
  # resolves correctly regardless of which property actually carries it.
  java_version_line="$(grep -nE '<java\.version>[[:space:]]*[0-9]+[[:space:]]*</java\.version>' "$file" | head -1 || true)"
  if [ -n "$java_version_line" ]; then
    PROPS["java.version"]="$(echo "$java_version_line" | sed -E 's/.*<java\.version>[[:space:]]*([0-9]+).*/\1/')"
  fi

  declare -A SEEN_VALUES=()
  file_has_declaration=0

  if [ -n "$declarations" ]; then
    while IFS=$'\t' read -r line tag rawval; do
      [ -z "${line:-}" ] && continue
      file_has_declaration=1
      resolved="$(resolve_value "$rawval" PROPS)"
      if [ -z "$resolved" ]; then
        FINDINGS+=("FAIL  $file:$line  $tag = '$rawval'  (unparseable — cannot confirm >= $MINIMUM)")
        OVERALL_FAIL=1
        continue
      fi
      SEEN_VALUES["$resolved"]=1
      if [ "$resolved" -lt "$MINIMUM" ]; then
        FINDINGS+=("FAIL  $file:$line  $tag = $resolved  (< $MINIMUM)")
        OVERALL_FAIL=1
      else
        FINDINGS+=("ok    $file:$line  $tag = $resolved")
      fi
    done <<< "$declarations"
  fi

  distinct_count="${#SEEN_VALUES[@]}"
  if [ "$file_has_declaration" -eq 1 ] && [ "$distinct_count" -gt 1 ]; then
    values_csv="$(printf '%s,' "${!SEEN_VALUES[@]}")"
    FINDINGS+=("FAIL  $file  CONFLICTING declarations disagree: ${values_csv%,} — an in-file Java-version declaration must be internally consistent")
    OVERALL_FAIL=1
  fi

  # Tracked PER FILE, not just globally: a repo where module A declares 25
  # and module B declares nothing must still flag module B, even though
  # "some declaration exists in this repo" is true overall. Silently trusting
  # a quiet file next to a compliant one is exactly the escape hatch a
  # fail-closed guard must not have.
  #
  # EXCEPTION: a pure aggregator (explicit <packaging>pom</packaging>)
  # compiles no source of its own — kooker-service-user's and
  # kooker-service-games's root pom.xml are exactly this shape in practice —
  # so it is not required to declare (or be effective-checked for) a Java
  # version. Only checked when the file itself declares nothing; a pom-
  # packaged file that DOES set compiler properties for its children to
  # inherit (kooker-parent-build's own pattern) is still fully validated
  # above like any other file.
  if [ "$file_has_declaration" -eq 0 ]; then
    packaging="$(grep -oE '<packaging>[a-zA-Z-]+</packaging>' "$file" | head -1 | sed -E 's/<[^>]+>//g')"
    if [ "$packaging" = "pom" ]; then
      FINDINGS+=("skip  $file  packaging=pom aggregator with no declaration of its own — not required to declare a Java version")
    else
      ABSENT_FILES+=("$file")
    fi
  fi

  unset PROPS SEEN_VALUES
done

echo "[jdk25-guard] Scanned ${#POM_FILES[@]} file(s) under $ROOT (minimum required: Java $MINIMUM)"
for f in "${FINDINGS[@]}"; do
  echo "[jdk25-guard] $f"
done

# A decisive failure (below-minimum, conflicting, or unparseable) always wins,
# regardless of whether other files in the same repo are silent — the build
# must not pass just because SOME module happened to be fine.
if [ "$OVERALL_FAIL" -eq 1 ]; then
  echo "[jdk25-guard] FAIL — one or more declarations violate the Java $MINIMUM baseline. See findings above."
  exit 1
fi

if [ "${#ABSENT_FILES[@]}" -gt 0 ]; then
  for f in "${ABSENT_FILES[@]}"; do
    echo "[jdk25-guard] absent  $f  declares no Java version of its own"
  done
  if [ "$ALLOW_ABSENT" -eq 1 ]; then
    echo "[jdk25-guard] ${#ABSENT_FILES[@]} file(s) under $ROOT declare no Java version — deferring to the effective-configuration check (--allow-absent)."
    exit 2
  fi
  echo "[jdk25-guard] FAIL — ${#ABSENT_FILES[@]} file(s) under $ROOT declare no Java version. Fail-closed: an in-scope Maven project must explicitly declare its Java baseline."
  exit 1
fi

echo "[jdk25-guard] PASS — every declared Java version is >= $MINIMUM and internally consistent."
exit 0
