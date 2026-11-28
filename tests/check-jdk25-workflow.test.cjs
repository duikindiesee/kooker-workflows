// tests/check-jdk25-workflow.test.cjs
// Contract + execution tests for .github/workflows/jdk25-baseline-guard.yml
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const yaml = require(path.resolve(__dirname, 'node_modules/yaml'));

const REPO_ROOT = path.resolve(__dirname, '..');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github/workflows/jdk25-baseline-guard.yml');
const raw = fs.readFileSync(WORKFLOW_PATH, 'utf8');
const doc = yaml.parseDocument(raw, { uniqueKeys: true });
assert.equal(doc.errors.length, 0);
const wf = doc.toJS();

const steps = wf.jobs.guard.steps;
const getStep = (name) => {
  const s = steps.find(x => x && x.name === name);
  assert.ok(s, `Missing step '${name}'`);
  return s;
};

const validateStep = getStep('Validate workflow inputs');
const layer2Step = getStep('Layer 2 — effective-configuration cross-check (parent-POM inheritance)');
const verdictStep = getStep('Final verdict');

const bashBin = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
const resolvedBash = fs.existsSync(bashBin) ? bashBin : 'bash';

// 1. Validate inputs: positive & injection negative cases
for (const [minVer, wfRef, expected] of [
  ['25', '', 0],
  ['26', 'main', 0],
  ['24', '', 1],
  ['0', '', 1],
  ['25"; id; #', '', 1],
  ['25', '../evil', 1],
  ['25', '-flag', 1],
  ['25', 'main; touch pwned', 1],
]) {
  const res = spawnSync(resolvedBash, ['-c', validateStep.run], {
    env: { ...process.env, MINIMUM_JAVA_VERSION: minVer, WORKFLOWS_REF: wfRef },
    encoding: 'utf8',
  });
  assert.equal(res.status, expected,
    `Validate inputs (${minVer}, ${wfRef}): expected ${expected}, got ${res.status}: ${res.stderr}`);
}
console.log('PASS jdk25-baseline-guard.yml input validation & injection rejection (8 cases)');

// 2. Layer 2 effective-configuration cross-check with mocked mvn
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jdk25-wf-test-'));
try {
  const binDir = path.join(tmp, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const mockMvn = path.join(binDir, 'mvn');
  fs.writeFileSync(mockMvn, `#!/usr/bin/env bash
echo "\${MOCK_MVN_OUT:-}"
`, { mode: 0o755 });

  const runLayer2 = (pomContent, mockMvnOut, minVer = '25') => {
    const work = fs.mkdtempSync(path.join(tmp, 'work-'));
    fs.writeFileSync(path.join(work, 'pom.xml'), pomContent, 'utf8');
    const ghOut = path.join(work, 'github_output.txt');
    fs.writeFileSync(ghOut, '', 'utf8');
    const r = spawnSync(resolvedBash, ['-c', layer2Step.run], {
      cwd: work,
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        MINIMUM: minVer,
        MOCK_MVN_OUT: mockMvnOut,
        GITHUB_OUTPUT: ghOut,
      },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `Layer 2 step exited ${r.status}: ${r.stderr}`);
    const out = fs.readFileSync(ghOut, 'utf8');
    const m = out.match(/exit-code=(\d+)/);
    assert.ok(m, `Missing exit-code in GITHUB_OUTPUT: ${out}`);
    return { code: m[1], stdout: r.stdout, stderr: r.stderr };
  };

  // Below-25 effective value -> exit-code=1
  const below = runLayer2('<project><artifactId>svc</artifactId></project>', '17');
  assert.equal(below.code, '1', 'Effective version 17 must produce exit-code=1');

  // Unresolvable effective value on non-aggregator -> fail closed exit-code=1
  const unres = runLayer2('<project><artifactId>svc</artifactId></project>', 'null object or invalid expression');
  assert.equal(unres.code, '1', 'Unresolvable non-aggregator POM must fail closed');

  // Pure packaging=pom aggregator without parent -> skipped cleanly (exit-code=0)
  const agg = runLayer2('<project><packaging>pom</packaging></project>', 'null object or invalid expression');
  assert.equal(agg.code, '0', 'Pure packaging=pom aggregator should be skipped');

  // Effective 25 -> exit-code=0
  const ok = runLayer2('<project><artifactId>svc</artifactId></project>', '25');
  assert.equal(ok.code, '0', 'Effective version 25 must produce exit-code=0');

  // Final verdict step checks
  const ghVerdictOut = path.join(tmp, 'verdict_out.txt');
  fs.writeFileSync(ghVerdictOut, '', 'utf8');
  const vFail = spawnSync(resolvedBash, ['-c', verdictStep.run], {
    env: { ...process.env, STATIC_CODE: '2', EFFECTIVE_CODE: '1', MINIMUM_JAVA_VERSION: '25', GITHUB_OUTPUT: ghVerdictOut },
    encoding: 'utf8',
  });
  assert.equal(vFail.status, 1, 'Final verdict must fail when effective_code=1');

  fs.writeFileSync(ghVerdictOut, '', 'utf8');
  const vPass = spawnSync(resolvedBash, ['-c', verdictStep.run], {
    env: { ...process.env, STATIC_CODE: '2', EFFECTIVE_CODE: '0', MINIMUM_JAVA_VERSION: '25', GITHUB_OUTPUT: ghVerdictOut },
    encoding: 'utf8',
  });
  assert.equal(vPass.status, 0, 'Final verdict must pass when effective_code=0');

  console.log('PASS jdk25-baseline-guard.yml Layer 2 mocked mvn + Final verdict checks');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
