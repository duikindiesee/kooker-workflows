// tests/check-misc-workflows.test.cjs
// Contract verification for grafana-dashboards.yml and self-test.yml
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const yaml = require(path.resolve(__dirname, 'node_modules/yaml'));

const REPO_ROOT = path.resolve(__dirname, '..');

// 1. grafana-dashboards.yml fail-closed checks
{
  const raw = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/grafana-dashboards.yml'), 'utf8');
  const wf = yaml.parse(raw);
  assert.deepEqual(wf.permissions, {});
  assert.deepEqual(wf.jobs['load-grafana'].permissions, { contents: 'read' });
  const runStep = wf.jobs['load-grafana'].steps.find(s => s.name === 'Load Grafana Dashboards via script');
  assert.ok(runStep, 'Missing Load Grafana step');
  assert.equal(runStep.shell, 'pwsh');
  assert.match(runStep.run, /\$ErrorActionPreference = 'Stop'/);
  assert.match(runStep.run, /Test-Path -LiteralPath \$scriptPath -PathType Leaf/);
  assert.match(runStep.run, /\$null -ne \$item\.LinkType/);
  assert.match(runStep.run, /\$LASTEXITCODE/);
  assert.match(runStep.run, /KOOKER_GRAFANA_PAT/);
  console.log('PASS grafana-dashboards.yml fail-closed contract checks');
}

// 2. self-test.yml completeness: must invoke EVERY *.test.sh and *.cjs in tests/
{
  const selfTestRaw = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/self-test.yml'), 'utf8');
  const wf = yaml.parse(selfTestRaw);
  assert.deepEqual(wf.permissions, {});
  assert.deepEqual(wf.jobs['script-tests'].permissions, { contents: 'read' });

  const allStepRuns = wf.jobs['script-tests'].steps
    .map(s => s.run || '')
    .join('\n');

  assert.match(allStepRuns, /npm ci --prefix tests --ignore-scripts/,
    'self-test.yml must install test deps with --ignore-scripts');
  assert.match(allStepRuns, /actionlint/,
    'self-test.yml must execute actionlint');

  const testFiles = fs.readdirSync(path.join(REPO_ROOT, 'tests'))
    .filter(f => f.endsWith('.test.sh') || f.endsWith('.cjs'))
    .sort();

  for (const tf of testFiles) {
    assert.ok(allStepRuns.includes(`tests/${tf}`),
      `self-test.yml omits test file tests/${tf}`);
  }
  console.log(`PASS self-test.yml invokes all ${testFiles.length} test suites + actionlint`);
}
