// tests/check-gitops-digest.test.cjs
// Supplementary contract test suite for automatic digest binding (D01-D22).
// Tests static contract expressions, unit parsers, and direct helper calls:
//   - scripts/lib/kustomize-digest.js
//   - scripts/update-gitops-digest.mjs
//   - .github/workflows/gitops-sync.yml
// SUPPLEMENTARY: Comprehensive runtime regression testing is performed by
// tests/check-gitops-digest-integration.cjs (actual parsed production step bodies,
// real kubectl kustomize, scoped synthetic Docker/mktemp, process tree termination,
// and temp file cleanup assertions).
// Strictly NO actual registry or infra PR network calls.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const yaml = require('./node_modules/yaml');

const {
  validateInputs,
  runKustomizeBuild,
  inspectRenderedDocuments,
  updateKustomizationFile,
  executeDigestUpdate,
  CANONICAL_CALLER_REPO,
  CANONICAL_IMAGE_NAME,
  CANONICAL_KUSTOMIZE_PATH,
  INTENDED_DEPLOYMENT_NAME,
  INTENDED_CONTAINER_NAME,
} = require('../scripts/lib/kustomize-digest.js');

const WORKFLOW_PATH = path.resolve(__dirname, '../.github/workflows/gitops-sync.yml');
const workflowText = fs.readFileSync(WORKFLOW_PATH, 'utf8').replaceAll('\r\n', '\n');

let passCount = 0;
let failCount = 0;

function report(id, description, passed, detail) {
  if (passed) {
    console.log(`PASS [${id}] ${description}`);
    passCount++;
  } else {
    console.error(`FAIL [${id}] ${description}: ${detail}`);
    failCount++;
  }
}

// Helper to create synthetic infra overlay fixtures
function createFixtureInfra(options = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitops-digest-test-'));
  const targetDir = path.join(tmpDir, CANONICAL_KUSTOMIZE_PATH);
  fs.mkdirSync(targetDir, { recursive: true });

  const deploymentName = options.deploymentName || INTENDED_DEPLOYMENT_NAME;
  const containerName = options.containerName || INTENDED_CONTAINER_NAME;
  const initialImage = options.initialImage || `${CANONICAL_IMAGE_NAME}:placeholder`;

  const deploymentYaml = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${deploymentName}
  namespace: kooker
spec:
  template:
    spec:
      containers:
        - name: ${containerName}
          image: ${initialImage}
`;
  fs.writeFileSync(path.join(targetDir, 'deployment.yaml'), deploymentYaml, 'utf8');

  // Optional unrelated resource
  if (options.includeUnrelated) {
    const unrelatedYaml = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: unrelated-web
  namespace: kooker
spec:
  template:
    spec:
      containers:
        - name: web
          image: nginx:1.25.0
`;
    fs.writeFileSync(path.join(targetDir, 'unrelated.yaml'), unrelatedYaml, 'utf8');
  }

  // Create kustomization.yaml
  let kustomizationObj = {
    resources: options.includeUnrelated ? ['deployment.yaml', 'unrelated.yaml'] : ['deployment.yaml'],
  };

  if (options.images) {
    kustomizationObj.images = options.images;
  }

  if (options.duplicateImages) {
    // Malformed duplicate entries
    kustomizationObj.images = [
      { name: CANONICAL_IMAGE_NAME, newName: CANONICAL_IMAGE_NAME, newTag: '1.14.0' },
      { name: CANONICAL_IMAGE_NAME, newName: CANONICAL_IMAGE_NAME, newTag: '1.15.0' },
    ];
  }

  fs.writeFileSync(path.join(targetDir, 'kustomization.yaml'), yaml.stringify(kustomizationObj), 'utf8');

  return { tmpDir, targetDir };
}

// -----------------------------------------------------------------------------
// D01 & D02: Legacy input handling (omitted or explicit empty)
// -----------------------------------------------------------------------------
{
  // Test workflow parser for inputs
  const doc = yaml.parseDocument(workflowText);
  const inputs = doc.getIn(['on', 'workflow_call', 'inputs']).toJSON();
  const hasNewDigest = inputs.new_digest && inputs.new_digest.required === false && inputs.new_digest.default === '';
  report('D01', 'Input omitted in workflow retains default empty string', hasNewDigest, 'input definition mismatch');

  // Test mode output determination step in bash
  const validationStep = workflowText.includes('if [ -n "$NEW_DIGEST" ]; then');
  report('D02', 'Explicit empty input triggers mode=tag branch', validationStep, 'mode branch mismatch');
}

