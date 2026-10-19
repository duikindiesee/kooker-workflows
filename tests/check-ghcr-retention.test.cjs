// Contract + mocked execution of the actual GHCR retention step against simulated GitHub REST API.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');

const workflowPath = '.github/workflows/ghcr-retention.yml';
const workflowText = fs.readFileSync(workflowPath, 'utf8').replaceAll('\r\n', '\n');

// 1. Structure, inputs, runner, permissions, and shell contract verification
assert.match(workflowText, /name:\s*GHCR Centralized Retention \(semver protected\)/);
assert.match(workflowText, /package-name:/);
assert.match(workflowText, /min-versions-to-keep:/);
assert.match(workflowText, /ignore-versions:/);
assert.ok(workflowText.includes('default: "^v?[0-9]+\\\\.[0-9]+\\\\.[0-9]+$"'), 'default semver regex preserved');
assert.match(workflowText, /runs-on:\s*\[self-hosted, Linux, X64, kooker1-org, docker\]/);
assert.match(workflowText, /packages:\s*write/);

// Shared runtime contract assertion binding official actions/setup-node@v6 and exact scalar 24 to SAME setup step before actual prune consumer
function assertRuntimeContract(content) {
  const setupMarker = '- name: Set up Node.js\n';
  const setupStart = content.indexOf(setupMarker);
  assert(setupStart >= 0, 'Step "Set up Node.js" must exist');

  const restAfterSetup = content.slice(setupStart);
  const nextStepRel = restAfterSetup.slice(setupMarker.length).search(/\n\s{6}-\s+name:/);
  const setupStepBlock = nextStepRel >= 0 ? restAfterSetup.slice(0, setupMarker.length + nextStepRel) : restAfterSetup;

  assert.match(setupStepBlock, /uses:\s*actions\/setup-node@v6/, 'Setup step must use official actions/setup-node@v6');
  assert.match(setupStepBlock, /node-version:\s*24(?:\s|$)/, 'Setup step must explicitly specify scalar node-version 24');

  const pruneMarker = '- name: Prune old image tags\n';
  const pruneStart = content.indexOf(pruneMarker);
  assert(pruneStart >= 0, 'Step "Prune old image tags" must exist');

  assert(setupStart < pruneStart, 'Setup step must precede Prune old image tags step');

  const pruneStepRest = content.slice(pruneStart);
  const nextPruneRel = pruneStepRest.slice(pruneMarker.length).search(/\n\s{6}-\s+name:/);
  const pruneStepBlock = nextPruneRel >= 0 ? pruneStepRest.slice(0, pruneMarker.length + nextPruneRel) : pruneStepRest;
  assert.match(pruneStepBlock, /shell:\s*node\s*\{0\}/, 'Prune step must declare shell: node {0}');
}

// 1. Positive validation on actual workflow content
assertRuntimeContract(workflowText);

// 2. Genuine negative controls mutating actual full workflow content:
{
  // Negative A: Remove setup step completely
  const noSetup = workflowText.replace(/- name: Set up Node\.js[\s\S]*?(?=- name: Prune old image tags)/, '');
  assert.throws(() => assertRuntimeContract(noSetup), /Step "Set up Node.js" must exist/, 'negative A: missing setup step must fail');

  // Negative B: Change SAME setup step 24 -> 18
  const wrongVersion = workflowText.replace(/node-version:\s*24/, 'node-version: 18');
  assert.throws(() => assertRuntimeContract(wrongVersion), /node-version 24/, 'negative B: wrong version in setup step must fail');

  // Negative C: Relocate actual complete setup step AFTER actual prune consumer
  const setupMatch = workflowText.match(/- name: Set up Node\.js[\s\S]*?(?=- name: Prune old image tags)/);
  assert(setupMatch, 'setup step block must be found for relocation test');
  const setupChunk = setupMatch[0];
  const withoutSetup = workflowText.replace(setupChunk, '');
  const relocatedAfterPrune = withoutSetup + '\n' + setupChunk;
  assert.throws(() => assertRuntimeContract(relocatedAfterPrune), /Setup step must precede/, 'negative C: setup step placed after prune consumer must fail');

  // Negative D: Wrong setup 18 with unrelated 24 elsewhere in workflow
  const wrongSetupUnrelated24 = workflowText.replace(/node-version:\s*24/, 'node-version: 18')
    .replace('prune-ghcr:', 'prune-ghcr:\n    # unrelated comment with 24\n    # timeout-minutes: 24');
  assert.throws(() => assertRuntimeContract(wrongSetupUnrelated24), /node-version 24/, 'negative D: wrong setup 18 + unrelated 24 must fail');
}

console.log('PASS workflow metadata, interface, runner, permissions, setup-node v6 (Node 24) order, and shell: node {0} contract');

