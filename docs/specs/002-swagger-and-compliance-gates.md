# Specification 002 — Swagger & Compliance Gates

**Status:** ACTIVE  
**Scope:** `.github/workflows/swagger-enforce.yml`, `.github/workflows/jdk25-baseline-guard.yml`, `scripts/check-jdk25-baseline.sh`, `.github/workflows/flyway-lint.yml`, `scripts/lint-migrations.sh`.

## 1. `swagger-enforce.yml` (Fail-Closed OpenAPI & JDK 25 Gate)
- **Baseline:** `inputs.java-version` defaults to `'25'`; values non-numeric or `< 25` fail closed (`exit 1`) before `setup-java`.
- **Secrets:** Accepts optional `MAVEN_PUBLISH_TOKEN` (`required: false`) for GitHub Packages (`server-id: github`), falling back to `github.token`.
- **Fail-Closed OpenAPI Validation:**
  - Requires a non-empty regular non-symlink `target/openapi/openapi.json` or `target/openapi.json` (or module `<mod>/target/...`). Empty `target/openapi/` directories or unrelated `target/*.json` files fail `exit 1`.
  - Strictly parses JSON and requires `openapi` (`^3\.\d+(\.\d+)?$`) or `swagger` (`^2\.0$`), non-empty `info.title`/`info.version`, and non-empty `paths`.
  - Requires non-empty `components.securitySchemes` (or `securityDefinitions`) using strong authentication (`http` `bearer`, `oauth2`, `openIdConnect`, `mutualTLS`, or `apiKey` in `header`/`cookie`). Rejects plaintext `http` `basic` and `query`-parameter `apiKey`.
  - Requires valid global `security` or per-operation `security` (rejecting empty `{}` or `[]` overrides on protected paths).
  - Scans `src/main/resources/application*.y*ml` and `application*.properties` (if present) and fails closed if `springdoc.swagger-ui.enabled` or `springdoc.api-docs.enabled` is `true`.

## 2. `jdk25-baseline-guard.yml` & `scripts/check-jdk25-baseline.sh`
- **Layer 1 (Static):** Strips single-line and multi-line XML comments (`<!-- ... -->`) before scanning `<maven.compiler.*>`, `<release>/<source>/<target>`, `<java.version>`, `<packaging>`, and single- or multi-line `<jdk><version>...</version></jdk>` blocks. Rejects values `< minimum` (`--minimum >= 1`), conflicting values within a file, and absent non-aggregator POMs (`exit 2` with `--allow-absent`, `exit 1` without).
- **Layer 2 (Effective):** Runs `mvn help:evaluate` when Layer 1 returns `2`, skipping pure `packaging=pom` aggregators without compiler properties and failing closed if any non-aggregator POM resolves `< minimum` or resolves to nothing.
- **Inputs:** `minimum-java-version` (`>= 25`) and `workflows-ref` are validated via `env:` before use; `workflows-ref` defaults to `github.workflow_sha`.

## 3. `flyway-lint.yml` & `scripts/lint-migrations.sh`
- Validates `migration-path` via `env:` before use; fails closed if `origin/${GITHUB_BASE_REF}` is expected but missing.
- Scans all `*.sql` files via `-print0` for `V<N>__<description>.sql` naming.
- Scans every line including final lines lacking a trailing LF (`while IFS= read -r line || [ -n "$line" ]`), strips single-line `--` and multi-line `/* ... */` comments, honors `-- kooker:allow-breaking`, and blocks destructive DDL (`DROP TABLE/COLUMN`, `RENAME`, `TRUNCATE`, `ALTER ... DROP/MODIFY/CHANGE`).
- Validates ALL `application-migrator.yml` and `application-migrator.yaml` files (`spring.cloud.config.enabled: false`, `eureka.client.enabled: false`, `management.endpoints.enabled-by-default: false`).

## 4. Verification
- `bash tests/check-swagger-enforce.test.sh`
- `bash tests/check-jdk25-baseline.test.sh`
- `node tests/check-jdk25-workflow.test.cjs`
- `bash tests/check-flyway-lint.test.sh`
