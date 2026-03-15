# kooker-workflows

Reusable GitHub Actions workflows for the Kooker ecosystem.

> [!IMPORTANT]
> `kooker-workflows` is a **private** repository. For any repo inside the `duikindiesee` org
> to call these workflows you must enable cross-repo access **once**:
>
> `kooker-workflows` → **Settings → Actions → Access**
> → set to **"Accessible from repositories in the duikindiesee organization"**
>
> Without this, GitHub reports the workflow as "not found" even though it exists.

---

## Available Workflows

| Workflow | Purpose | Call from |
|---|---|---|
| [`flyway-lint.yml`](.github/workflows/flyway-lint.yml) | Detects breaking Flyway migration SQL, enforces naming conventions | Spring Boot services with Flyway |
| [`swagger-enforce.yml`](.github/workflows/swagger-enforce.yml) | Builds the project and validates OpenAPI spec generation | Spring Boot services with springdoc |
| [`maven-version-bump.yml`](.github/workflows/maven-version-bump.yml) | Reads Conventional Commit prefix, bumps `pom.xml` version and pushes a `chore(release):` commit | Spring Boot services |
| [`android-version-bump.yml`](.github/workflows/android-version-bump.yml) | Reads Conventional Commit prefix, bumps `versionName`/`versionCode` in `build.gradle` | Android apps |
| [`auto-version.yml`](.github/workflows/auto-version.yml) | Tags and creates a GitHub Release on merge to `main` | Any service |
| [`grafana-dashboards.yml`](.github/workflows/grafana-dashboards.yml) | Syncs Grafana dashboard JSON to Grafana Cloud | Monitoring repos |

---

## Conventional Commit → Version Bump Matrix

| Commit prefix | Bump | Example |
|---|---|---|
| `fix:` | PATCH | `1.0.3` → `1.0.4` |
| `feat:` | MINOR | `1.0.3` → `1.1.0` |
| `feat!:` or `BREAKING CHANGE:` | MAJOR | `1.0.3` → `2.0.0` |
| `chore:`, `docs:`, `ci:`, `test:`, `refactor:` | none | no bump |
| `chore(release):` | skipped | loop prevention — bumper's own commits |

---

## Current Consumers

| Repo | Workflow Used | Branch |
|---|---|---|
| `kooker-service-user` | `flyway-lint`, `swagger-enforce`, `maven-version-bump` | `main` (via hotfix PR #31), `feature/add-export-api` |
| `meal-planner-app` | `android-version-bump` (sportifine + sportifine-auth) | `sportifine-auth` |

> **Other Spring Boot services** (`kooker-service-auth`, `kooker-gateway`, `kooker-service-meal`, etc.)
> have standalone CI and do not yet call these workflows. Wire them in when ready
> following the patterns in `kooker-service-user/spring-boot-docker.yml`.

---

## Wiring a Spring Boot Service (Maven)

```yaml
# In your service's .github/workflows/spring-boot-docker.yml

jobs:
  validate-flyway:
    uses: duikindiesee/kooker-workflows/.github/workflows/flyway-lint.yml@main
    with:
      migration-path: src/main/resources/db/migration   # optional, defaults to this

  validate-swagger:
    uses: duikindiesee/kooker-workflows/.github/workflows/swagger-enforce.yml@main
    with:
      java-version: '25'

  version-bump:
    uses: duikindiesee/kooker-workflows/.github/workflows/maven-version-bump.yml@main
    if: github.event_name == 'push' && !startsWith(github.ref, 'refs/tags/')
    with:
      java-version: '25'
    secrets: inherit
    permissions:
      contents: write

  build-and-push:
    needs: [validate-flyway, validate-swagger, version-bump]
    # ... rest of your build
```

## Wiring an Android App

```yaml
# In your app's .github/workflows/build-debug-apk.yml

jobs:
  version-bump:
    uses: duikindiesee/kooker-workflows/.github/workflows/android-version-bump.yml@main
    with:
      app-dir: sportifine   # directory containing app/build.gradle
    secrets: inherit
    permissions:
      contents: write

  build:
    needs: version-bump
    # ... rest of your build
```

---

## Flyway Lint Escape Hatch

If a migration intentionally contains a breaking pattern (e.g., `DROP COLUMN` that is safe),
add the escape comment on the same line:

```sql
ALTER TABLE fines DROP COLUMN legacy_field; -- kooker-lint-ignore
```

---

## Loop Prevention

`maven-version-bump` and `android-version-bump` both detect their own release commits and skip,
preventing infinite CI loops. The bot commit message starts with `chore(release):`.

---

## Local Flyway Linting (Pre-commit Hook)

```bash
# From any service repo root — requires kooker-workflows scripts in PATH or copied locally
KOOKER_LINT_MODE=staged bash scripts/lint-migrations.sh
```
