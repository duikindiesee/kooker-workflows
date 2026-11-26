#!/usr/bin/env bash
# =============================================================================
# check-swagger-enforce.test.sh — unit & fail-closed regression tests for
# .github/workflows/swagger-enforce.yml
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKFLOW="$REPO_ROOT/.github/workflows/swagger-enforce.yml"

TMP="$(mktemp -d 2>/dev/null || mktemp -d -t 'swagger-enforce-test.XXXXXX')"
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

INPUT_SCRIPT="$TMP/validate_inputs.sh"
OPENAPI_SCRIPT="$TMP/validate_openapi.sh"
extract_step "Validate workflow inputs" "$INPUT_SCRIPT"
extract_step "Validate generated OpenAPI spec and security controls (fail closed)" "$OPENAPI_SCRIPT"

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

echo "=== 1. Java version baseline & injection checks ==="
assert_exit "default java-version 25 passes" 0 env INPUT_JAVA_VERSION="25" bash "$INPUT_SCRIPT"
assert_exit "java-version 26 passes" 0 env INPUT_JAVA_VERSION="26" bash "$INPUT_SCRIPT"
assert_exit "java-version 21 rejected" 1 env INPUT_JAVA_VERSION="21" bash "$INPUT_SCRIPT"
assert_exit "java-version 24 rejected" 1 env INPUT_JAVA_VERSION="24" bash "$INPUT_SCRIPT"
assert_exit "java-version injection rejected" 1 env INPUT_JAVA_VERSION="25; touch pwned" bash "$INPUT_SCRIPT"
assert_exit "java-version empty rejected" 1 env INPUT_JAVA_VERSION="" bash "$INPUT_SCRIPT"

echo "=== 2. Fail-closed OpenAPI presence & JSON parsing checks ==="
run_in_fixture() {
  local dir="$1"
  (cd "$dir" && bash "$OPENAPI_SCRIPT")
}

# 2a. Missing openapi.json
F_MISSING="$TMP/missing"
mkdir -p "$F_MISSING/target"
assert_exit "missing openapi.json fails closed" 1 run_in_fixture "$F_MISSING"

# 2b. Empty target/openapi/ directory
F_EMPTY_DIR="$TMP/empty-dir"
mkdir -p "$F_EMPTY_DIR/target/openapi"
assert_exit "empty target/openapi dir fails closed" 1 run_in_fixture "$F_EMPTY_DIR"

# 2c. Unrelated target/*.json
F_UNRELATED="$TMP/unrelated-json"
mkdir -p "$F_UNRELATED/target"
printf '{"unrelated":true}\n' > "$F_UNRELATED/target/other.json"
assert_exit "unrelated target/other.json fails closed" 1 run_in_fixture "$F_UNRELATED"

# 2d. Empty openapi.json
F_EMPTY_FILE="$TMP/empty-file"
mkdir -p "$F_EMPTY_FILE/target/openapi"
: > "$F_EMPTY_FILE/target/openapi/openapi.json"
assert_exit "empty openapi.json fails closed" 1 run_in_fixture "$F_EMPTY_FILE"

# 2e. Malformed JSON
F_MALFORMED="$TMP/malformed"
mkdir -p "$F_MALFORMED/target"
printf '{not valid json' > "$F_MALFORMED/target/openapi.json"
assert_exit "malformed openapi.json fails closed" 1 run_in_fixture "$F_MALFORMED"

echo "=== 3. OpenAPI security scheme & Springdoc exposure checks ==="
# 3a. Missing securitySchemes
F_NO_SEC="$TMP/no-sec"
mkdir -p "$F_NO_SEC/target"
cat > "$F_NO_SEC/target/openapi.json" <<'JSON'
{
  "openapi": "3.0.1",
  "info": { "title": "Test API", "version": "1.0.0" },
  "paths": { "/api/items": { "get": { "responses": { "200": { "description": "ok" } } } } }
}
JSON
assert_exit "OpenAPI without securitySchemes fails closed" 1 run_in_fixture "$F_NO_SEC"