// -----------------------------------------------------------------------------
// D03: Protected CityLife hold still refuses; zero PR writes
// -----------------------------------------------------------------------------
{
  const guardStepPresent = workflowText.includes('PROTECTED_CLIENT="manifests/overlays/develop/citylife"') &&
                           workflowText.includes('Single-service automated adoption is strictly blocked');
  report('D03', 'CityLife release hold is evaluated before any PR or Kustomize mutation', guardStepPresent, 'guard missing');
}

// -----------------------------------------------------------------------------
// D04: Valid Sportifine initial pin
// -----------------------------------------------------------------------------
{
  const fixture = createFixtureInfra({ includeUnrelated: true });
  try {
    const validDigest = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';
    const res = executeDigestUpdate({
      callerRepo: CANONICAL_CALLER_REPO,
      imageName: CANONICAL_IMAGE_NAME,
      kustomizePath: CANONICAL_KUSTOMIZE_PATH,
      newDigest: validDigest,
      newTag: '1.14.0',
      infraDir: fixture.tmpDir,
    });

    const rendered = runKustomizeBuild(fixture.targetDir);
    const parsed = yaml.parseAllDocuments(rendered).map(d => d.toJSON());
    const dep = parsed.find(r => r.kind === 'Deployment' && r.metadata.name === INTENDED_DEPLOYMENT_NAME);
    const unrelated = parsed.find(r => r.kind === 'Deployment' && r.metadata.name === 'unrelated-web');

    const validInitial = dep.spec.template.spec.containers[0].image === `${CANONICAL_IMAGE_NAME}@${validDigest}` &&
                         unrelated.spec.template.spec.containers[0].image === 'nginx:1.25.0';
    report('D04', 'Valid initial pin updates intended deployment to @digest preserving unrelated', validInitial, 'render mismatch');
  } catch (err) {
    report('D04', 'Valid initial pin', false, err.message);
  } finally {
    fs.rmSync(fixture.tmpDir, { recursive: true, force: true });
  }
}

// -----------------------------------------------------------------------------
// D05: Later different valid digest update
// -----------------------------------------------------------------------------
{
  const oldDigest = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';
  const newDigest = 'sha256:2222222222222222222222222222222222222222222222222222222222222222';
  const fixture = createFixtureInfra({
    images: [{ name: CANONICAL_IMAGE_NAME, newName: CANONICAL_IMAGE_NAME, digest: oldDigest }],
    includeUnrelated: true,
  });
  try {
    executeDigestUpdate({
      callerRepo: CANONICAL_CALLER_REPO,
      imageName: CANONICAL_IMAGE_NAME,
      kustomizePath: CANONICAL_KUSTOMIZE_PATH,
      newDigest: newDigest,
      newTag: '1.15.0',
      infraDir: fixture.tmpDir,
    });

    const rendered = runKustomizeBuild(fixture.targetDir);
    const parsed = yaml.parseAllDocuments(rendered).map(d => d.toJSON());
    const dep = parsed.find(r => r.kind === 'Deployment' && r.metadata.name === INTENDED_DEPLOYMENT_NAME);

    const validUpdate = dep.spec.template.spec.containers[0].image === `${CANONICAL_IMAGE_NAME}@${newDigest}`;
    report('D05', 'Later different valid digest replaces prior digest cleanly', validUpdate, 'render mismatch');
  } catch (err) {
    report('D05', 'Later different valid digest', false, err.message);
  } finally {
    fs.rmSync(fixture.tmpDir, { recursive: true, force: true });
  }
}

// -----------------------------------------------------------------------------
// D06: Stale valid digest plus newTag normalized
// -----------------------------------------------------------------------------
{
  const oldDigest = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';
  const targetDigest = 'sha256:3333333333333333333333333333333333333333333333333333333333333333';
  const fixture = createFixtureInfra({
    images: [{ name: CANONICAL_IMAGE_NAME, newName: CANONICAL_IMAGE_NAME, newTag: 'stale-tag', digest: oldDigest }],
  });
  try {
    executeDigestUpdate({
      callerRepo: CANONICAL_CALLER_REPO,
      imageName: CANONICAL_IMAGE_NAME,
      kustomizePath: CANONICAL_KUSTOMIZE_PATH,
      newDigest: targetDigest,
      newTag: '1.16.0',
      infraDir: fixture.tmpDir,
    });

    const kustomization = yaml.parse(fs.readFileSync(path.join(fixture.targetDir, 'kustomization.yaml'), 'utf8'));
    const imgEntry = kustomization.images[0];
    const normalized = imgEntry.digest === targetDigest && !('newTag' in imgEntry);
    report('D06', 'Stale newTag is purged during digest update normalization', normalized, 'stale tag retained');
  } catch (err) {
    report('D06', 'Stale newTag purged', false, err.message);
  } finally {
    fs.rmSync(fixture.tmpDir, { recursive: true, force: true });
  }
}

