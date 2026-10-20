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

### `gitops-sync.yml` — GitOps deployment PR automation (tag & digest binding)

Automates the promotion of container images into the `kooker-infra` Kustomize repository via pull requests. Evaluates protected overlay release holds (e.g. CityLife multiplayer lock). Supports optional canonical manifest digest binding (`new_digest`) for verified release callers.

**Inputs:**

| Input | Required | Default | Description |
|---|---|---|---|
| `image_name` | ✅ | — | Base container image name (e.g. `ghcr.io/duikindiesee/sportifine-server`) |
| `new_tag` | ✅ | — | Tag to deploy or verify (e.g. `1.14.0` or `sha-81df9cb`) |
| `new_digest` | ❌ | `''` | Optional canonical manifest digest (`sha256:64hex`). Enforces remote manifest proof and digest-only Kustomize rendering when specified. |
| `kustomize_path` | ✅ | — | Path within `kooker-infra` to overlay directory |
| `target_branch` | ❌ | `main` | Base branch of the deploy PR in `kooker-infra` |

**Secrets:**
- `MAVEN_PUBLISH_TOKEN`: Opens the deploy PR (author identity)
- `GITOPS_APPROVER_TOKEN`: Approves and merges the deploy PR under branch protection rules (reviewer identity)

```yaml
jobs:
  deploy:
    uses: duikindiesee/kooker-workflows/.github/workflows/gitops-sync.yml@main
    with:
      image_name: ghcr.io/duikindiesee/sportifine-server
      new_tag: ${{ needs.publish.outputs.version }}
      new_digest: ${{ needs.publish.outputs.digest }}
      kustomize_path: manifests/overlays/develop/sportifine-server
      target_branch: main
    secrets: inherit
```

#### Acceptance Matrix & Phase-Aware Readiness (D01–D22)

The automatic digest binding implementation represents a source candidate implementing the normative contract defined in `bridge/to-mojojo/2026-10-19-digest-contract-binding-resolution.md`, with local qualified evidence and fresh independent review pending.
Verification is strictly phase-aware, distinguishing:
- **Integrated Primary Suite (`tests/check-gitops-digest-integration.cjs`)**: Executes actual parsed production step bodies (`gitops-sync.yml`), real Kustomize rendering, physical canonical directory validation, and production consumer CLI (`scripts/update-gitops-digest.mjs`). Local git, docker, and gh transports execute via scoped local fixture stubs and wrappers without remote network access or real credentials.
- **Supplementary Unit Checks (`tests/check-gitops-digest.test.cjs`)**: Fast offline static checks and direct unit helper invocations (22 passed, 0 failed; previously 20 passed, 2 failed attributed to missing `namespace: kooker` in unit fixtures and missing pre-render context in D17 test).
- **Residual Fixture Scope**: Local synthetic test environments operate within known residual fixture bounds: required working directory prefixing (`cd <worktree>`), permissive local git clone/rev-parse operations, allowlisted Docker/GH argument vectors, and emulated Actions context expressions. They do not claim live GitHub Actions engine execution or production PR mutations.
- **Omitted vs Empty Default**: In `gitops-sync.yml`, an omitted `new_digest` defaults to empty string (`''`), triggering `mode=tag`. In local offline harnesses, both omitted and explicit empty strings are tested via empty environment variable strings (`NEW_DIGEST=''`), which emulates the Actions input default rather than constituting hosted Actions caller runtime proof.
- **Rollback Proof**: For controlled failure injections, rollback is verified as byte-and-mode restoration of the target directory; this provides controlled fixture recovery proof rather than formal filesystem atomicity proof.
- **Queued Downstream (Post-Land Lifecycle)**:
  - **D20**: Consuming caller workflow (`sportifine-server`) must land an immutable SHA reference to `kooker-workflows` AFTER the shared PR merges to avoid circular dependency. (Note: The caller example above referencing `@main` is an existing legacy compatibility example; production digest release callers must reference an immutable commit SHA landed post-merge.)
  - **D21**: Inert first-install policy, human hold evaluation, and subsequent release ledger promotion in `kooker-infra` remain queued downstream for production runtime, non-circularly, and are NOT claimed as offline verified runtime proof.

