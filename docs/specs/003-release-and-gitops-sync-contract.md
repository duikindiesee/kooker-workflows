# Specification 003 — Release & GitOps Sync Contract

**Status:** ACTIVE  
**Scope:** `node-version-bump.yml`, `maven-version-bump.yml`, `android-version-bump.yml`, `auto-version.yml`, `gitops-sync.yml`, `ghcr-retention.yml`, `neo4j-delta-cache.yml`, `grafana-dashboards.yml`, and `scripts/lib/kustomize-digest.js`.

## 1. Dual-Identity Version Bump Workflows
- `node-version-bump.yml`, `maven-version-bump.yml`, and `android-version-bump.yml` enforce `chore(release):` loop prevention and strict `MAJOR.MINOR.PATCH` semver validation before arithmetic.
- `node-version-bump.yml` and `maven-version-bump.yml` restrict commits strictly to package/POM metadata (`package.json`, `package-lock.json`, `pom.xml`, `postman/specs/openapi.yaml`), aborting and resetting HEAD if hooks or tools alter unrelated paths.
- `android-version-bump.yml` validates `app-dir` as a clean relative directory, updates both single- and double-quoted `versionName`, and verifies post-edit file mutation.
- PR number and new version outputs are bound strictly via `env:` in auto-merge, approval, and release steps.

## 2. `auto-version.yml`
- Exposes optional `has-db-changes` (`'true'` | `'false'`, default `'false'`) matching caller `flyway-lint` outputs:
  - `has-db-changes=true` increments/creates 4-part micro tag `vX.Y.Z.N`.
  - `has-db-changes=false` increments patch `vX.Y.(Z+1)`.
- Validates tag format (`^v[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?$`) and pushes via ephemeral `GIT_ASKPASS`.

## 3. `gitops-sync.yml` & CityLife Adoption Lock (`D01`–`D22`)
- Enforces `check-adoption-lock.sh` / inline release-hold barrier on `manifests/overlays/develop/citylife` and `manifests/overlays/develop/citylife-server` across all canonicalized path spellings before any mutation, PR creation, or approval.
- In `digest` mode (`duikindiesee/sportifine-server` only), verifies remote root OCI manifest digest under bounded 30s timeout and 64KB/16KB output caps, verifies reusable workflow identity via `github.workflow_ref` + `github.workflow_sha` and checked-out `.shared-workflows` HEAD, renders pre/post Kustomize manifests via `scripts/update-gitops-digest.mjs`, and rolls back atomically on unrelated mutation.
- In `tag` mode, validates `kustomize_path` and `target_branch`, verifies `kustomization.yaml` is not a symlink, quotes paths and image arguments (`cd -- "$TARGET_CANONICAL"`, `kustomize edit set image "${IMAGE_NAME}=${IMAGE_NAME}:${NEW_TAG}"`), scopes `git add -- "${CANONICAL_KUSTOMIZE_PATH}"`, validates single-line `https://` `$PR_URL`, and enforces dual-identity PR creation (`MAVEN_PUBLISH_TOKEN`) + approval/merge (`GITOPS_APPROVER_TOKEN`).

## 4. Operational & Retention Workflows
- `ghcr-retention.yml`: protects semver tags against deletion, validates owner/package segments against `.`/`..` traversal, restricts plaintext `http:` strictly to loopback test hosts, and caps `ignore-versions` regex length at 256 characters.
- `neo4j-delta-cache.yml`: enforces `https://` (or loopback `http://` for tests), stores temp files in `mktemp -d "${RUNNER_TEMP:-/tmp}/neo4j-delta-XXXXXX"` cleaned by `if: always()`, passes basic auth via `0600` `--config` file (never `-u` argv), serializes file contents via `sys.argv[1]`, and fails closed on non-2xx HTTP responses or Neo4j errors.
- `grafana-dashboards.yml`: validates `KOOKER_GRAFANA_PAT` and non-symlink `load-grafana-dashboards.ps1` with `$ErrorActionPreference = 'Stop'` and `$LASTEXITCODE` propagation.

## 5. Verification
- `bash tests/check-node-version-bump.test.sh`, `node tests/check-node-merge-trigger.cjs`, `node tests/check-node-release-optout.cjs`
- `bash tests/check-version-bumps.test.sh`
- `bash tests/check-adoption-lock.test.sh`, `node tests/check-gitops-digest.test.cjs`, `node tests/check-gitops-digest-integration.cjs`
- `node tests/check-ghcr-retention.test.cjs`, `bash tests/check-neo4j-delta-cache.test.sh`, `node tests/check-misc-workflows.test.cjs`