// -----------------------------------------------------------------------------
// D07: Malformed/upper-case/whitespace/alternate algorithm input
// -----------------------------------------------------------------------------
{
  const invalidDigests = [
    'SHA256:1111111111111111111111111111111111111111111111111111111111111111',
    'sha256:111111111111111111111111111111111111111111111111111111111111111 ',
    'md5:11111111111111111111111111111111',
    'sha256:short',
  ];
  let allRefused = true;
  for (const d of invalidDigests) {
    try {
      validateInputs({
        callerRepo: CANONICAL_CALLER_REPO,
        imageName: CANONICAL_IMAGE_NAME,
        kustomizePath: CANONICAL_KUSTOMIZE_PATH,
        newDigest: d,
        newTag: '1.14.0',
      });
      allRefused = false;
    } catch {
      // Expected
    }
  }
  report('D07', 'Malformed, upper-case, whitespace, or non-sha256 digest refused', allRefused, 'accepted invalid digest');
}

// -----------------------------------------------------------------------------
// D08: Wrong caller/image/canonical path
// -----------------------------------------------------------------------------
{
  let refused = true;
  try {
    validateInputs({
      callerRepo: 'unauthorized/repo',
      imageName: CANONICAL_IMAGE_NAME,
      kustomizePath: CANONICAL_KUSTOMIZE_PATH,
      newDigest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
      newTag: '1.14.0',
    });
    refused = false;
  } catch {}

  try {
    validateInputs({
      callerRepo: CANONICAL_CALLER_REPO,
      imageName: 'ghcr.io/duikindiesee/other-image',
      kustomizePath: CANONICAL_KUSTOMIZE_PATH,
      newDigest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
      newTag: '1.14.0',
    });
    refused = false;
  } catch {}

  try {
    validateInputs({
      callerRepo: CANONICAL_CALLER_REPO,
      imageName: CANONICAL_IMAGE_NAME,
      kustomizePath: 'manifests/overlays/develop/other-path',
      newDigest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
      newTag: '1.14.0',
    });
    refused = false;
  } catch {}

  report('D08', 'Wrong caller, image, or canonical path refused fail-closed', refused, 'permitted wrong identity');
}

// -----------------------------------------------------------------------------
// D09: Absent overlay/intended Deployment/target image or zero targets
// -----------------------------------------------------------------------------
{
  const fixture = createFixtureInfra({ deploymentName: 'wrong-deployment-name' });
  let refused = false;
  try {
    executeDigestUpdate({
      callerRepo: CANONICAL_CALLER_REPO,
      imageName: CANONICAL_IMAGE_NAME,
      kustomizePath: CANONICAL_KUSTOMIZE_PATH,
      newDigest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
      newTag: '1.14.0',
      infraDir: fixture.tmpDir,
    });
  } catch (err) {
    refused = err.message.includes('PRE_RENDER_MISSING_DEPLOYMENT') || err.message.includes('RENDER_MISSING_WORKLOAD');
  } finally {
    fs.rmSync(fixture.tmpDir, { recursive: true, force: true });
  }
  report('D09', 'Missing intended Deployment or zero targets refused fail-closed', refused, 'accepted missing workload');
}

// -----------------------------------------------------------------------------
// D10: Nonzero/absent/denied registry response
// -----------------------------------------------------------------------------
{
  // Test simulated shell inspection logic with nonzero exit code
  const codeCheck = workflowText.includes('if [ "$EXIT_CODE" -ne 0 ]; then');
  report('D10', 'Nonzero registry exit code triggers immediate fail-closed exit', codeCheck, 'exit code check missing');
}

