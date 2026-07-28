# JDK 25 Maven baseline — repository adoption manifest

Snapshot date: 2026-07-28. Surveyed via `gh repo list duikindiesee --limit 200` (57 non-archived,
non-fork repositories) plus the GitHub Git Trees API (`git/trees/<default-branch>?recursive=1`) on
each repository's default branch, searching for any file matching `**/pom.xml`. Every `pom.xml`
found was fetched and run through `scripts/check-jdk25-baseline.sh --allow-absent` to determine its
current declaration state before this manifest was written — the "Current state" column below is
observed fact, not assumption.

This PR delivers the guard (`scripts/check-jdk25-baseline.sh` +
`.github/workflows/jdk25-baseline-guard.yml`) and this manifest only. **Wiring the reusable
workflow into each in-scope repository's own build workflow is explicit follow-up work, one PR per
repository** (or a small batch), per the task's own scope boundary — this keeps each adoption PR
independently reviewable and revertible, and avoids one PR touching 15 unrelated repositories'
release pipelines at once.

## In-scope Maven repositories (15)

All are `duikindiesee/kooker-*`, non-archived, non-fork, and build with Maven.

| Repository | pom.xml(s) | Current state | Adoption status |
|---|---|---|---|
| `kooker-parent-build` | `pom.xml` | Explicit `maven.compiler.source/target=25`; the org's actual parent/source of truth for every inheriting service | ⬜ Pending adoption PR |
| `kooker-bom` | `pom.xml` (+ `examples/*.xml` — excluded, see below) | Explicit `java.version=25` property, referenced via `${java.version}` in the compiler plugin | ⬜ Pending adoption PR |
| `kooker-gateway` | `pom.xml` | Explicit `source/target=25` | ⬜ Pending adoption PR |
| `kooker-service-ai` | `pom.xml` | Explicit `source/target=25` | ⬜ Pending adoption PR |
| `kooker-service-auth` | `pom.xml` | Explicit `source/target=25` | ⬜ Pending adoption PR |
| `kooker-service-image` | `pom.xml` | Explicit `source/target=25` | ⬜ Pending adoption PR |
| `kooker-service-radar` | `pom.xml` | Explicit `source/target=25` | ⬜ Pending adoption PR |
| `kooker-service-venture` | `pom.xml` | Explicit `source/target=25` | ⬜ Pending adoption PR |
| `kooker-service-games` | `pom.xml` (root), `kooker-client-service-games/pom.xml`, `kooker-service-games-app/pom.xml` | Root is a pure `packaging=pom` aggregator (correctly excluded, compiles nothing); both real modules explicitly declare `source/target=25` | ⬜ Pending adoption PR |
| `kooker-service-user` | `pom.xml` (root), `kooker-client-service-user/pom.xml`, `kooker-service-user-app/pom.xml` | Root is a pure `packaging=pom` aggregator (excluded); **both real modules declare nothing of their own** — inherit from `kooker-parent-build` v1.0.7 (`relativePath=../kooker-parent-build/pom.xml`), effective value 25. Guard's static layer reports these ABSENT/deferred; the effective-configuration layer resolves them correctly | ⬜ Pending adoption PR |
| `kooker-config-server` | `pom.xml` | Declares nothing; inherits from `kooker-parent-build` v1.0.7, effective 25 | ⬜ Pending adoption PR |
| `kooker-discovery-service` | `pom.xml` | Declares nothing; inherits from `kooker-parent-build` v1.0.7, effective 25 | ⬜ Pending adoption PR |
| `kooker-service-ledger` | `pom.xml` | Declares nothing; inherits from `kooker-parent-build` v1.0.6, effective 25 | ⬜ Pending adoption PR |
| `kooker-service-publishing` | `pom.xml` | Declares nothing; inherits from `kooker-parent-build` v1.0.7, effective 25 | ⬜ Pending adoption PR |
| `kooker-service-github` | `pom.xml` | Root `pom.xml` is `packaging=pom` with **no `<modules>` and no `<parent>`** — an empty placeholder, not a real aggregator of anything. Correctly excluded by the guard (nothing to compile), but flagged here as a separate, pre-existing structural gap worth an operator look — not a Java-version violation, since there is no code to violate it | ⬜ Pending adoption PR; ⚠️ structural gap flagged separately (not a guard change) |

**Result of running the guard against every file above today: zero Java-version violations.** The
org's actual baseline is already 25 everywhere that compiles code — this rollout is a *guard against
future regression*, not a remediation of current drift.

## Excluded — non-Kooker (documented allowlist)

| Repository | pom.xml present? | Reason for exclusion |
|---|---|---|
| `meal-planner-app` | Yes (9 modules) | Personal project ("This saved my life ;)" — repo description), no Kooker branding or `kooker-` prefix, not part of the platform |
| `nearest-energy-radar` | Yes (`backend/pom.xml`) | No Kooker branding, no `kooker-` prefix, appears to be an unrelated personal/experimental project |

## Excluded — archived (documented allowlist)

