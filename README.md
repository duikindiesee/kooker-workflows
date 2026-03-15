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

**Consumers:** `kooker-service-auth`, `kooker-service-user`, `kooker-service-image`, `kooker-gateway`, `kooker-parent-build`

---

### `android-version-bump.yml` — Android version bump

Bumps `versionName` and `versionCode` in `{app-dir}/app/build.gradle` based on the same Conventional Commit rules.

`versionCode` scheme: `MAJOR×100 + MINOR×10 + PATCH` (e.g. `1.2.3 → 123`).

**Inputs:**

| Input | Required | Description |
|---|---|---|
| `app-dir` | ✅ | Subdirectory containing the Android project (e.g. `sportifine`, `sprout`, `otto`) |

**Outputs:** `new-version`, `new-version-code`, `bumped`

```yaml
jobs:
  version-bump:
    uses: duikindiesee/kooker-workflows/.github/workflows/android-version-bump.yml@main
    with:
      app-dir: sportifine
    secrets: inherit
    permissions:
      contents: write
```

**Consumers:** `meal-planner-app` (sportifine, sprout, otto apps)

---

### `flyway-lint.yml` — Flyway migration detector

Detects new or modified SQL migration files in a PR. Outputs `has_db_changes=true` which downstream jobs use to decide whether a DB-aware version bump is needed.

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
      migration-path: kooker-service-user-app/src/main/resources/db/migration
```

**Consumers:** `kooker-service-user`, `kooker-service-auth`

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

**Consumers:** `kooker-service-user`, `kooker-service-auth`

---

### `grafana-dashboards.yml` — Grafana dashboard sync

Loads Grafana dashboard JSON files from the repo into a running Grafana instance via a PowerShell script. Runs on Windows runners.

**Secrets:**

| Secret | Required | Description |
|---|---|---|
| `KOOKER_GRAFANA_PAT` | ✅ | API token for the Grafana instance |

```yaml
jobs:
  dashboards:
    uses: duikindiesee/kooker-workflows/.github/workflows/grafana-dashboards.yml@main
    secrets: inherit
```

**Consumers:** `kooker-infra` (monitoring stack)

---

## End-to-End CI Flow

```
Push / PR
  │
  ├─ PR open/sync
  │    ├── flyway-lint          → has_db_changes output
  │    ├── swagger-enforce      → validates OpenAPI spec
  │    └── mvn verify / gradle build
  │
  └─ Merge to main
       ├── maven-version-bump   → bumps pom.xml, pushes chore(release): commit + tag
       ├── android-version-bump → bumps build.gradle, pushes chore(release): commit
       ├── auto-version         → tags repo (uses flyway-lint output)
       ├── docker build & push  → ghcr.io/duikindiesee/<service>:<version>
       └── grafana-dashboards   → syncs dashboards to Grafana
```

---

## Organisation Setup

For all repos in `duikindiesee` to consume these workflows, the org must have:

### 1. Org Actions Permissions
`Settings → Actions → General → Actions permissions`

→ **Allow all actions and reusable workflows**  
*(or "Allow duikindiesee, and select non-duikindiesee" with `actions/*`, `android-actions/*`, `peter-evans/*`, `softprops/*` in the allow-list)*

### 2. Default Workflow Permissions
`Settings → Actions → General → Workflow permissions`

→ **Read and write permissions** ✅  
→ **Allow GitHub Actions to create and approve pull requests** ✅

Without read/write, `maven-version-bump` and `android-version-bump` cannot push the version bump commit back to the branch.

### 3. Repository Secrets (per consuming repo)

| Secret | Used by | Purpose |
|---|---|---|
| `GITHUB_TOKEN` | all | Pushing commits, creating tags (auto-provisioned) |
| `KOOKER_GRAFANA_PAT` | `grafana-dashboards` | Grafana API access |
| `KOOKER_WEB_PAT` | `meal-planner-app` | Dispatching events to `kooker-web` |
| `KOOKER_API_SPECS_APP_ID` | `kooker-service-image` | GitHub App for cross-repo PR creation |
| `KOOKER_API_SPECS_APP_PRIVATE_KEY` | `kooker-service-image` | GitHub App private key |

---

## Adding a New Workflow

1. Create `.github/workflows/<name>.yml` with `on: workflow_call:` trigger
2. Document inputs, outputs, and secrets in this README
3. Add the calling snippet to the consumer repo's workflow
4. Open a PR — the workflow is available to all `duikindiesee` repos as soon as it merges to `main`

> **Do not make this repo private.** See the note at the top for why.