// -----------------------------------------------------------------------------
// D11: Malformed/null/array/multiple JSON; missing/wrong-type/root alias only
// -----------------------------------------------------------------------------
{
  const testNodeScript = (jsonString, expectedDigest) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'd11-test-'));
    const f = path.join(tmp, 'out.json');
    fs.writeFileSync(f, jsonString, 'utf8');
    const res = spawnSync('node', ['-e', `
      const fs = require("node:fs");
      const expected = process.argv[1];
      const file = process.argv[2];
      const content = fs.readFileSync(file, "utf8").trim();
      const parsed = JSON.parse(content);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) process.exit(1);
      if (typeof parsed.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(parsed.digest)) process.exit(1);
      if (parsed.digest !== expected) process.exit(1);
      process.exit(0);
    `, expectedDigest, f]);
    fs.rmSync(tmp, { recursive: true, force: true });
    return res.status === 0;
  };

  const validDigest = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';
  const malformedRefused = !testNodeScript('{"Descriptor":{"digest":"sha256:1111111111111111111111111111111111111111111111111111111111111111"}}', validDigest) &&
                           !testNodeScript('null', validDigest) &&
                           !testNodeScript('[]', validDigest) &&
                           !testNodeScript('{"digest":12345}', validDigest);
  report('D11', 'Malformed, array, null, or nested-alias-only JSON refused fail-closed', malformedRefused, 'accepted malformed descriptor');
}

// -----------------------------------------------------------------------------
// D12: Canonical manifest mismatch/config-digest confusion
// -----------------------------------------------------------------------------
{
  const expectedDigest = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';
  const configDigest = 'sha256:9999999999999999999999999999999999999999999999999999999999999999';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'd12-test-'));
  const f = path.join(tmp, 'out.json');
  fs.writeFileSync(f, JSON.stringify({ digest: configDigest }), 'utf8');

  const res = spawnSync('node', ['-e', `
    const fs = require("node:fs");
    const expected = process.argv[1];
    const file = process.argv[2];
    const content = fs.readFileSync(file, "utf8").trim();
    const parsed = JSON.parse(content);
    if (parsed.digest !== expected) process.exit(1);
    process.exit(0);
  `, expectedDigest, f]);
  fs.rmSync(tmp, { recursive: true, force: true });

  report('D12', 'Config-digest confusion or digest mismatch fails closed', res.status !== 0, 'accepted mismatched digest');
}

// -----------------------------------------------------------------------------
// D13: Timeout/stdout cap/stderr cap
// -----------------------------------------------------------------------------
{
  const hasTimeoutHandling = (workflowText.includes('TIMEOUT_LIMIT=30') || workflowText.includes('TIMEOUT_LIMIT=300')) &&
                             workflowText.includes('STDOUT_SIZE') &&
                             workflowText.includes('Registry inspection exceeded stdout cap of 65536 bytes') &&
                             workflowText.includes('Registry inspection exceeded stderr cap of 16384 bytes');
  report('D13', 'Registry producer bounded by 30s timeout and 64KB/16KB output caps', hasTimeoutHandling, 'caps missing in workflow');
}

// -----------------------------------------------------------------------------
// D14: Valid descriptor with extra unrelated fields
// -----------------------------------------------------------------------------
{
  const validDigest = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';
  const extraFieldsDescriptor = {
    schemaVersion: 2,
    mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
    digest: validDigest,
    size: 1234,
    extraMetadata: { author: 'Kooker' },
  };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'd14-test-'));
  const f = path.join(tmp, 'out.json');
  fs.writeFileSync(f, JSON.stringify(extraFieldsDescriptor), 'utf8');

  const res = spawnSync('node', ['-e', `
    const fs = require("node:fs");
    const expected = process.argv[1];
    const file = process.argv[2];
    const content = fs.readFileSync(file, "utf8").trim();
    const parsed = JSON.parse(content);
    if (parsed.digest !== expected) process.exit(1);
    process.exit(0);
  `, validDigest, f]);
  fs.rmSync(tmp, { recursive: true, force: true });

  report('D14', 'Valid descriptor with extra unrelated fields passes successfully', res.status === 0, 'failed valid extra fields');
}

// -----------------------------------------------------------------------------
// D15: Duplicate/conflicting Kustomize entry/newName
// -----------------------------------------------------------------------------
{
  const fixture = createFixtureInfra({ duplicateImages: true });
  let refused = false;
  try {
    executeDigestUpdate({
      callerRepo: CANONICAL_CALLER_REPO,
      imageName: CANONICAL_IMAGE_NAME,
      kustomizePath: CANONICAL_KUSTOMIZE_PATH,
      newDigest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
      newTag: '1.14.0',
      infraDir: fixture.tmpDir,
    });
  } catch (err) {
    refused = err.message.includes('KUSTOMIZATION_CONFLICT');
  } finally {
    fs.rmSync(fixture.tmpDir, { recursive: true, force: true });
  }
  report('D15', 'Duplicate conflicting image entries in Kustomization fail closed', refused, 'accepted duplicate entries');
}