// 2. Extract step execution logic
function extractStep(workflowContent) {
  if (workflowContent.includes('uses: actions/delete-package-versions@v5')) {
    return { type: 'upstream-action' };
  }
  const marker = '- name: Prune old image tags\n';
  const start = workflowContent.indexOf(marker);
  assert(start >= 0, 'Step "Prune old image tags" must exist');
  const rest = workflowContent.slice(start + marker.length);
  const nextStep = rest.search(/\n\s{6}-\s+name:/);
  const stepBlock = nextStep >= 0 ? rest.slice(0, nextStep) : rest;

  assert.match(stepBlock, /shell:\s*node\s*\{0\}/, 'extracted step must declare shell: node {0}');
  
  const runMarker = 'run: |\n';
  const runStart = stepBlock.indexOf(runMarker);
  assert(runStart >= 0, 'Step must contain run block');
  const rawRun = stepBlock.slice(runStart + runMarker.length);
  // Unindent 10 spaces
  const script = rawRun
    .split('\n')
    .map(line => line.startsWith('          ') ? line.slice(10) : (line.trim() === '' ? '' : line))
    .join('\n');
  return { type: 'inline-node', shell: 'node {0}', script };
}

const currentStep = extractStep(workflowText);

// Verification of upstream RED:
// When upstream actions/delete-package-versions@v5 was used, it inspected info.version = version.name (sha256:...)
// rather than metadata.container.tags.
// Here we document the MoJo independent review attribution and provide simulated selector check.
function simulateUpstreamSelector(versions, ignoreRegex, minVersionsToKeep) {
  // Upstream get-versions.ts line 71:
  // info.version = version.name
  // delete.ts line 77:
  // value = value.filter(info => !input.ignoreVersions.test(info.version))
  // delete.ts lines 65-72: sort oldest first
  const sorted = [...versions].sort((a, b) => {
    if (a.created_at === b.created_at) return a.id - b.id;
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });
  const filtered = sorted.filter(info => !ignoreRegex.test(info.name)); // upstream checks version.name only!
  const toDeleteCount = Math.min(filtered.length - minVersionsToKeep, 100);
  if (toDeleteCount <= 0) return [];
  return filtered.slice(0, toDeleteCount).map(v => v.id);
}

if (process.argv.includes('--check-unmodified-red')) {
  console.log('=== Verifying Upstream Action Defect (RED Control) ===');
  console.log('Attribution: MoJo independently verified upstream defect at commit e5bc658cc4c965c472efe991f8beea3981499c55:');
  console.log('- Upstream actions/delete-package-versions@v5 getOldestVersions extracts info.version = version.name (e.g. sha256:...)');
  console.log('- Upstream finalIds evaluates input.ignoreVersions.test(info.version), completely ignoring metadata.container.tags');
  console.log('- In 61 digest-name versions where oldest has tags [\"branch-old\", \"v1.2.3\"], ID 1 is selected for deletion by upstream.');

  const regex = /^v?[0-9]+\.[0-9]+\.[0-9]+$/;
  const versions = [];
  versions.push({ id: 1, name: 'sha256:1111111111111111111111111111111111111111111111111111111111111111', created_at: '2026-01-01T00:00:00Z', tags: ['branch-old', 'v1.2.3'] });
  for (let i = 2; i <= 61; i++) {
    versions.push({ id: i, name: `sha256:${String(i).padStart(64, '0')}`, created_at: `2026-01-02T${String(i).padStart(2, '0')}:00:00Z`, tags: [`branch-${i}`] });
  }

  const upstreamDeleted = simulateUpstreamSelector(versions, regex, 60);
  console.log('Attributed upstream selector selected IDs for deletion:', upstreamDeleted);
  assert.deepEqual(upstreamDeleted, [1], 'RED PROOF: Upstream action deletes version 1 despite semver tag v1.2.3!');
  console.log('RED CONFIRMED: Upstream actions/delete-package-versions@v5 deletes semver-tagged release images (ID 1 selected).');

  // Also confirm positive control: if oldest has branch-only tag, it IS selected
  const branchOnlyVersions = [];
  branchOnlyVersions.push({ id: 1, name: 'sha256:1111111111111111111111111111111111111111111111111111111111111111', created_at: '2026-01-01T00:00:00Z', tags: ['branch-old'] });
  for (let i = 2; i <= 61; i++) {
    branchOnlyVersions.push({ id: i, name: `sha256:${String(i).padStart(64, '0')}`, created_at: `2026-01-02T${String(i).padStart(2, '0')}:00:00Z`, tags: [`branch-${i}`] });
  }
  const branchOnlyDeleted = simulateUpstreamSelector(branchOnlyVersions, regex, 60);
  assert.deepEqual(branchOnlyDeleted, [1], 'Positive control: branch-only snapshot pruned as expected.');
  console.log('PASS valid positive control: unprotected branch-only snapshot selected for deletion');
  process.exit(0);
}

