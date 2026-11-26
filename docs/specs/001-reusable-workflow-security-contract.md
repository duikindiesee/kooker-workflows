# Specification 001 — Reusable Workflow Security Contract

**Status:** ACTIVE  
**Scope:** All 12 workflows in `.github/workflows/*.yml`, `.github/actionlint.yaml`, `.gitattributes`, and self-tests (`tests/check-workflow-security.test.cjs`).

## 1. Least-Privilege Token Permissions
- Every workflow MUST declare `permissions: {}` at top level so unprivileged defaults apply across all jobs.
- Every job MUST declare explicit minimal `permissions:` (`contents: read` for read-only/lint/sync jobs, `contents: write` / `pull-requests: write` only on bump/tag jobs, `packages: write` only on `ghcr-retention.yml`).
- Organization default `GITHUB_TOKEN` permissions MUST be restricted to **Read repository contents and packages**; workflows declare their own minimal scopes.

## 2. Action & Checkout Supply-Chain Pinning
- Every `uses:` reference MUST be pinned to an immutable 40-character lowercase commit SHA (`<owner>/<repo>@<40-hex> # vX.Y.Z`).
- Every `actions/checkout` step MUST specify `persist-credentials: false` so tokens (`GITHUB_TOKEN`, `MAVEN_PUBLISH_TOKEN`) are never written to `.git/config` on shared self-hosted runners.
- Steps requiring `git push` after checkout MUST use ephemeral per-step `GIT_ASKPASS` reading from `$GH_TOKEN` and cleaning up via `trap`.
- `self-test.yml` MUST pass `--ignore-scripts` to `npm ci --prefix tests`.

## 3. Untrusted Expression & Command-Injection Prevention
- Expressions (`${{ inputs.* }}`, `${{ steps.*.outputs.* }}`, `${{ needs.*.outputs.* }}`, `${{ github.event.* }}`, `${{ github.head_ref }}`, `${{ github.ref_name }}`) MUST NEVER be interpolated directly inside `run:` blocks.
- Every such value MUST be bound via step `env:` and referenced as double-quoted `"$VAR"`.
- Inline `python3 -c` / `node -e` invocations MUST pass filenames and untrusted values via `sys.argv` / `process.argv` or JSON-encoded `jq` arguments, never via string interpolation.

## 4. Strict Shell Mode, Path Validation & Runner Hygiene
- All bash `run:` steps MUST declare `shell: bash` and `set -euo pipefail`.
- PowerShell `run:` steps (`grafana-dashboards.yml`) MUST declare `shell: pwsh`, set `$ErrorActionPreference = 'Stop'`, verify file existence without symlinks, and propagate `$LASTEXITCODE`.
- `$GITHUB_OUTPUT` and `$GITHUB_ENV` MUST be double-quoted; multi-line `$GITHUB_ENV` writes MUST use randomized collision-checked heredoc delimiters.
- Relative path inputs (`migration-path`, `app-dir`, `kustomize_path`, `memory_bank_path`) MUST reject leading `/`, `~`, `-`, `..` segments, and newlines.
- Temporary workspaces on self-hosted runners MUST use `mktemp -d "${RUNNER_TEMP:-/tmp}/..."` with `trap` or `if: always()` cleanup, never static `/tmp/` filenames.
- `.gitattributes` enforces `eol=lf` across scripts, workflows, JS/CJS/MJS, JSON, and Markdown.
- `.github/actionlint.yaml` declares self-hosted runner labels (`kooker1-org`, `docker`); `rhysd/actionlint:1.7.7` MUST pass with 0 errors.

## 5. Verification
- Automated static security & public-safety enforcement: `node tests/check-workflow-security.test.cjs`
- Actionlint static analysis: `docker run --rm -v <repo>:/repo -w /repo rhysd/actionlint:1.7.7`