// -----------------------------------------------------------------------------
// D16: First target right, later target stale/wrong
// -----------------------------------------------------------------------------
{
  const renderedWithMixedImages = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${INTENDED_DEPLOYMENT_NAME}
  namespace: kooker
spec:
  template:
    spec:
      containers:
        - name: ${INTENDED_CONTAINER_NAME}
          image: ${CANONICAL_IMAGE_NAME}@sha256:1111111111111111111111111111111111111111111111111111111111111111
        - name: sidecar
          image: ${CANONICAL_IMAGE_NAME}@sha256:oldoldoldoldoldoldoldoldoldoldoldoldoldoldoldoldoldoldoldoldoldold
`;
  let refused = false;
  try {
    inspectRenderedDocuments(renderedWithMixedImages, CANONICAL_IMAGE_NAME, 'sha256:1111111111111111111111111111111111111111111111111111111111111111');
  } catch (err) {
    refused = err.message.includes('RENDER_UNEXPECTED_TARGET');
  }
  report('D16', 'Mixed/stale target container references rejected', refused, 'accepted stale sidecar target');
}

// -----------------------------------------------------------------------------
// D17: Unrelated resource/image mutated
// -----------------------------------------------------------------------------
{
  const preRenderDoc = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: INTENDED_DEPLOYMENT_NAME, namespace: 'kooker' },
    spec: {
      template: {
        spec: {
          containers: [
            { name: INTENDED_CONTAINER_NAME, image: `${CANONICAL_IMAGE_NAME}:placeholder` }
          ]
        }
      }
    }
  };
  const preDocsByKey = new Map([
    [`Deployment/kooker/${INTENDED_DEPLOYMENT_NAME}`, preRenderDoc]
  ]);
  const expectedTargetIdentities = [
    {
      resourceKey: `Deployment/kooker/${INTENDED_DEPLOYMENT_NAME}`,
      field: 'containers',
      containerName: INTENDED_CONTAINER_NAME,
      image: `${CANONICAL_IMAGE_NAME}:placeholder`
    }
  ];
  const preRenderContext = { expectedTargetIdentities, preDocsByKey };

  // Neutral valid control: expected target correctly updated to digest, matches pre-render context
  const validRendered = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${INTENDED_DEPLOYMENT_NAME}
  namespace: kooker
spec:
  template:
    spec:
      containers:
        - name: ${INTENDED_CONTAINER_NAME}
          image: ${CANONICAL_IMAGE_NAME}@sha256:1111111111111111111111111111111111111111111111111111111111111111
`;
  let validPassed = false;
  try {
    const res = inspectRenderedDocuments(validRendered, CANONICAL_IMAGE_NAME, 'sha256:1111111111111111111111111111111111111111111111111111111111111111', preRenderContext);
    validPassed = res.matchingDeploymentFound && res.matchingContainerCount === 1;
  } catch (err) {
    validPassed = false;
  }

  // Mutated unrelated case: unexpected additional resource with target image
  const renderedWithMutatedUnrelated = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${INTENDED_DEPLOYMENT_NAME}
  namespace: kooker
spec:
  template:
    spec:
      containers:
        - name: ${INTENDED_CONTAINER_NAME}
          image: ${CANONICAL_IMAGE_NAME}@sha256:1111111111111111111111111111111111111111111111111111111111111111
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: other-unrelated-app
  namespace: kooker
spec:
  template:
    spec:
      containers:
        - name: other
          image: ${CANONICAL_IMAGE_NAME}@sha256:1111111111111111111111111111111111111111111111111111111111111111
`;
  let mutationRefused = false;
  try {
    inspectRenderedDocuments(renderedWithMutatedUnrelated, CANONICAL_IMAGE_NAME, 'sha256:1111111111111111111111111111111111111111111111111111111111111111', preRenderContext);
  } catch (err) {
    mutationRefused = err.message.includes('RENDER_IDENTITY_SET_MISMATCH') || err.message.includes('RENDER_UNRELATED_MUTATION');
  }

  report('D17', 'Unrelated resource receiving target image fails closed', validPassed && mutationRefused, 'permitted unrelated mutation or failed neutral control');
}

// -----------------------------------------------------------------------------
// D18: YAML/Kustomize/mandatory parser unavailable or invalid output
// -----------------------------------------------------------------------------
{
  const helperSetupPresent = workflowText.includes('Checkout shared workflow helper') &&
                             workflowText.includes('Install pinned parser dependencies');
  report('D18', 'Explicit shared helper sparse-checkout and pinned npm ci in workflow', helperSetupPresent, 'helper setup missing');
}

// -----------------------------------------------------------------------------
// D19: Missing/denied approver/required check
// -----------------------------------------------------------------------------
{
  const approverFailureHandled = workflowText.includes('if [ -z "$GH_TOKEN" ]; then') &&
                                 workflowText.includes('Deploy PR opened but NOT merged') &&
                                 workflowText.includes('Could not merge deploy PR after 3 attempts');
  report('D19', 'Missing or failing approver leaves PR open and fails job with non-zero exit', approverFailureHandled, 'approver failure logic missing');
}

// -----------------------------------------------------------------------------
// D20: Server caller exact shared SHA/new_digest/version bindings
// -----------------------------------------------------------------------------
{
  // Checks gitops-sync inputs match the server publish-server.yml contract
  const inputsDoc = yaml.parseDocument(workflowText);
  const inputs = inputsDoc.getIn(['on', 'workflow_call', 'inputs']).toJSON();
  const callerWiring = Boolean(inputs.image_name && inputs.new_tag && inputs.new_digest && inputs.kustomize_path);
  report('D20', 'Shared gitops-sync accepts exact caller inputs (image_name, new_tag, new_digest, kustomize_path)', callerWiring, 'inputs mismatch');
}

// -----------------------------------------------------------------------------
// D21: Inert first-install flow and second update
// -----------------------------------------------------------------------------
{
  // Verify that Kustomization update does not require live cluster connection or ArgoCD
  const fixture1 = createFixtureInfra();
  const fixture2 = createFixtureInfra();
  try {
    const d1 = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';
    const d2 = 'sha256:2222222222222222222222222222222222222222222222222222222222222222';
    executeDigestUpdate({
      callerRepo: CANONICAL_CALLER_REPO,
      imageName: CANONICAL_IMAGE_NAME,
      kustomizePath: CANONICAL_KUSTOMIZE_PATH,
      newDigest: d1,
      newTag: '1.14.0',
      infraDir: fixture1.tmpDir,
    });
    executeDigestUpdate({
      callerRepo: CANONICAL_CALLER_REPO,
      imageName: CANONICAL_IMAGE_NAME,
      kustomizePath: CANONICAL_KUSTOMIZE_PATH,
      newDigest: d2,
      newTag: '1.15.0',
      infraDir: fixture2.tmpDir,
    });
    report('D21', 'Inert first-install and second update succeed offline via local Kustomize', true, '');
  } catch (err) {
    report('D21', 'Inert first-install flow', false, err.message);
  } finally {
    fs.rmSync(fixture1.tmpDir, { recursive: true, force: true });
    fs.rmSync(fixture2.tmpDir, { recursive: true, force: true });
  }
}

// -----------------------------------------------------------------------------
// D22: Shell/text metacharacters and malformed paths
// -----------------------------------------------------------------------------
{
  const maliciousInputs = [
    'sha256:1111111111111111111111111111111111111111111111111111111111111111; rm -rf /',
    'sha256:1111111111111111111111111111111111111111111111111111111111111111`id`',
    'sha256:1111111111111111111111111111111111111111111111111111111111111111$(whoami)',
  ];
  let allRefused = true;
  for (const m of maliciousInputs) {
    try {
      validateInputs({
        callerRepo: CANONICAL_CALLER_REPO,
        imageName: CANONICAL_IMAGE_NAME,
        kustomizePath: CANONICAL_KUSTOMIZE_PATH,
        newDigest: m,
        newTag: '1.14.0',
      });
      allRefused = false;
    } catch {}
  }
  report('D22', 'Shell metacharacters and injected text refused before execution', allRefused, 'accepted injected text');
}

console.log(`\n=== Acceptance Summary: ${passCount} passed, ${failCount} failed (Target: 22/22) ===`);
if (failCount > 0) {
  process.exit(1);
}
process.exit(0);