// Helper to run a test case against an asynchronous mock HTTP server with finite timeout and full cleanup
async function runRetentionTest(testCase) {
  const deletedIds = [];
  const getRequests = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET') {
      getRequests.push(url.pathname + url.search);
      const page = parseInt(url.searchParams.get('page') || '1', 10);
      const perPage = parseInt(url.searchParams.get('per_page') || '100', 10);

      if (testCase.trickleAtPage && page === testCase.trickleAtPage) {
        // Continuous slow trickle exceeding total request deadline while keeping below inactivity timer
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('[');
        const tick = setInterval(() => res.write(' '), testCase.trickleIntervalMs || 20);
        const end = setTimeout(() => {
          clearInterval(tick);
          res.end(']');
        }, testCase.trickleDurationMs || 500);
        res.on('close', () => {
          clearInterval(tick);
          clearTimeout(end);
        });
        return;
      }

      if (testCase.delayAtPage && page === testCase.delayAtPage) {
        // Delay response but complete within valid bounds
        setTimeout(() => {
          const all = testCase.versions || [];
          const start = (page - 1) * perPage;
          const slice = all.slice(start, start + perPage);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(slice));
        }, testCase.delayMs || 30);
        return;
      }

      if (testCase.stallAtPage && page === testCase.stallAtPage) {
        // Send headers and part of body then stall without ending
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('[\n');
        // Do not call res.end() to trigger stream stall timeout
        return;
      }

      if (testCase.oversizeAtPage && page === testCase.oversizeAtPage) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // Send a chunk larger than testCase.maxResponseBytes or 5MB
        const bigPayload = JSON.stringify([{ id: 1, name: 'x'.repeat(10000) }]);
        res.end(bigPayload);
        return;
      }

      if (testCase.repeatedPage) {
        // Repeatedly emit the same full page of 100 items regardless of page query
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(testCase.repeatedPage));
        return;
      }

      if (testCase.infinitePages) {
        // Emits a unique full page of 100 items on every page query forever
        const pageVersions = [];
        const baseId = (page - 1) * perPage;
        for (let i = 1; i <= perPage; i++) {
          const id = baseId + i;
          pageVersions.push({
            id,
            name: `sha256:${id.toString().padStart(64, '0')}`,
            created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)).toISOString(),
            metadata: { container: { tags: [`branch-${id}`] } }
          });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(pageVersions));
        return;
      }

      if (testCase.pageFailAt && page === testCase.pageFailAt) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Internal Server Error simulated' }));
        return;
      }
      if (testCase.malformedJson) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{ invalid json');
        return;
      }

      const all = testCase.versions || [];
      const start = (page - 1) * perPage;
      const slice = all.slice(start, start + perPage);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(slice));
      return;
    }

    if (req.method === 'DELETE') {
      const match = url.pathname.match(/\/versions\/(\d+)$/);
      if (match) {
        deletedIds.push(parseInt(match[1], 10));
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
      return;
    }

    res.writeHead(405);
    res.end();
  });

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.on('error', reject);
  });

  const port = server.address().port;
  const mockApiUrl = `http://127.0.0.1:${port}`;

  let child;
  let timeoutHandle;

  try {
    const inputs = testCase.inputs || {};
    const env = {
      ...process.env,
      GITHUB_API_URL: mockApiUrl,
      GITHUB_REPOSITORY_OWNER: inputs.owner || 'duikindiesee',
      INPUT_PACKAGE_NAME: inputs.packageName !== undefined ? inputs.packageName : 'test-image',
      INPUT_MIN_VERSIONS_TO_KEEP: inputs.minVersionsToKeep !== undefined ? String(inputs.minVersionsToKeep) : '60',
      INPUT_IGNORE_VERSIONS: inputs.ignoreVersions !== undefined ? inputs.ignoreVersions : '^v?[0-9]+\\.[0-9]+\\.[0-9]+$',
      INPUT_TOKEN: inputs.token || 'synthetic-token',
      ...(testCase.requestTimeoutMs ? { GITHUB_REQUEST_TIMEOUT_MS: String(testCase.requestTimeoutMs) } : {}),
      ...(testCase.streamInactivityMs ? { GITHUB_STREAM_INACTIVITY_MS: String(testCase.streamInactivityMs) } : {}),
      ...(testCase.maxResponseBytes ? { GITHUB_MAX_RESPONSE_BYTES: String(testCase.maxResponseBytes) } : {})
    };

    assert.equal(currentStep.type, 'inline-node', 'Workflow step must be inline node execution');

    // Declared shell template expanded as an argument vector, script read from file; no node -e.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-test-'));
    const scriptFile = path.join(tempDir, 'step-script.cjs');
    fs.writeFileSync(scriptFile, currentStep.script);

    const args = currentStep.shell.split(' ');
    assert.equal(args.shift(), 'node', 'Shell template must start with node executable');
    const commandArgs = args.map(x => x === '{0}' ? scriptFile : x);

    const result = await new Promise((resolve, reject) => {
      // 5-second per-test timeout
      timeoutHandle = setTimeout(() => {
        if (child) child.kill('SIGKILL');
        reject(new Error(`Test timed out after 5000ms: ${testCase.description || 'unnamed'}`));
      }, 5000);

      // Simulates GitHub Actions runner invoking declared shell: node {0} via scriptfile
      child = spawn(process.execPath, commandArgs, { env });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });

      child.on('close', (status, signal) => {
        clearTimeout(timeoutHandle);
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
        resolve({ status, signal, stdout, stderr });
      });

      child.on('error', (err) => {
        clearTimeout(timeoutHandle);
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
        reject(err);
      });
    });

    assert.equal(
      result.status,
      testCase.expectedExit,
      `Expected exit ${testCase.expectedExit}, got ${result.status}. Stdout: ${result.stdout} Stderr: ${result.stderr}`
    );

    if (testCase.expectedDeletions) {
      assert.deepEqual(
        deletedIds,
        testCase.expectedDeletions,
        `Deleted IDs mismatch: expected ${JSON.stringify(testCase.expectedDeletions)}, got ${JSON.stringify(deletedIds)}`
      );
    }

    return { stdout: result.stdout, stderr: result.stderr, deletedIds };
  } finally {
    clearTimeout(timeoutHandle);
    if (child && child.exitCode === null) {
      child.kill('SIGKILL');
    }
    server.close();
  }
}

