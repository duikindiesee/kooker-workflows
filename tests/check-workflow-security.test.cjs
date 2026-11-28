// tests/check-workflow-security.test.cjs
// Repo-wide static security & public-safety gate across all 12 workflows,
// scripts, tests, and docs.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const yaml = require(path.resolve(__dirname, 'node_modules/yaml'));

const REPO_ROOT = path.resolve(__dirname, '..');
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github/workflows');

const workflowFiles = fs.readdirSync(WORKFLOWS_DIR)
  .filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
  .sort();

assert.equal(workflowFiles.length, 12, `Expected 12 workflows, found ${workflowFiles.length}: ${workflowFiles.join(', ')}`);

const UNTRUSTED_EXPR_RE = /\$\{\{\s*(inputs\.|steps\.[^}]*\.outputs\.|needs\.[^}]*\.outputs\.|github\.event\.|github\.head_ref|github\.ref_name)/;
const SHA_PIN_RE = /^[^@]+@[0-9a-f]{40}$/;

for (const file of workflowFiles) {
  const fullPath = path.join(WORKFLOWS_DIR, file);
  const raw = fs.readFileSync(fullPath, 'utf8');

  // Enforce LF line endings on tracked workflows
  assert.ok(!raw.includes('\r\n'), `${file}: contains CRLF line endings`);

  const doc = yaml.parseDocument(raw, { uniqueKeys: true });
  assert.equal(doc.errors.length, 0, `${file}: YAML parse errors: ${doc.errors.map(e => e.message).join('; ')}`);

  const obj = doc.toJS();
  assert.ok(obj && typeof obj === 'object', `${file}: parsed document must be an object`);

  // Top-level permissions must be explicit and either {} or read-only
  assert.ok(obj.permissions !== undefined && obj.permissions !== null && typeof obj.permissions === 'object',
    `${file}: missing top-level permissions: block`);
  assert.notEqual(obj.permissions, 'write-all', `${file}: write-all permissions forbidden`);
  for (const [scope, level] of Object.entries(obj.permissions)) {
    assert.equal(level, 'read', `${file}: top-level permission '${scope}' should be scoped to jobs, not '${level}'`);
  }

  assert.ok(obj.jobs && typeof obj.jobs === 'object', `${file}: missing jobs`);
  for (const [jobName, job] of Object.entries(obj.jobs)) {
    assert.ok(job && job.permissions && typeof job.permissions === 'object',
      `${file} job '${jobName}': missing explicit job-level permissions:`);
    assert.notEqual(job.permissions, 'write-all', `${file} job '${jobName}': write-all forbidden`);

    assert.ok(Array.isArray(job.steps), `${file} job '${jobName}': steps must be an array`);
    for (const step of job.steps) {
      if (step.uses) {
        assert.match(step.uses, SHA_PIN_RE, `${file} job '${jobName}' step '${step.name}': action '${step.uses}' must be pinned to 40-char SHA`);
        if (step.uses.startsWith('actions/checkout@')) {
          assert.equal(step.with && step.with['persist-credentials'], false,
            `${file} job '${jobName}' step '${step.name}': actions/checkout must set persist-credentials: false`);
        }
      }
      if (step.run) {
        assert.ok(!UNTRUSTED_EXPR_RE.test(step.run),
          `${file} job '${jobName}' step '${step.name}': untrusted \${{ }} expression found inside run: script`);
        if (step.shell === 'bash' || (!step.shell && file !== 'grafana-dashboards.yml')) {
          assert.ok(step.run.includes('set -euo pipefail'),
            `${file} job '${jobName}' step '${step.name}': bash run: block must include 'set -euo pipefail'`);
        }
      }
    }
  }
  console.log(`PASS security invariants: .github/workflows/${file}`);
}

// Targeted gitops-sync.yml path quoting & scoped git add check
const gitopsText = fs.readFileSync(path.join(WORKFLOWS_DIR, 'gitops-sync.yml'), 'utf8');
assert.ok(!/git add \./.test(gitopsText), 'gitops-sync.yml must not run unscoped git add .');
assert.match(gitopsText, /kustomize edit set image "\$\{IMAGE_NAME\}=\$\{IMAGE_NAME\}:\$\{NEW_TAG\}"/,
  'gitops-sync.yml must quote kustomize edit set image argument');
assert.match(gitopsText, /git add -- "\$\{CANONICAL_KUSTOMIZE_PATH\}"/,
  'gitops-sync.yml must scope git add to canonical kustomize path');
console.log('PASS gitops-sync.yml path quoting & scoped git add checks');

// Public-safety scan across all tracked/repo files (excluding node_modules and .git)
const FORBIDDEN_PATTERNS = [
  { name: 'private /home/ path', re: /\/home\/kooker\b/i },
  { name: 'private /Users/ path', re: /\/Users\/[A-Za-z0-9._-]+/ },
  { name: 'private Windows path', re: /[A-Za-z]:\\(Users|infra|workstreams)\\/i },
  { name: 'default admin/admin creds', re: /admin\/admin/ },
  { name: 'personal name memory bank', re: /irwin_?s?_memory_bank/i },
  { name: 'internal bridge reference', re: /bridge\/to-mojojo|MoJoJo|\bMoJo\b/ },
  { name: 'RFC1918 IP', re: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/ },
];

function walkFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

const repoFiles = walkFiles(REPO_ROOT);
for (const f of repoFiles) {
  const rel = path.relative(REPO_ROOT, f).replaceAll('\\', '/');
  // This security test itself names forbidden patterns in regex definitions
  if (rel === 'tests/check-workflow-security.test.cjs') continue;
  const content = fs.readFileSync(f, 'utf8');
  for (const { name, re } of FORBIDDEN_PATTERNS) {
    assert.ok(!re.test(content), `Public safety violation (${name}) found in ${rel}`);
  }
}
console.log(`PASS public-safety scan across ${repoFiles.length} repository file(s)`);