# 3b. Plaintext HTTP Basic rejected
F_BASIC="$TMP/basic-sec"
mkdir -p "$F_BASIC/target"
cat > "$F_BASIC/target/openapi.json" <<'JSON'
{
  "openapi": "3.0.1",
  "info": { "title": "Test API", "version": "1.0.0" },
  "components": {
    "securitySchemes": { "basicAuth": { "type": "http", "scheme": "basic" } }
  },
  "security": [{ "basicAuth": [] }],
  "paths": { "/api/items": { "get": { "responses": { "200": { "description": "ok" } } } } }
}
JSON
assert_exit "plaintext HTTP Basic securityScheme fails closed" 1 run_in_fixture "$F_BASIC"

# 3c. Query-parameter apiKey rejected
F_QUERY_KEY="$TMP/query-key"
mkdir -p "$F_QUERY_KEY/target"
cat > "$F_QUERY_KEY/target/openapi.json" <<'JSON'
{
  "openapi": "3.0.1",
  "info": { "title": "Test API", "version": "1.0.0" },
  "components": {
    "securitySchemes": { "qKey": { "type": "apiKey", "in": "query", "name": "api_key" } }
  },
  "security": [{ "qKey": [] }],
  "paths": { "/api/items": { "get": { "responses": { "200": { "description": "ok" } } } } }
}
JSON
assert_exit "query apiKey securityScheme fails closed" 1 run_in_fixture "$F_QUERY_KEY"

# 3d. Operation overrides security: [] on protected endpoint
F_ANON_OP="$TMP/anon-op"
mkdir -p "$F_ANON_OP/target"
cat > "$F_ANON_OP/target/openapi.json" <<'JSON'
{
  "openapi": "3.0.1",
  "info": { "title": "Test API", "version": "1.0.0" },
  "components": {
    "securitySchemes": { "bearerAuth": { "type": "http", "scheme": "bearer", "bearerFormat": "JWT" } }
  },
  "security": [{ "bearerAuth": [] }],
  "paths": {
    "/api/admin/users": { "get": { "security": [], "responses": { "200": { "description": "ok" } } } }
  }
}
JSON
assert_exit "operation overriding security: [] fails closed" 1 run_in_fixture "$F_ANON_OP"

# 3e. Valid OpenAPI 3.0 with bearer JWT + disabled springdoc passes
F_VALID="$TMP/valid"
mkdir -p "$F_VALID/target/openapi" "$F_VALID/src/main/resources"
cat > "$F_VALID/target/openapi/openapi.json" <<'JSON'
{
  "openapi": "3.0.3",
  "info": { "title": "Kooker Service", "version": "1.0.0" },
  "components": {
    "securitySchemes": { "bearerAuth": { "type": "http", "scheme": "bearer", "bearerFormat": "JWT" } }
  },
  "security": [{ "bearerAuth": [] }],
  "paths": {
    "/api/v1/items": { "get": { "responses": { "200": { "description": "ok" } } } }
  }
}
JSON
cat > "$F_VALID/src/main/resources/application.yml" <<'YAML'
springdoc:
  swagger-ui:
    enabled: false
  api-docs:
    enabled: false
YAML
assert_exit "valid OpenAPI 3.0 + disabled springdoc passes" 0 run_in_fixture "$F_VALID"

# 3f. Exposed springdoc.swagger-ui.enabled: true fails closed
F_SPRINGDOC_YML="$TMP/springdoc-yml"
cp -R "$F_VALID" "$F_SPRINGDOC_YML"
cat > "$F_SPRINGDOC_YML/src/main/resources/application.yml" <<'YAML'
springdoc:
  swagger-ui:
    enabled: true
YAML
assert_exit "springdoc.swagger-ui.enabled: true in application.yml fails closed" 1 run_in_fixture "$F_SPRINGDOC_YML"

# 3g. Exposed springdoc.api-docs.enabled=true in .properties fails closed
F_SPRINGDOC_PROPS="$TMP/springdoc-props"
cp -R "$F_VALID" "$F_SPRINGDOC_PROPS"
rm -f "$F_SPRINGDOC_PROPS/src/main/resources/application.yml"
printf 'springdoc.api-docs.enabled=true\n' > "$F_SPRINGDOC_PROPS/src/main/resources/application-prod.properties"
assert_exit "springdoc.api-docs.enabled=true in properties fails closed" 1 run_in_fixture "$F_SPRINGDOC_PROPS"

echo "=== Summary: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