async function runAllTests() {
  console.log('Running test suite for GHCR centralized tag-aware retention (shell: node {0})...');

  // Overall test suite safety timeout (30 seconds)
  const overallTimeout = setTimeout(() => {
    console.error('FATAL: Overall test suite timeout (30s) reached!');
    process.exit(1);
  }, 30000);

  function makeVersion(id, createdAt, tags, name = `sha256:${id.toString().padStart(64, '0')}`) {
    return {
      id,
      name,
      created_at: createdAt,
      metadata: {
        container: {
          tags: tags || []
        }
      }
    };
  }

  try {
    // Test 1: 1 protected semver + 61 unprotected versions. Floor 60.
    // Unprotected count = 61. Kept unprotected = 60. Exactly 1 unprotected deleted (ID 2).
    // ID 1 is semver '1.2.3', older than floor, but PROTECTED.
    {
      const versions = [];
      const baseTime = new Date('2026-01-01T00:00:00Z').getTime();
      versions.push(makeVersion(1, new Date(baseTime).toISOString(), ['1.2.3']));
      for (let i = 2; i <= 62; i++) {
        versions.push(makeVersion(i, new Date(baseTime + i * 1000).toISOString(), [`branch-feat-${i}`]));
      }
      const res = await runRetentionTest({
        description: 'Test 1: plain semver protected, 1 oldest unprotected pruned',
        versions,
        inputs: { minVersionsToKeep: 60 },
        expectedExit: 0,
        expectedDeletions: [2]
      });
      console.log('PASS test 1: plain semver 1.2.3 protected when older than floor, branch snapshot pruned');
    }

    // Test 2: v-semver tag 'v1.2.3' protected.
    {
      const versions = [];
      const baseTime = new Date('2026-01-01T00:00:00Z').getTime();
      versions.push(makeVersion(1, new Date(baseTime).toISOString(), ['v1.2.3']));
      for (let i = 2; i <= 62; i++) {
        versions.push(makeVersion(i, new Date(baseTime + i * 1000).toISOString(), [`snapshot-${i}`]));
      }
      const res = await runRetentionTest({
        description: 'Test 2: v-semver protected',
        versions,
        inputs: { minVersionsToKeep: 60 },
        expectedExit: 0,
        expectedDeletions: [2]
      });
      console.log('PASS test 2: v-semver v1.2.3 protected');
    }

    // Test 3: Mixed tags ['branch-old', 'v1.2.3']. Whole version protected!
    {
      const versions = [];
      const baseTime = new Date('2026-01-01T00:00:00Z').getTime();
      versions.push(makeVersion(1, new Date(baseTime).toISOString(), ['branch-old', 'v1.2.3']));
      for (let i = 2; i <= 62; i++) {
        versions.push(makeVersion(i, new Date(baseTime + i * 1000).toISOString(), [`snapshot-${i}`]));
      }
      const res = await runRetentionTest({
        description: 'Test 3: mixed tags protects whole version',
        versions,
        inputs: { minVersionsToKeep: 60 },
        expectedExit: 0,
        expectedDeletions: [2]
      });
      console.log('PASS test 3: mixed tags [branch-old, v1.2.3] protects whole version');
    }

    // Test 4: Floor enforcement — 60 unprotected versions (or fewer), 0 deletions.
    {
      const versions = [];
      const baseTime = new Date('2026-01-01T00:00:00Z').getTime();
      for (let i = 1; i <= 60; i++) {
        versions.push(makeVersion(i, new Date(baseTime + i * 1000).toISOString(), ['branch-snap']));
      }
      const res = await runRetentionTest({
        description: 'Test 4: floor enforcement <=60 noop',
        versions,
        inputs: { minVersionsToKeep: 60 },
        expectedExit: 0,
        expectedDeletions: []
      });
      console.log('PASS test 4: min-versions-to-keep floor (<=60) results in 0 deletes');
    }

    // Test 5: Rate limit batch cap: 250 versions, 0 protected. Floor 60.
    // 250 - 60 = 190 eligible. Rate limit is 100. Exactly 100 oldest deleted.
    {
      const versions = [];
      const baseTime = new Date('2026-01-01T00:00:00Z').getTime();
      for (let i = 1; i <= 250; i++) {
        versions.push(makeVersion(i, new Date(baseTime + i * 1000).toISOString(), ['dev']));
      }
      const expected = [];
      for (let i = 1; i <= 100; i++) expected.push(i);

      const res = await runRetentionTest({
        description: 'Test 5: batch rate limit 100',
        versions,
        inputs: { minVersionsToKeep: 60 },
        expectedExit: 0,
        expectedDeletions: expected
      });
      console.log('PASS test 5: batch rate limit caps deletions at 100');
    }

    // Test 6: Full pagination across pages (e.g. 150 versions = page 1 of 100, page 2 of 50).
    // All pages retrieved and validated before any DELETE.
    // 1 protected, 149 unprotected. Floor 60 -> 149 - 60 = 89 deletions.
    {
      const versions = [];
      const baseTime = new Date('2026-01-01T00:00:00Z').getTime();
      for (let i = 1; i <= 150; i++) {
        const tags = (i === 1) ? ['v2.0.0'] : ['branch'];
        versions.push(makeVersion(i, new Date(baseTime + i * 1000).toISOString(), tags));
      }
      const expected = [];
      for (let i = 2; i <= 90; i++) expected.push(i);

      const res = await runRetentionTest({
        description: 'Test 6: multi-page pagination',
        versions,
        inputs: { minVersionsToKeep: 60 },
        expectedExit: 0,
        expectedDeletions: expected
      });
      console.log('PASS test 6: multi-page pagination (150 items across 2 pages) handles floor and protection');
    }

    // Test 7: Fail-closed on API error during pagination (page 2 fails with 500).
    // Expected: Exit 1, ZERO deletes.
    {
      const versions = [];
      const baseTime = new Date('2026-01-01T00:00:00Z').getTime();
      for (let i = 1; i <= 150; i++) {
        versions.push(makeVersion(i, new Date(baseTime + i * 1000).toISOString(), ['dev']));
      }
      const res = await runRetentionTest({
        description: 'Test 7: pagination failure fails closed',
        versions,
        pageFailAt: 2,
        inputs: { minVersionsToKeep: 60 },
        expectedExit: 1,
        expectedDeletions: []
      });
      console.log('PASS test 7: pagination failure fails closed with 0 deletes');
    }

    // Test 8: Fail-closed on malformed JSON response.
    {
      const res = await runRetentionTest({
        description: 'Test 8: malformed JSON fails closed',
        malformedJson: true,
        inputs: { minVersionsToKeep: 60 },
        expectedExit: 1,
        expectedDeletions: []
      });
      console.log('PASS test 8: malformed JSON fails closed with 0 deletes');
    }

    // Test 9: Fail-closed on malformed metadata (missing container metadata object).
    {
      const versions = [
        { id: 1, name: 'sha256:111', created_at: '2026-01-01T00:00:00Z', metadata: null }
      ];
      const res = await runRetentionTest({
        description: 'Test 9: malformed metadata fails closed',
        versions,
        inputs: { minVersionsToKeep: 0 },
        expectedExit: 1,
        expectedDeletions: []
      });
      console.log('PASS test 9: malformed metadata fails closed with 0 deletes');
    }

    // Test 10: Fail-closed on invalid regex pattern.
    {
      const versions = [makeVersion(1, '2026-01-01T00:00:00Z', ['latest'])];
      const res = await runRetentionTest({
        description: 'Test 10: invalid regex fails closed',
        versions,
        inputs: { ignoreVersions: '[unclosed-bracket' },
        expectedExit: 1,
        expectedDeletions: []
      });
      console.log('PASS test 10: invalid regex pattern fails closed with 0 deletes');
    }

    // Test 11: Fail-closed on invalid min-versions-to-keep (negative).
    {
      const versions = [makeVersion(1, '2026-01-01T00:00:00Z', ['latest'])];
      const res = await runRetentionTest({
        description: 'Test 11: negative min-versions-to-keep fails closed',
        versions,
        inputs: { minVersionsToKeep: -5 },
        expectedExit: 1,
        expectedDeletions: []
      });
      console.log('PASS test 11: negative min-versions-to-keep fails closed with 0 deletes');
    }

    // Test 12: Deterministic oldest-first sort tie breaking by ID when created_at is identical.
    {
      const versions = [
        makeVersion(10, '2026-01-01T00:00:00Z', ['snap']),
        makeVersion(5, '2026-01-01T00:00:00Z', ['snap']),
        makeVersion(20, '2026-01-01T00:00:00Z', ['snap']),
      ];
      const res = await runRetentionTest({
        description: 'Test 12: tie-breaker by ID',
        versions,
        inputs: { minVersionsToKeep: 1 },
        expectedExit: 0,
        expectedDeletions: [5, 10]
      });
      console.log('PASS test 12: identical created_at tie-breaker uses ascending ID');
    }

    // Test 13: Strict metadata - invalid ID (non-positive / non-integer).
    {
      const versions = [
        { id: -1, name: 'sha256:111', created_at: '2026-01-01T00:00:00Z', metadata: { container: { tags: [] } } }
      ];
      const res = await runRetentionTest({
        description: 'Test 13: non-positive ID fails closed',
        versions,
        inputs: { minVersionsToKeep: 0 },
        expectedExit: 1,
        expectedDeletions: []
      });
      console.log('PASS test 13: non-positive ID fails closed with 0 deletes');
    }

    // Test 14: Strict metadata - invalid timestamp.
    {
      const versions = [
        { id: 1, name: 'sha256:111', created_at: 'invalid-date', metadata: { container: { tags: [] } } }
      ];
      const res = await runRetentionTest({
        description: 'Test 14: invalid timestamp fails closed',
        versions,
        inputs: { minVersionsToKeep: 0 },
        expectedExit: 1,
        expectedDeletions: []
      });
      console.log('PASS test 14: invalid timestamp fails closed with 0 deletes');
    }

    // Test 15: Strict metadata - non-string tag element.
    {
      const versions = [
        { id: 1, name: 'sha256:111', created_at: '2026-01-01T00:00:00Z', metadata: { container: { tags: [123] } } }
      ];
      const res = await runRetentionTest({
        description: 'Test 15: non-string tag element fails closed',
        versions,
        inputs: { minVersionsToKeep: 0 },
        expectedExit: 1,
        expectedDeletions: []
      });
      console.log('PASS test 15: non-string tag element fails closed with 0 deletes');
    }

    // Test 16: Strict integer validation on min-versions-to-keep: reject "60junk"
    {
      const versions = [makeVersion(1, '2026-01-01T00:00:00Z', ['latest'])];
      const res = await runRetentionTest({
        description: 'Test 16: trailing junk in min-versions-to-keep fails closed',
        versions,
        inputs: { minVersionsToKeep: '60junk' },
        expectedExit: 1,
        expectedDeletions: []
      });
      console.log('PASS test 16: trailing junk in min-versions-to-keep (60junk) fails closed with 0 deletes');
    }

    // Test 17: Strict integer validation on min-versions-to-keep: reject decimal "1.5"
    {
      const versions = [makeVersion(1, '2026-01-01T00:00:00Z', ['latest'])];
      const res = await runRetentionTest({
        description: 'Test 17: decimal in min-versions-to-keep fails closed',
        versions,
        inputs: { minVersionsToKeep: '1.5' },
        expectedExit: 1,
        expectedDeletions: []
      });
      console.log('PASS test 17: decimal in min-versions-to-keep (1.5) fails closed with 0 deletes');
    }

    // Test 18: Strict integer validation on min-versions-to-keep: reject "Infinity"
    {
      const versions = [makeVersion(1, '2026-01-01T00:00:00Z', ['latest'])];
      const res = await runRetentionTest({
        description: 'Test 18: Infinity in min-versions-to-keep fails closed',
        versions,
        inputs: { minVersionsToKeep: 'Infinity' },
        expectedExit: 1,
        expectedDeletions: []
      });
      console.log('PASS test 18: Infinity in min-versions-to-keep fails closed with 0 deletes');
    }

    // Test 19: Duplicate ID negative — Same-page conflicting metadata
    // (e.g. ID 1 protected mixed-tags and ID 1 branch-only on same page).
    // Fails closed with 0 deletes.
    {
      const baseTime = new Date('2026-01-01T00:00:00Z').getTime();
      const versions = [
        makeVersion(1, new Date(baseTime).toISOString(), ['branch-old', 'v1.2.3']),
        makeVersion(1, new Date(baseTime + 1000).toISOString(), ['branch-feat']),
      ];
      const res = await runRetentionTest({
        description: 'Test 19: same-page conflicting duplicate ID fails closed',
        versions,
        inputs: { minVersionsToKeep: 60 },
        expectedExit: 1,
        expectedDeletions: []
      });
      console.log('PASS test 19: same-page conflicting duplicate ID fails closed with 0 deletes');
    }

    // Test 20: Duplicate ID negative — Same-page identical metadata
    // (exact identical record returned twice on same page).
    // Fails closed with 0 deletes.
    {
      const baseTime = new Date('2026-01-01T00:00:00Z').getTime();
      const versions = [
        makeVersion(1, new Date(baseTime).toISOString(), ['branch-feat']),
        makeVersion(1, new Date(baseTime).toISOString(), ['branch-feat']),
      ];
      const res = await runRetentionTest({
        description: 'Test 20: same-page identical duplicate ID fails closed',
        versions,
        inputs: { minVersionsToKeep: 60 },
        expectedExit: 1,
        expectedDeletions: []
      });
      console.log('PASS test 20: same-page identical duplicate ID fails closed with 0 deletes');
    }

    // Test 21: Duplicate ID negative — Cross-page conflicting metadata
    // (ID 1 on page 1 with protected tags, ID 1 on page 2 with branch-only tags).
    // Fails closed with 0 deletes.
    {
      const baseTime = new Date('2026-01-01T00:00:00Z').getTime();
      const versions = [];
      versions.push(makeVersion(1, new Date(baseTime).toISOString(), ['branch-old', 'v1.2.3']));
      for (let i = 2; i <= 100; i++) {
        versions.push(makeVersion(i, new Date(baseTime + i * 1000).toISOString(), [`branch-${i}`]));
      }
      // On page 2 (item 101), inject duplicate ID 1 with conflicting tags
      versions.push(makeVersion(1, new Date(baseTime + 101000).toISOString(), ['branch-conflict']));
      const res = await runRetentionTest({
        description: 'Test 21: cross-page conflicting duplicate ID fails closed',
        versions,
        inputs: { minVersionsToKeep: 60 },
        expectedExit: 1,
        expectedDeletions: []
      });
      console.log('PASS test 21: cross-page conflicting duplicate ID fails closed with 0 deletes');
    }

    // Test 22: Duplicate ID negative — Cross-page identical metadata
    // (ID 1 repeated on page 2 with identical metadata).
    // Fails closed with 0 deletes.
    {
      const baseTime = new Date('2026-01-01T00:00:00Z').getTime();
      const versions = [];
      for (let i = 1; i <= 100; i++) {
        versions.push(makeVersion(i, new Date(baseTime + i * 1000).toISOString(), [`branch-${i}`]));
      }
      // On page 2, repeat ID 1 identically
      versions.push(makeVersion(1, new Date(baseTime + 1000).toISOString(), ['branch-1']));
      const res = await runRetentionTest({
        description: 'Test 22: cross-page identical duplicate ID fails closed',
        versions,
        inputs: { minVersionsToKeep: 60 },
        expectedExit: 1,
        expectedDeletions: []
      });
      console.log('PASS test 22: cross-page identical duplicate ID fails closed with 0 deletes');
    }

    // Test 23: Production deadline negative — Stalled response data stream fails closed with 0 deletes
    {
      const res = await runRetentionTest({
        description: 'Test 23: stalled response stream fails closed',
        stallAtPage: 1,
        streamInactivityMs: 100, // 100ms idle inactivity threshold
        requestTimeoutMs: 1000, // 1s overall timeout
        inputs: { minVersionsToKeep: 60 },
        expectedExit: 1,
        expectedDeletions: []
      });
      assert.match(res.stderr, /\[ERR_RESPONSE_STALLED\]/, 'stderr must report [ERR_RESPONSE_STALLED] sentinel');
      console.log('PASS test 23: stalled response stream fails closed with 0 deletes');
    }

    // Test 24: Production byte cap negative — Response exceeding byte limit fails closed with 0 deletes
    {
      const res = await runRetentionTest({
        description: 'Test 24: response exceeding byte limit fails closed',
        oversizeAtPage: 1,
        maxResponseBytes: 100, // Small byte limit to trigger oversize guard
        inputs: { minVersionsToKeep: 60 },
        expectedExit: 1,
        expectedDeletions: []
      });
      assert.match(res.stderr, /\[ERR_RESPONSE_OVERSIZE\]/, 'stderr must report [ERR_RESPONSE_OVERSIZE] sentinel');
      console.log('PASS test 24: response exceeding byte cap fails closed with 0 deletes');
    }

    // Test 25: Repeated full page negative — Unbounded loop detection fails closed with 0 deletes
    {
      const repeatedPage = Array.from({ length: 100 }, (_, k) => makeVersion(k + 1, '2026-01-01T00:00:00Z', [`branch-${k + 1}`]));
      const res = await runRetentionTest({
        description: 'Test 25: repeated full page fails closed',
        repeatedPage,
        inputs: { minVersionsToKeep: 60 },
        expectedExit: 1,
        expectedDeletions: []
      });
      assert.match(res.stderr, /\[ERR_DUPLICATE_VERSION_ID\]/, 'stderr must report [ERR_DUPLICATE_VERSION_ID] sentinel');
      console.log('PASS test 25: repeated full page pagination fails closed with 0 deletes');
    }

    // Test 26: Max page traversal negative — Traversal exceeding MAX_PAGE_TRAVERSAL (50 pages) fails closed with 0 deletes
    {
      const res = await runRetentionTest({
        description: 'Test 26: max page traversal limit fails closed',
        infinitePages: true,
        inputs: { minVersionsToKeep: 60 },
        expectedExit: 1,
        expectedDeletions: []
      });
      assert.match(res.stderr, /\[ERR_PAGE_LIMIT_EXCEEDED\]/, 'stderr must report [ERR_PAGE_LIMIT_EXCEEDED] sentinel');
      console.log('PASS test 26: max page traversal limit (50 pages) fails closed with 0 deletes');
    }

    // Test 27: Safe diagnostics containment — Raw API error response or secrets are NOT leaked to stderr
    {
      const res = await runRetentionTest({
        description: 'Test 27: safe diagnostics containment',
        pageFailAt: 1,
        inputs: { minVersionsToKeep: 60, token: 'SUPER_SECRET_TOKEN_SENTINEL' },
        expectedExit: 1,
        expectedDeletions: []
      });
      assert.ok(!res.stderr.includes('SUPER_SECRET_TOKEN_SENTINEL'), 'stderr must NEVER echo authorization token');
      assert.ok(!res.stdout.includes('SUPER_SECRET_TOKEN_SENTINEL'), 'stdout must NEVER echo authorization token');
      assert.match(res.stderr, /\[ERR_API_STATUS\]/, 'stderr must report [ERR_API_STATUS] sentinel');
      assert.ok(!res.stderr.includes('Internal Server Error simulated'), 'stderr must NOT echo raw response body');
      console.log('PASS test 27: safe diagnostic sentinels contain error output without echoing token or raw API body');
    }

    // Test 28: Valid unique multi-page pruning positive — 250 items across 3 pages (100 + 100 + 50)
    // Floor 60: 1 protected (v1.0.0), 249 unprotected -> 249 - 60 = 189 eligible, capped at RATE_LIMIT = 100.
    {
      const versions = [];
      const baseTime = new Date('2026-01-01T00:00:00Z').getTime();
      for (let i = 1; i <= 250; i++) {
        const tags = (i === 1) ? ['v1.0.0'] : [`branch-${i}`];
        versions.push(makeVersion(i, new Date(baseTime + i * 1000).toISOString(), tags));
      }
      const expected = [];
      for (let i = 2; i <= 101; i++) expected.push(i); // Exactly 100 oldest unprotected versions

      const res = await runRetentionTest({
        description: 'Test 28: unique multi-page pruning positive',
        versions,
        inputs: { minVersionsToKeep: 60 },
        expectedExit: 0,
        expectedDeletions: expected
      });
      console.log('PASS test 28: unique multi-page pruning positive (250 items across 3 pages) prunes 100 oldest unprotected with semver protected');
    }

    // Test 29: Production absolute deadline negative — Continuous slow trickle exceeds total request deadline (fails closed with 0 deletes)
    {
      const res = await runRetentionTest({
        description: 'Test 29: continuous trickle exceeds total request deadline',
        trickleAtPage: 1,
        trickleIntervalMs: 20,
        trickleDurationMs: 500,
        requestTimeoutMs: 50, // 50ms absolute deadline
        inputs: { minVersionsToKeep: 60 },
        expectedExit: 1,
        expectedDeletions: []
      });
      assert.match(res.stderr, /\[ERR_REQUEST_DEADLINE\]/, 'stderr must report [ERR_REQUEST_DEADLINE] sentinel');
      console.log('PASS test 29: continuous slow trickle exceeds absolute request deadline and fails closed with 0 deletes');
    }

    // Test 30: Valid delayed-in-bound positive — Normal network delay completes within absolute bound
    {
      const versions = [
        makeVersion(1, '2026-01-01T00:00:00Z', ['v1.0.0']), // protected
        makeVersion(2, '2026-01-02T00:00:00Z', ['branch-1']),
        makeVersion(3, '2026-01-03T00:00:00Z', ['branch-2']),
      ];
      const res = await runRetentionTest({
        description: 'Test 30: delayed within deadline completes successfully',
        versions,
        delayAtPage: 1,
        delayMs: 30, // 30ms response delay completes before 500ms timeout
        requestTimeoutMs: 500,
        inputs: { minVersionsToKeep: 1 },
        expectedExit: 0,
        expectedDeletions: [2] // Older unprotected version pruned
      });
      console.log('PASS test 30: delayed-in-bound response completes successfully and executes planned pruning');
    }

    console.log('\nALL 30 RETENTION TESTS PASSED SUCCESSFULLY.');
  } finally {
    clearTimeout(overallTimeout);
  }
}

if (currentStep.type === 'inline-node') {
  runAllTests().catch(err => {
    console.error('Test suite failed:', err);
    process.exit(1);
  });
}
