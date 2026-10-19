# kooker-workflows

Reusable GitHub Actions workflows for the [Kooker](https://github.com/duikindiesee) ecosystem.

> [!IMPORTANT]
> **This repository must remain public.**
> GitHub's reusable workflow rules only allow *private* repositories to call reusable workflows
> from the **same repository**. Cross-repository calls — even within the same org — require the
> workflow source to be either **public** (all GitHub plans) or **internal** (GitHub Enterprise Cloud only).
> `kooker-workflows` contains no secrets or proprietary code; keeping it public is safe and is the
> standard pattern for shared workflow libraries.

---

## Workflows

### `maven-version-bump.yml` — Maven / Spring Boot version bump

Bumps `pom.xml` version on every merge to `main` based on the Conventional Commit prefix.

| Commit prefix | Bump | Example |
|---|---|---|
| `fix:` | PATCH | `1.0.0 → 1.0.1` |
| `feat:` | MINOR | `1.0.0 → 1.1.0` |
| `feat!:` / `BREAKING CHANGE` | MAJOR | `1.0.0 → 2.0.0` |
| `chore:` / `ci:` / `docs:` / `test:` | none | — |

Loop prevention: commits starting with `chore(release):` are skipped.

**Inputs:** none  
**Secrets:** `GITHUB_TOKEN` (from `secrets: inherit`)  
**Outputs:** `new-version`, `bumped`

```yaml
jobs:
  version-bump:
    uses: duikindiesee/kooker-workflows/.github/workflows/maven-version-bump.yml@main
    secrets: inherit
```

---

### `android-version-bump.yml` — Android version bump

Bumps `versionName` and `versionCode` in `{app-dir}/app/build.gradle` based on the same Conventional Commit rules.

`versionCode` scheme: `MAJOR×100 + MINOR×10 + PATCH` (e.g. `1.2.3 → 123`).

**Inputs:**

| Input | Required | Description |
|---|---|---|
| `app-dir` | ✅ | Subdirectory containing the Android project |

**Outputs:** `new-version`, `new-version-code`, `bumped`

```yaml
jobs:
  version-bump:
    uses: duikindiesee/kooker-workflows/.github/workflows/android-version-bump.yml@main
    with:
      app-dir: my-app
    secrets: inherit
    permissions:
      contents: write
```

---

### `flyway-lint.yml` — Flyway migration detector

Detects new or modified SQL migration files and applies a limited breaking-pattern scan when a consuming workflow calls it. Outputs `has_db_changes=true` which downstream jobs can use for DB-aware version decisions. The output alone does not prove compatibility or merge-blocking enforcement.

**Verified behavior at `27dc1ebf` (19 October 2026):**

- The workflow scans added/modified files under one configured `migration-path`. PR detection uses the base-branch merge-base; push detection uses only `HEAD~1..HEAD`. Deleted files and changes earlier in a multi-commit push are not covered by that detection.
- SQL is scanned one physical line at a time. Multiline `ALTER TABLE` statements and alternate syntax, including `MODIFY` without `COLUMN`, can evade the patterns. A line containing `kooker:allow-breaking` is skipped without verifying a ticket, approver or authorization. A marker on the previous comment line does not exempt the following statement. These are implementation behaviors, not an approved exception process.
- Failed diff commands are converted to an empty change list, and a missing migration directory skips the naming check. A successful run can therefore mean no files were inspected.
- The optional [pre-commit hook](scripts/lint-migrations.sh) shares the line-based approach and supports `KOOKER_LINT_MODE=warn`. A local hook, particularly warn mode, is advisory; it does not establish an authoritative required CI check.
- Reusable-workflow availability is separate from service adoption. Inspect the consumer's events, path filters, configured migration paths, skip/error handling and required rulesets/check contexts before claiming a merge is blocked. This audit did not establish fleet-wide enforcement.

**Additive-only policy and controlled exceptions — review target:**

Compatible `CREATE` and `ALTER TABLE ... ADD` are additive operations. Evaluate defaults, nullability, constraints, locking and old-reader compatibility as part of review. A safe, bounded backfill can accompany expansion; do not classify every `ALTER` or backfill as destructive. Type changes, renames, removals, truncation, destructive DML and index/constraint changes require explicit compatibility and retention assessment. Preserve applied migration history; introduce a new reviewed migration instead of rewriting or deleting applied files.

The intended normal route is expand, preserve old-reader compatibility, backfill with restart/concurrency validation, switch readers, and explicitly decide retention. A contract-phase removal is a separately approved exception to additive-only work. A comment alone is insufficient evidence of that approval. The proposed exception record binds a reason, existing ticket, authorized approver, exact revision/service/statements and expiry to compatibility/data-retention assessment, recovery evidence and bounded verification/rollback. Operator acceptance of this policy and independent source review precede implementation; this documentation does not activate a new guard, disable existing exceptions or authorize a database operation.

Tracked review work: [shared guard hardening](https://zaarwin.kooker.co.za/workstreams/tasks/d846c81e-6550-47ae-9dc5-10528f4b43b2), [per-service adoption and required-check verification](https://zaarwin.kooker.co.za/workstreams/tasks/01b2f4e5-cafe-445a-a783-29c4ed289ec2), and [policy/operator review](https://zaarwin.kooker.co.za/workstreams/tasks/9d45284a-f7e1-4cb2-8bf6-bbe03ae86f11). Acceptance includes statement-aware parsing, immutable/deleted history protection, complete PR/push diffs, fail-closed path/diff errors, approved exceptions and actual consumer positive/negative fixtures. Source, hosted CI, configured required checks and service adoption are separate evidence.

**Inputs:**

| Input | Required | Default | Description |
|---|---|---|---|
| `migration-path` | ❌ | `src/main/resources/db/migration` | Path to Flyway migrations directory |

**Outputs:** `has_db_changes` (`'true'` / `'false'`)

```yaml
jobs:
  flyway-lint:
    uses: duikindiesee/kooker-workflows/.github/workflows/flyway-lint.yml@main
    with:
      migration-path: my-module/src/main/resources/db/migration
```

---

### `jdk25-baseline-guard.yml` — JDK 25 Maven baseline guard

Fails a pull request before any build/package/release work begins when an in-scope Maven project's
configured `release`/`source`/`target`/toolchain drops below the org baseline (default 25). Two
layers: a fast offline static scan of committed `pom.xml`/`toolchains.xml` files
(`scripts/check-jdk25-baseline.sh`, independently unit-tested — run `bash
tests/check-jdk25-baseline.test.sh`), then — only for a project that declares nothing of its own and
relies on parent-POM inheritance — a live `mvn help:evaluate` effective-configuration cross-check.
See [`docs/jdk25-baseline-adoption.md`](docs/jdk25-baseline-adoption.md) for the full repository
inventory, current compliance state, and the two-layer design rationale.

**Inputs:**

| Input | Required | Default | Description |
|---|---|---|---|
| `minimum-java-version` | ❌ | `25` | Minimum acceptable Java release/source/target/toolchain version |
| `workflows-ref` | ❌ | `main` | `kooker-workflows` ref to source the guard script from |

**Outputs:** `result` (`'pass'` / `'fail'`)

**Secrets:** `MAVEN_PUBLISH_TOKEN` — only consulted when the effective-configuration cross-check runs
(i.e. only for a project that declares nothing of its own), to resolve `kooker-parent-build` from
GitHub Packages. Same secret `maven-version-bump.yml` already uses for this.

```yaml
jobs:
  jdk25-guard:
    uses: duikindiesee/kooker-workflows/.github/workflows/jdk25-baseline-guard.yml@main

  build:
    needs: jdk25-guard
    # ...existing build/package job, unchanged...
```

---

### `auto-version.yml` — Auto tag on merge to main

Tags the repo with a semver version on merge. Distinguishes DB-breaking changes (4-part version `vX.Y.Z.N`) from regular patches.

**Inputs:**

| Input | Required | Description |
|---|---|---|
| `has-db-changes` | ✅ | Pass output of `flyway-lint` |

```yaml
jobs:
  tag:
    uses: duikindiesee/kooker-workflows/.github/workflows/auto-version.yml@main
    with:
      has-db-changes: ${{ needs.flyway-lint.outputs.has_db_changes }}
    secrets: inherit
```

---

### `swagger-enforce.yml` — OpenAPI / Swagger validation

Validates that the OpenAPI spec compiles against the Spring Boot app. Fails the PR if the spec is inconsistent.

**Inputs:**

| Input | Required | Default |
|---|---|---|
| `java-version` | ❌ | `21` |

```yaml
jobs:
  validate:
    uses: duikindiesee/kooker-workflows/.github/workflows/swagger-enforce.yml@main
```

---

### `ghcr-retention.yml` — Centralized container image retention (semver protected)

Prunes old untagged and transient feature/renovate branch image versions from GHCR while strictly protecting semver release tags (`^v?[0-9]+\.[0-9]+\.[0-9]+$`). Evaluates policy against every actual tag in container metadata and protects the entire version if any tag matches.

**Inputs:**

| Input | Required | Default | Description |
|---|---|---|---|
| `package-name` | ❌ | calling repo name | GHCR container package name |
| `min-versions-to-keep` | ❌ | `60` | Minimum newest versions to keep |
| `ignore-versions` | ❌ | `^v?[0-9]+\.[0-9]+\.[0-9]+$` | Regex of tags to preserve |

**Secrets:** `MAVEN_PUBLISH_TOKEN` (required write token for package deletion)

```yaml
jobs:
  retention:
    uses: duikindiesee/kooker-workflows/.github/workflows/ghcr-retention.yml@main
    secrets: inherit
```

---

## Organisation Setup

For all repos in `duikindiesee` to consume these workflows, the org must have:

### 1. Org Actions Permissions
`Settings → Actions → General → Actions permissions`

→ **Allow all actions and reusable workflows**

### 2. Default Workflow Permissions
`Settings → Actions → General → Workflow permissions`

→ **Read and write permissions** ✅  
→ **Allow GitHub Actions to create and approve pull requests** ✅

Without read/write, `maven-version-bump` and `android-version-bump` cannot push the version bump commit back to the branch.

---

## Adding a New Workflow

1. Create `.github/workflows/<name>.yml` with `on: workflow_call:` trigger
2. Document inputs, outputs, and secrets in this README
3. Add the calling snippet to the consumer repo's workflow
4. Open a PR — the workflow is available to all `duikindiesee` repos as soon as it merges to `main`

> **Do not make this repo private.** See the note at the top for why.