| ID | Control / Contract Surface | Implementation Source | Test File / Command | Status | Notes / Residual Scope |
|---|---|---|---|---|---|
| **D01** | Legacy input omitted default (`new_digest: ''`) triggers `mode=tag` | `.github/workflows/gitops-sync.yml` | `node tests/check-gitops-digest-integration.cjs` | **LOCAL PASS** | Actual validate step body outputs `mode=tag` |
| **D02** | Explicit empty input (`new_digest: ''`) triggers `mode=tag` | `.github/workflows/gitops-sync.yml` | `node tests/check-gitops-digest-integration.cjs` | **LOCAL PASS** | Validates tag mode branch without remote digest requirement |
| **D03** | Protected CityLife client/server release hold fails closed before infra/PR mutation | `.github/workflows/gitops-sync.yml` | `node tests/check-gitops-digest-integration.cjs` | **LOCAL PASS** | Tested against 6 isolated guard cases + 3 full chain variants (missing/malformed/valid lock) |
| **D04** | Valid Sportifine initial pin updates intended deployment to `@digest` preserving unrelated | `scripts/lib/kustomize-digest.js` | `node tests/check-gitops-digest-integration.cjs` | **LOCAL PASS** | Real Kustomize build verifies exact digest pin, explicit `kooker` namespace, and unmutated sidecar/ConfigMap |
| **D05** | Later distinct valid digest replaces prior digest cleanly | `scripts/lib/kustomize-digest.js` | `node tests/check-gitops-digest-integration.cjs` | **LOCAL PASS** | Purges prior digest, renders fresh digest pin |
| **D06** | Stale `newTag` purged during digest update normalization | `scripts/lib/kustomize-digest.js` | `node tests/check-gitops-digest-integration.cjs` | **LOCAL PASS** | Ensures `newTag` is removed when `digest` is bound |
| **D07** | Malformed/upper-case/whitespace/alternate algorithm digest refused | `scripts/lib/kustomize-digest.js` | `node tests/check-gitops-digest-integration.cjs` | **LOCAL PASS** | Strict lowercase `sha256:[a-f0-9]{64}` regex enforcement |
| **D08** | Wrong caller, image, canonical path, or namespace refused fail-closed | `scripts/lib/kustomize-digest.js` | `node tests/check-gitops-digest-integration.cjs` | **LOCAL PASS** | Verifies caller repository, image name, physical canonical path, and explicit `kooker` namespace; preserves cluster-scoped resources |
| **D09** | Missing intended Deployment or zero targets refused fail-closed | `scripts/lib/kustomize-digest.js` | `node tests/check-gitops-digest-integration.cjs` | **LOCAL PASS** | Requires matching backend Deployment anchor before writing |
| **D10** | Non-zero registry inspect exit code triggers immediate fail-closed exit | `.github/workflows/gitops-sync.yml` | `node tests/check-gitops-digest-integration.cjs` | **LOCAL PASS** | Step exits non-zero before checkout or infra PR stages |
| **D11** | Malformed, array, null, or nested-alias-only JSON refused fail-closed | `.github/workflows/gitops-sync.yml` | `node tests/check-gitops-digest-integration.cjs` | **LOCAL PASS** | Validates root OCI manifest JSON object descriptor |
| **D12** | Config-digest confusion or digest mismatch fails closed | `.github/workflows/gitops-sync.yml` | `node tests/check-gitops-digest-integration.cjs` | **LOCAL PASS** | Enforces root descriptor digest match with expected SHA |
| **D13** | Registry producer bounded by real 30s deadline, 64KB stdout, 16KB stderr caps | `.github/workflows/gitops-sync.yml` | `node tests/check-gitops-digest-integration.cjs` | **LOCAL PASS** | Process tree killed, sentinel preserved, buffer caps enforced |
| **D14** | Valid descriptor with extra unrelated metadata fields passes | `.github/workflows/gitops-sync.yml` | `node tests/check-gitops-digest-integration.cjs` | **LOCAL PASS** | Ignores extraneous descriptor fields if root digest matches |
| **D15** | Duplicate conflicting image entries in Kustomization fail closed | `scripts/lib/kustomize-digest.js` | `node tests/check-gitops-digest-integration.cjs` | **LOCAL PASS** | Detects conflicting multiple entries for same target |
| **D16** | Mixed/stale target container references rejected | `scripts/lib/kustomize-digest.js` | `node tests/check-gitops-digest-integration.cjs` | **LOCAL PASS** | Verified in integration suite (fails closed with rollback on stale targets) and supplementary suite |
| **D17** | Unrelated resource or field mutation rejected with rollback | `scripts/lib/kustomize-digest.js` | `node tests/check-gitops-digest-integration.cjs` | **LOCAL PASS** | Second-render semantic comparison detects mutation and reverts target files |
| **D18** | Mandatory YAML/Kustomize parser and exact helper identity checkout | `.github/workflows/gitops-sync.yml` | `node tests/check-gitops-digest-integration.cjs` | **LOCAL PASS** | Verifies helper repo, path, commit SHA, and checked-out HEAD before invocation |
| **D19** | Missing or failing approver leaves PR open and fails job with non-zero exit | `.github/workflows/gitops-sync.yml` | `node tests/check-gitops-digest-integration.cjs` | **LOCAL PASS** | Asserts 0 merge calls after review denial; exactly 3 attempts on merge check block |
| **D20** | Caller repo exact shared SHA binding and publish outputs wiring | Downstream caller | Downstream caller CI | **NOTRUN** | Queued downstream; caller wires immutable SHA after shared workflow merges (hosted CI runtime not yet executed) |
| **D21** | Inert first-install flow and subsequent digest promotion in `kooker-infra` | Downstream infra | Downstream runtime | **NOTRUN** | Queued downstream; inert human review policy preserved (live cluster runtime not yet executed) |
| **D22** | Shell metacharacters and injected text refused before execution | `scripts/lib/kustomize-digest.js` | `node tests/check-gitops-digest-integration.cjs` | **LOCAL PASS** | Rejects traversal characters, newlines, and invalid format strings |

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
