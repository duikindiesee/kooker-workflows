# Specifications Index

| ID | Specification | Scope | Status |
|---|---|---|---|
| `001` | [Reusable Workflow Security Contract](001-reusable-workflow-security-contract.md) | Least-privilege `permissions:`, 40-char SHA pinning, `persist-credentials: false`, `env:` binding, strict bash/pwsh, `GITHUB_OUTPUT`/`GITHUB_ENV` hygiene, `actionlint` | ACTIVE |
| `002` | [Swagger & Compliance Gates](002-swagger-and-compliance-gates.md) | `swagger-enforce.yml` (JDK 25 + fail-closed OpenAPI security & Springdoc checks), `jdk25-baseline-guard.yml`, `flyway-lint.yml`, `scripts/lint-migrations.sh` | ACTIVE |
| `003` | [Release & GitOps Sync Contract](003-release-and-gitops-sync-contract.md) | Dual-identity PR version bumps, `auto-version.yml`, `gitops-sync.yml` digest binding & CityLife adoption lock, `ghcr-retention.yml`, `neo4j-delta-cache.yml`, `grafana-dashboards.yml` | ACTIVE |