Confirmed `isArchived: true` via `gh repo list`; excluded regardless of language.

| Repository |
|---|
| `kooker-pacman` |
| `nemoclaw` |
| `kooker-formflow` |
| `kooker-trading-agent` |

## Excluded — no `pom.xml` anywhere (not Maven projects, informational)

Every other non-archived, non-fork repository in `duikindiesee` was checked and has **no**
`pom.xml` at any depth on its default branch — Node/TypeScript, Python, Kotlin/Gradle, Go, static
config, or documentation repositories. Listed for a complete, auditable inventory (the task's
"exact repository inventory" requirement), not because any action is needed:

`boboti`, `citylife`, `discussions`, `irwin_memory_bank`, `joekookerbot`, `kooker-agent-blueprints`,
`kooker-ai-cortex`, `kooker-api-specs`, `kooker-architecture`, `kooker-bot-constitution`,
`kooker-bot-spawner`, `kooker-dev-config`, `kooker-documentation`, `kooker-infra`, `kooker-jbird`,
`kooker-llm-poc`, `kooker-local-sh-infrastructure-old`, `kooker-product-docs`,
`kooker-service-citylife-world`, `kooker-service-inference`, `kooker-service-market`,
`kooker-service-meal`, `kooker-service-plant`, `kooker-service-social`, `kooker-service-sportifine`,
`kooker-tools`, `kooker-vast-proxy`, `kooker-web`, `kooker-workflows` (this repo), `low-power-radio`,
`otto`, `otto-v2`, `redecorate`, `renovate-config`, `sportifine-v2`, `sportifine-web`, `sprout`,
`sprout-monitor`, `sprout-v2`.

## Excluded fixture/example files (not real project POMs)

`kooker-bom/examples/*.xml` (`config-server-pom.xml`, `eureka-server-pom.xml`,
`mpa-google-service-pom.xml`, `mpa-server-example-pom.xml`) are documentation template snippets
shipped for consumers to copy, not files Maven ever builds from — excluded from scanning by name
(`examples/` path prefix), not by the guard script itself (which would happily scan them if pointed
at that directory; they are simply never part of a real `mvn` invocation's own working tree in
practice).

## Two-layer verification contract (why every "declares nothing" repo above is still compliant)

`scripts/check-jdk25-baseline.sh` deliberately does **not** resolve parent-POM inheritance — see the
script's own header for the full rationale (fast, deterministic, offline-unit-testable, no
network/credentials required for the common case). Six of the fifteen in-scope repositories declare
nothing in their own `pom.xml` and rely entirely on inheriting `maven.compiler.source/target=25`
from `kooker-parent-build`. `.github/workflows/jdk25-baseline-guard.yml` runs the static script
first (fast, catches the majority case directly), and — only for files it reports ABSENT — follows
up with a live `mvn help:evaluate -Dexpression=maven.compiler.release` (falling back to `target`,
then `source`) against the fully resolved effective POM, which correctly returns `25` for every one
of these six repositories today. A future regression in either the child's own declaration OR the
inherited parent value will be caught by one layer or the other.

## Required proof — CI run evidence

See the PR description for the exact-head hosted CI run link. `tests/check-jdk25-baseline.test.sh`
(23 assertions, run as a required step in this repo's own CI) independently proves, offline, with
self-contained fixtures under `tests/fixtures/`:

- Java 24 fails; Java 25 passes; Java 26 passes.
- Absent declarations fail closed by default, and defer (exit 2) under `--allow-absent`.
- Conflicting declarations within one file fail closed.
- A `maven-toolchains-plugin`/`toolchains.xml` requirement below the minimum fails.
- `${property}`-interpolated values (kooker-bom's actual pattern) resolve correctly.
- Legacy `1.N` notation (e.g. `1.8`) is recognized and evaluated, not silently skipped.
- A violation in any one module of a multi-module repo fails the whole repo, even when a sibling
  module is compliant.
- A pure `packaging=pom` aggregator with nothing to compile is correctly excluded, not flagged.
- The minimum version is genuinely configurable (`--minimum`), not hardcoded to 25.

No secrets appear anywhere in this manifest, the guard script, its tests, or the reusable workflow.

## Follow-up PR decomposition

One PR per repository (or one small batch of closely related repositories) to add:

```yaml
jobs:
  jdk25-guard:
    uses: duikindiesee/kooker-workflows/.github/workflows/jdk25-baseline-guard.yml@main

  build:
    needs: jdk25-guard
    # ...existing build job, unchanged...
```

before that repository's existing build/package job. Suggested order: the six repositories whose
effective value is inherited (`kooker-config-server`, `kooker-discovery-service`,
`kooker-service-ledger`, `kooker-service-publishing`, `kooker-service-user`,
`kooker-service-games`) first, since they are the ones the two-layer design exists to protect;
the remaining nine (already explicit) can follow in any order. `kooker-service-github`'s structural
gap (no modules, no parent) is a separate follow-up, not a guard-adoption PR.
