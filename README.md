# kooker-workflows

Reusable GitHub Actions workflows for the [Kooker](https://github.com/duikindiesee) ecosystem.

> [!IMPORTANT]
> **This repository must remain public.**
> GitHub's reusable workflow rules only allow *private* repositories to call reusable workflows
> from the **same repository**. Cross-repository calls — even within the same org — require the
> workflow source to be either **public** (all GitHub plans) or **internal** (GitHub Enterprise Cloud only).
> `kooker-workflows` contains no secrets or proprietary code; keeping it public is safe and is the
> standard pattern for shared workflow libraries.

## Documentation

- [Documentation Index](docs/README.md)
- [Security Architecture & Mermaid UML Diagrams](docs/security-architecture.md)
- [Specifications Index](docs/specs/README.md) (`001` Security Contract · `002` Swagger & Compliance Gates · `003` Release & GitOps Sync)
- [JDK 25 Maven Baseline Adoption Manifest](docs/jdk25-baseline-adoption.md)

---

## Workflows (12)

### `maven-version-bump.yml` — Maven / Spring Boot version bump

Bumps `pom.xml` (and `postman/specs/openapi.yaml` if present) via a dual-identity PR on merge to `main` based on Conventional Commits.

| Commit prefix | Bump | Example |
|---|---|---|
| `fix:` / `chore:` / `ci:` / `docs:` / `refactor:` / `test:` | PATCH (minimum bump on non-release merge) | `1.0.0 → 1.0.1` |
| `feat:` | MINOR | `1.0.0 → 1.1.0` |
| `feat!:` / `BREAKING CHANGE` | MAJOR | `1.0.0 → 2.0.0` |
| DB migration (`db/migration/*.sql` or `flyway`) | PATCH | `1.0.0 → 1.0.1` |

Loop prevention: commits starting with `chore(release):` are skipped.

**Inputs:** `java-version` (optional, default `'25'`)  
**Secrets:** `MAVEN_PUBLISH_TOKEN` (GitHub Packages), `GITOPS_APPROVER_TOKEN` (separate PR approver), `GITHUB_TOKEN`  
**Outputs:** `new-version`, `bumped`

```yaml
jobs:
  version-bump:
    uses: duikindiesee/kooker-workflows/.github/workflows/maven-version-bump.yml@<commit-sha>
    secrets: inherit
```

---

### `node-version-bump.yml` — Node.js / Frontend version bump

Bumps `package.json` (and tracked `package-lock.json`) via a dual-identity PR on merge to `main`, verifying that hooks/tools never modify non-package paths (`abort_bump_commit`).

**Inputs:** `create-release` (boolean, optional, default `true`)  
**Secrets:** `MAVEN_PUBLISH_TOKEN` (PR author), `GITOPS_APPROVER_TOKEN` (PR approver), `GITHUB_TOKEN`  
**Outputs:** `new-version`, `bumped`

```yaml
jobs:
  version-bump:
    uses: duikindiesee/kooker-workflows/.github/workflows/node-version-bump.yml@<commit-sha>
    secrets: inherit
```

---

### `android-version-bump.yml` — Android version bump

Bumps `versionName` and `versionCode` in `{app-dir}/app/build.gradle` based on Conventional Commits (`MAJOR×100 + MINOR×10 + PATCH`).

**Inputs:**

| Input | Required | Description |
|---|---|---|
| `app-dir` | ✅ | Clean relative subdirectory containing the Android project |

**Outputs:** `new-version`, `new-version-code`, `bumped`

```yaml
jobs:
  version-bump:
    uses: duikindiesee/kooker-workflows/.github/workflows/android-version-bump.yml@<commit-sha>
    with:
      app-dir: my-app
    secrets: inherit
```

---

### `flyway-lint.yml` — Flyway migration detector

Detects new or modified SQL migration files in a PR or push, validates naming (`V<N>__<description>.sql`), blocks destructive SQL DDL (including final lines without trailing LF and code outside `/* ... */` block comments), and validates all `application-migrator.y*ml` files. Also ships `scripts/lint-migrations.sh` for advisory local pre-commit checks (`KOOKER_LINT_MODE=warn` or `error`).

**Scope & limitations:**

- Scans added/modified files under one configured relative `migration-path` (PRs fail closed if `origin/${GITHUB_BASE_REF}` is unavailable; pushes inspect `HEAD~1..HEAD`, so deleted files and earlier commits in a multi-commit push are not covered by that diff, and a missing `migration-path` directory skips the naming check).
- Breaking-pattern detection is line-based: multi-line `ALTER TABLE` statements or alternate syntax (`MODIFY` without `COLUMN`) require human review, and an inline `-- kooker:allow-breaking` comment suppresses that line without automated ticket/approver verification.
- Reusable workflow availability is separate from per-service adoption, path filters, and branch-protection required checks.

**Additive-only policy & expand/contract review guidance:**

- Compatible `CREATE` and `ALTER TABLE ... ADD` are additive operations; review defaults, nullability, constraints, locking, and old-reader compatibility before merge.
- Preserve applied migration history — introduce a new reviewed migration rather than rewriting or deleting applied files.
- Follow expand → preserve old-reader compatibility → bounded backfill → switch readers → separately approved contract-phase removal; type changes, renames, removals, truncation, and destructive DML require explicit compatibility, data-retention, and rollback assessment.

**Inputs:**

| Input | Required | Default | Description |
|---|---|---|---|
| `migration-path` | ❌ | `src/main/resources/db/migration` | Relative path to Flyway migrations directory |

**Outputs:** `has_db_changes` (`'true'` / `'false'`)

```yaml
jobs:
  flyway-lint:
    uses: duikindiesee/kooker-workflows/.github/workflows/flyway-lint.yml@<commit-sha>
    with:
      migration-path: my-module/src/main/resources/db/migration
```

---

### `jdk25-baseline-guard.yml` — JDK 25 Maven baseline guard

Fails a pull request before any build/package/release work begins when an in-scope Maven project's configured `release`/`source`/`target`/toolchain drops below the org baseline (default `25`). Combines offline static scanning (`scripts/check-jdk25-baseline.sh`) with live `mvn help:evaluate` effective-POM resolution when POMs inherit from `kooker-parent-build`.

**Inputs:**

| Input | Required | Default | Description |
|---|---|---|---|
| `minimum-java-version` | ❌ | `25` | Minimum acceptable Java version (`>= 25`) |
| `workflows-ref` | ❌ | `''` (`github.workflow_sha`) | `kooker-workflows` ref to source the guard script from |

**Outputs:** `result` (`'pass'` / `'fail'`)  
**Secrets:** `MAVEN_PUBLISH_TOKEN` (optional; used for effective-POM resolution against GitHub Packages)

```yaml
jobs:
  jdk25-guard:
    uses: duikindiesee/kooker-workflows/.github/workflows/jdk25-baseline-guard.yml@<commit-sha>
```

---

### `auto-version.yml` — Auto tag on merge to main

Tags the repo with a semver version on merge and creates a GitHub Release. Distinguishes DB changes (`vX.Y.Z.N`) from regular patch bumps (`vX.Y.(Z+1)`).

**Inputs:**

| Input | Required | Default | Description |
|---|---|---|---|
| `has-db-changes` | ❌ | `'false'` | Pass `'true'` / `'false'` output of `flyway-lint` |

**Outputs:** `version`

```yaml
jobs:
  tag:
    uses: duikindiesee/kooker-workflows/.github/workflows/auto-version.yml@<commit-sha>
    with:
      has-db-changes: ${{ needs.flyway-lint.outputs.has_db_changes }}
    secrets: inherit
```

---

### `swagger-enforce.yml` — OpenAPI / Swagger validation (fail-closed)

Enforces JDK 25+, runs `mvn clean verify -DskipTests`, and fails closed if `openapi.json` is missing/empty/malformed, lacks strong `components.securitySchemes` / operation security, or leaves `springdoc.swagger-ui.enabled` / `springdoc.api-docs.enabled` enabled in Spring configs.

**Inputs:**

| Input | Required | Default | Description |
|---|---|---|---|
| `java-version` | ❌ | `'25'` | JDK version (`>= 25`) |

**Secrets:** `MAVEN_PUBLISH_TOKEN` (optional, `required: false`)

```yaml
jobs:
  validate:
    uses: duikindiesee/kooker-workflows/.github/workflows/swagger-enforce.yml@<commit-sha>
    secrets: inherit
```

---

### `ghcr-retention.yml` — Centralized container image retention (semver protected)

Prunes old untagged and transient branch image versions from GHCR while strictly protecting semver release tags (`^v?[0-9]+\.[0-9]+\.[0-9]+$`).

**Inputs:**

| Input | Required | Default | Description |
|---|---|---|---|
| `package-name` | ❌ | calling repo name | GHCR container package name |
| `min-versions-to-keep` | ❌ | `60` | Minimum newest versions to keep |
| `ignore-versions` | ❌ | `^v?[0-9]+\.[0-9]+\.[0-9]+$` | Regex of tags to preserve (max 256 chars) |

**Secrets:** `MAVEN_PUBLISH_TOKEN` (required write token for package deletion)

---

### `gitops-sync.yml` — GitOps deployment PR automation (tag & digest binding)

Automates container image promotion into `kooker-infra` via pull requests. Enforces the CityLife multiplayer adoption lock (`scripts/check-adoption-lock.sh`) and supports canonical manifest digest binding (`scripts/update-gitops-digest.mjs` + `scripts/lib/kustomize-digest.js`).

**Inputs:**

| Input | Required | Default | Description |
|---|---|---|---|
| `image_name` | ✅ | — | Base container image name (`ghcr.io/<org>/<repo>`) |
| `new_tag` | ✅ | — | Tag to deploy or verify |
| `new_digest` | ❌ | `''` | Optional canonical manifest digest (`sha256:64hex`) |
| `kustomize_path` | ✅ | — | Relative path within `kooker-infra` to overlay directory |
| `target_branch` | ❌ | `main` | Base branch of the deploy PR in `kooker-infra` |

**Secrets:** `MAVEN_PUBLISH_TOKEN` (PR author), `GITOPS_APPROVER_TOKEN` (PR approver)

#### Digest Binding Acceptance Matrix (`D01`–`D22`)

- **Integrated Primary Suite (`tests/check-gitops-digest-integration.cjs`)**: Executes parsed production step bodies, Kustomize rendering, canonical path checks, and `scripts/update-gitops-digest.mjs`.
- **Supplementary Unit Checks (`tests/check-gitops-digest.test.cjs`)**: Fast offline unit checks covering `D01`–`D22`.

---

### `neo4j-delta-cache.yml` — Neo4j commit & file delta sync

Syncs commit metadata and changed files into Neo4j over HTTPS using isolated `RUNNER_TEMP` workspaces, `sys.argv[1]` file serialization, and `0600` curl config credentials.

**Inputs:** `neo4j_base_url` (required `https://`), `repo_name`, `base_sha`, `head_sha`, `commit_message`, `memory_bank_path`, `memory_bank_node_name`  
**Secrets:** `NEO4J_USERNAME`, `NEO4J_PASSWORD`

---

### `grafana-dashboards.yml` — Grafana dashboard loader gate

Fail-closed Windows (`pwsh`) wrapper validating `KOOKER_GRAFANA_PAT` and non-symlinked `load-grafana-dashboards.ps1` in calling repositories.

**Secrets:** `KOOKER_GRAFANA_PAT` (required)

---

### `self-test.yml` — Repository self-test & lint gate

Runs on every push and pull request (`permissions: contents: read`), installs pinned test dependencies with `--ignore-scripts`, executes all `tests/*.test.sh` and `tests/*.cjs` suites, and runs `rhysd/actionlint:1.7.7`.

---

## Organisation Setup (Least Privilege)

1. `Settings → Actions → General → Actions permissions`: **Allow select or reusable workflows** (or organization-approved actions).
2. `Settings → Actions → General → Workflow permissions`:
   - **Read repository contents and packages permissions** (least privilege by default).
   - Every reusable workflow in `kooker-workflows` declares `permissions: {}` at top level and grants only the exact job-level scope it requires.
   - Where branch-protected bump/GitOps PRs require automated approval, use dedicated non-author approver credentials (`GITOPS_APPROVER_TOKEN`) rather than weakening branch protection.

---

## Adding a New Workflow

1. Create `.github/workflows/<name>.yml` following [Specification 001](docs/specs/001-reusable-workflow-security-contract.md) (`permissions: {}`, SHA-pinned actions, `persist-credentials: false`, `env:` input binding, `set -euo pipefail`).
2. Add automated positive & negative tests in `tests/` and wire them into `.github/workflows/self-test.yml`.
3. Document inputs, outputs, and secrets in this README and update `docs/README.md` / `docs/specs/`.
4. Verify `actionlint`, all `tests/*.test.sh` / `tests/*.cjs`, and `gitleaks` pass before opening a PR.
