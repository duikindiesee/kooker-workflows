// tests/check-gitops-digest-integration.cjs
// Runtime fixture regression suite (bounded fixture-correction candidate; full selected coverage still required) for automatic digest binding and production workflow controls.
// Executes:
//   1. Actual parsed production registry step body (.github/workflows/gitops-sync.yml)
//      - Simulated exit-127 monitor failure (literal-absence coverage still required in owning suite)
//      - Monitor forced exit 42 after owned held child created
//      - Unknown monitor status (fail closed)
//      - Fast stdout cap (65536) / stderr cap (16384); streaming coverage still required
//      - Real 30s deadline timeout
//      - Owned process tree and held descendant termination / reap verification
//      - Unrelated sentinel process preservation (no global pkill)
//      - Actual OS-returned mktemp filename absence; inode/count/finally strengthening still required
//      - Canonical valid positive and valid descriptor with extra metadata
//   2. Actual consumer CLI (scripts/update-gitops-digest.mjs) + real kubectl/kustomize
//      - Initial placeholder -> digest across Deployment, initContainers, Job, and CronJob
//      - Subsequent DISTINCT digest update purging stale references cleanly
//      - Unrelated resource semantic preservation
//      - Strict target identity set equality
//      - Rejection of sidecar image mutations and container environment modifications with atomic rollback
//   3. Actual workflow guard step bodies (.github/workflows/gitops-sync.yml)
//      - Legacy omitted default / explicit empty input handling
//      - Protected CityLife client/server release hold refusals
//      - Deploy approver / PR merge check gate controls
//
// Strictly NO network access, NO real registry calls, NO real GitHub PR writes.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const yaml = require('./node_modules/yaml');

const REPO_ROOT = path.resolve(__dirname, '..');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github/workflows/gitops-sync.yml');
const UPDATE_CLI_PATH = path.join(REPO_ROOT, 'scripts/update-gitops-digest.mjs');
const KUSTOMIZE_LIB_PATH = path.join(REPO_ROOT, 'scripts/lib/kustomize-digest.js');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Verify required tools
function resolveExecutable(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.resolve(dir, name);
    try { fs.accessSync(candidate, fs.constants.X_OK); return fs.realpathSync(candidate); } catch {}
  }
  return null;
}
function detectKustomize() {
  const absolute = resolveExecutable('kustomize');
  if (!absolute) throw new Error('TOOL_UNAVAILABLE: standalone kustomize is required for real legacy edit and render controls');
  const version = spawnSync(absolute, ['version'], { encoding: 'utf8', timeout: 5000 });
  if (version.status !== 0) throw new Error('TOOL_UNAVAILABLE: resolved real Kustomize version probe failed');
  return { cmd: absolute, args: ['build'] };
}
function snapshotTree(dir) {
  const result = {};
  for (const file of fs.readdirSync(dir, { recursive: true }).sort()) {
    const full = path.join(dir, file), st = fs.lstatSync(full);
    if (st.isFile()) result[file] = { sha: sha256(fs.readFileSync(full)), mode: st.mode & 0o777 };
  }
  return result;
}

const KUSTOMIZE_TOOL = detectKustomize();

let passCount = 0;
let failCount = 0;
let skipCount = 0;

function shouldRun(fullName) {
  const filter = process.env.TEST_FILTER;
  if (!filter) return true;
  if (filter === 'consumer-positive') {
    return fullName.includes('Consumer CLI - initial placeholder pin with sidecar and ConfigMap') ||
           fullName.includes('Consumer CLI - multi-workload Deployment, initContainer, Job, CronJob');
  }
  const patterns = filter.split('|').map(s => s.trim()).filter(Boolean);
  return patterns.some(p => fullName.includes(p));
}

function report(name, passed, detail = '') {
  if (passed) {
    console.log(`PASS [integration] ${name}`);
    passCount++;
  } else {
    console.error(`FAIL [integration] ${name}: ${detail}`);
    failCount++;
  }
}

// Extract exact step bodies from gitops-sync.yml
const workflowText = fs.readFileSync(WORKFLOW_PATH, 'utf8');
const workflowDoc = yaml.parse(workflowText);
const steps = workflowDoc.jobs.sync.steps;
const stepMap = new Map();
for (const s of steps) {
  if (s && s.name && s.run) {
    stepMap.set(s.name, s.run);
  }
}

const REGISTRY_STEP_BODY = stepMap.get('Prove the exact image exists before changing GitOps');
assert.ok(REGISTRY_STEP_BODY, 'Prove the exact image exists step must be present in gitops-sync.yml');

// =============================================================================
// SECTION 1: Production Registry Step Controls
// =============================================================================

function parseDockerCalls(logBuffer) {
  const calls = [];
  const text = logBuffer.toString('binary');
  const sections = text.split('CALL_START\n');
  for (let i = 1; i < sections.length; i++) {
    const endIdx = sections[i].indexOf('\nCALL_END\n');
    if (endIdx === -1) continue;
    const rawArgs = sections[i].slice(0, endIdx);
    if (!rawArgs) {
      calls.push([]);
      continue;
    }
    const parts = rawArgs.split('\0');
    if (parts.length > 0 && parts[parts.length - 1] === '') {
      parts.pop();
    }
    calls.push(parts);
  }
  return calls;
}

function verifyDockerInvocation(logPath, expectedImageRef) {
  if (!fs.existsSync(logPath)) {
    return { pass: false, detail: 'No docker invocations recorded' };
  }
  const calls = parseDockerCalls(fs.readFileSync(logPath));
  if (calls.length !== 1) {
    return { pass: false, detail: `Expected exactly 1 docker invocation, got ${calls.length}: ${JSON.stringify(calls)}` };
  }
  const expectedArgs = [
    'buildx',
    'imagetools',
    'inspect',
    '--format',
    '{{json .Manifest}}',
    expectedImageRef
  ];
  const actualArgs = calls[0];
  if (actualArgs.length !== expectedArgs.length) {
    return { pass: false, detail: `Argument count mismatch: expected ${expectedArgs.length} (${JSON.stringify(expectedArgs)}), got ${actualArgs.length} (${JSON.stringify(actualArgs)})` };
  }
  for (let i = 0; i < expectedArgs.length; i++) {
    if (actualArgs[i] !== expectedArgs[i]) {
      return { pass: false, detail: `Argument ${i} mismatch: expected '${expectedArgs[i]}', got '${actualArgs[i]}'` };
    }
  }
  return { pass: true, detail: '' };
}

function runRegistryStepCase({
  name,
  nodeMode,
  dockerMode,
  expectedExit,
  expectedErrSubstr,
  minElapsedSeconds = null,
  maxElapsedSeconds = null,
  requireDockerCall = true,
  timeoutSeconds = 15
}) {
  const fullName = `Registry step - ${name}`;
  if (!shouldRun(fullName)) {
    skipCount++;
    return;
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `reg-test-${name}-`));
  const binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const mktempLog = path.join(tmpDir, 'mktemp.log');
  const dockerLog = path.join(tmpDir, 'docker.log');
  const dockerArgsLog = path.join(tmpDir, 'docker_args.log');
  const heldProofLog = path.join(tmpDir, 'held_proof.log');
  const infraSentinel = path.join(tmpDir, 'infra-sentinel.txt');
  fs.writeFileSync(infraSentinel, 'sentinel infra remains untouched\n', { mode: 0o644 });
  const infraBeforeBytes = fs.readFileSync(infraSentinel);
  const infraBeforeMode = fs.statSync(infraSentinel).mode & 0o777;

  const stepScriptPath = path.join(tmpDir, 'step.sh');
  fs.writeFileSync(stepScriptPath, REGISTRY_STEP_BODY, { mode: 0o755 });

  // 1. Owned mktemp wrapper calling /usr/bin/mktemp with unmodified arguments, recording path, inode, and device
  const mktempWrapper = path.join(binDir, 'mktemp');
  const mktempCode = `#!/bin/sh
CREATED=$(/usr/bin/mktemp "$@")
STATUS=$?
if [ $STATUS -eq 0 ] && [ -n "$CREATED" ]; then
  "${process.execPath}" -e '
    const fs = require("node:fs");
    const p = process.argv[1];
    const log = process.argv[2];
    try {
      const st = fs.statSync(p);
      fs.appendFileSync(log, JSON.stringify({ path: p, ino: st.ino, dev: st.dev }) + "\\n");
    } catch {}
  ' "$CREATED" "${mktempLog}"
fi
echo "$CREATED"
exit $STATUS
`;
  fs.writeFileSync(mktempWrapper, mktempCode, { mode: 0o755 });

  // 2. Synthetic Docker wrapper
  const dockerWrapper = path.join(binDir, 'docker');
  let dockerCode = `#!/bin/sh\n`;
  dockerCode += `printf "CALL_START\\n" >> "${dockerArgsLog}"\n`;
  dockerCode += `for arg in "$@"; do printf "%s\\0" "$arg" >> "${dockerArgsLog}"; done\n`;
  dockerCode += `printf "\\nCALL_END\\n" >> "${dockerArgsLog}"\n`;
  if (dockerMode === 'valid') {
    dockerCode += `printf '{"digest":"%s"}' "$EXPECTED_DIGEST"\nexit 0\n`;
  } else if (dockerMode === 'valid_metadata') {
    dockerCode += `printf '{"digest":"%s","schemaVersion":2,"extra":"metadata"}' "$EXPECTED_DIGEST"\nexit 0\n`;
  } else if (dockerMode === 'malformed_json') {
    dockerCode += `printf 'this is not json at all'\nexit 0\n`;
  } else if (dockerMode === 'null_json') {
    dockerCode += `printf 'null'\nexit 0\n`;
  } else if (dockerMode === 'array_json') {
    dockerCode += `printf '[{"digest":"%s"}]' "$EXPECTED_DIGEST"\nexit 0\n`;
  } else if (dockerMode === 'multiple_json') {
    dockerCode += `printf '{"digest":"%s"}\\n{"digest":"%s"}' "$EXPECTED_DIGEST" "$EXPECTED_DIGEST"\nexit 0\n`;
  } else if (dockerMode === 'root_missing') {
    dockerCode += `printf '{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json"}'\nexit 0\n`;
  } else if (dockerMode === 'nonstring_digest') {
    dockerCode += `printf '{"digest":12345678}'\nexit 0\n`;
  } else if (dockerMode === 'nested_digest') {
    dockerCode += `printf '{"manifest":{"digest":"%s"}}' "$EXPECTED_DIGEST"\nexit 0\n`;
  } else if (dockerMode === 'config_only') {
    dockerCode += `printf '{"config":{"digest":"%s"}}' "$EXPECTED_DIGEST"\nexit 0\n`;
  } else if (dockerMode === 'digest_mismatch') {
    dockerCode += `printf '{"digest":"sha256:%s"}' "$(head -c 64 /dev/zero | tr '\\0' '9')"\nexit 0\n`;
  } else if (dockerMode === 'inspect_nonzero') {
    dockerCode += `echo "docker: image not found" >&2\nexit 1\n`;
  } else if (dockerMode === 'fast_stdout_oversize') {
    dockerCode += `printf '{"digest":"%s","pad":"' "$EXPECTED_DIGEST"
head -c 70000 < /dev/zero | tr '\\0' 'x'
printf '"}'
exit 0
`;
  } else if (dockerMode === 'streaming_stdout_oversize') {
    dockerCode += `
sleep 120 &
CHILD=$!
echo "$$ $CHILD" >> "${dockerLog}"
for i in $(seq 1 10); do
  head -c 8192 < /dev/zero | tr '\\0' 'A'
  sleep 0.05
done
kill -9 $CHILD 2>/dev/null || true
exit 0
`;
  } else if (dockerMode === 'fast_stderr_oversize') {
    dockerCode += `head -c 20000 < /dev/zero | tr '\\0' 'e' >&2\nexit 1\n`;
  } else if (dockerMode === 'streaming_stderr_oversize') {
    dockerCode += `
sleep 120 &
CHILD=$!
echo "$$ $CHILD" >> "${dockerLog}"
for i in $(seq 1 10); do
  head -c 2048 < /dev/zero | tr '\\0' 'E' >&2
  sleep 0.05
done
kill -9 $CHILD 2>/dev/null || true
exit 1
`;
  } else if (dockerMode === 'sleep_35') {
    dockerCode += `
sleep 120 &
CHILD=$!
echo "$$ $CHILD" >> "${dockerLog}"
sleep 35
kill -9 $CHILD 2>/dev/null || true
exit 0
`;
  } else if (dockerMode === 'held_descendant') {
    dockerCode += `
sleep 120 &
CHILD=$!
echo "$$ $CHILD" >> "${dockerLog}"
sleep 60
kill -9 $CHILD 2>/dev/null || true
exit 0
`;
  }
  fs.writeFileSync(dockerWrapper, dockerCode, { mode: 0o755 });

  // 3. Node wrapper & toolbox PATH setup
  let runPath = `${binDir}:/usr/bin:/bin`;
  let probeReceipt = null;
  if (nodeMode === 'missing') {
    // Construct isolated whitelist toolbox containing ONLY necessary non-node binaries
    const toolboxDir = path.join(tmpDir, 'toolbox');
    fs.mkdirSync(toolboxDir, { recursive: true });
    const needed = ['bash', 'sh', 'date', 'sleep', 'kill', 'ps', 'wc', 'echo', 'rm', 'mkdir', 'head', 'tr', 'printf', 'seq', 'cat', 'touch', 'dirname', 'basename'];
    for (const cmd of needed) {
      const exec = resolveExecutable(cmd);
      if (exec) {
        try { fs.symlinkSync(exec, path.join(toolboxDir, cmd)); } catch {}
      }
    }
    runPath = `${binDir}:${toolboxDir}`;

    // Verify command -v node fails with status 1 before step execution
    const probe = spawnSync('/bin/bash', ['-c', 'command -v node'], {
      env: { PATH: runPath },
      encoding: 'utf8'
    });
    assert.equal(probe.status, 1, 'node must be literally absent from toolbox PATH (status === 1)');

    const nodeWrapperPath = path.join(binDir, 'node');
    probeReceipt = {
      command: ['/bin/bash', '-c', 'command -v node'],
      actual_status: probe.status,
      stdout: probe.stdout || '',
      stderr: probe.stderr || '',
      scoped_path: runPath,
      path_components: runPath.split(':'),
      toolbox_entry_names: fs.readdirSync(toolboxDir).sort(),
      node_wrapper_exists: fs.existsSync(nodeWrapperPath)
    };
  } else if (nodeMode === 'exit_42_after_held') {
    const nodeWrapper = path.join(binDir, 'node');
    // Wait until docker log has recorded both PIDs, verify both are alive with kill -0, record proof, then exit 42
    const nodeScript = `#!/bin/sh
T0=$(date +%s)
while true; do
  if [ -s "${dockerLog}" ]; then
    PIDS=$(cat "${dockerLog}" | head -n 1)
    PARENT=$(echo "$PIDS" | awk '{print $1}')
    CHILD=$(echo "$PIDS" | awk '{print $2}')
    if [ -n "$PARENT" ] && [ -n "$CHILD" ]; then
      if kill -0 "$PARENT" 2>/dev/null && kill -0 "$CHILD" 2>/dev/null; then
        echo "ALIVE:$PARENT:$CHILD" > "${heldProofLog}"
        break
      fi
    fi
  fi
  sleep 0.02
  NOW=$(date +%s)
  if [ $((NOW - T0)) -gt 5 ]; then
    echo "timeout waiting for alive held descendant in test harness" >&2
    exit 44
  fi
done
echo "synthetic monitor failure after held child verified alive" >&2
exit 42
`;
    fs.writeFileSync(nodeWrapper, nodeScript, { mode: 0o755 });
  } else if (nodeMode === 'exit_42') {
    const nodeWrapper = path.join(binDir, 'node');
    fs.writeFileSync(nodeWrapper, `#!/bin/sh\necho "synthetic monitor failure" >&2\nexit 42\n`, { mode: 0o755 });
  } else if (nodeMode === 'unknown_status') {
    const nodeWrapper = path.join(binDir, 'node');
    fs.writeFileSync(nodeWrapper, `#!/bin/sh\nprintf "UNKNOWN:0.0100"\nexit 0\n`, { mode: 0o755 });
  } else {
    // Symlink real node
    const nodeWrapper = path.join(binDir, 'node');
    fs.symlinkSync(process.execPath, nodeWrapper);
  }

  // Background sentinel process
  const sentinel = spawn('/bin/sleep', ['100']);
  const sentinelPid = sentinel.pid;

  const env = {
    ...process.env,
    PATH: runPath,
    MODE: 'digest',
    EXPECTED_DIGEST: 'sha256:' + '1'.repeat(64),
    IMAGE_REFERENCE: 'ghcr.io/duikindiesee/sportifine-server:0.1.0'
  };

  const t0 = process.hrtime.bigint();
  const proc = spawnSync('/bin/bash', [stepScriptPath], {
    cwd: tmpDir,
    env,
    encoding: 'utf8',
    timeout: timeoutSeconds * 1000
  });
  const elapsedSec = Number(process.hrtime.bigint() - t0) / 1e9;

  // 1. Exit code
  const exitPass = (proc.status === expectedExit);

  // 2. Error message match
  const combinedOutput = (proc.stdout || '') + '\n' + (proc.stderr || '');
  const errPass = expectedErrSubstr ? combinedOutput.includes(expectedErrSubstr) : true;

  // 3. Sentinel process alive
  let sentinelAlive = false;
  try {
    process.kill(sentinelPid, 0);
    sentinelAlive = true;
  } catch {}
  try { sentinel.kill('SIGKILL'); } catch {}

  // 4. Owned PIDs and descendants terminated
  let ownedCleaned = true;
  if (fs.existsSync(dockerLog)) {
    const lines = fs.readFileSync(dockerLog, 'utf8').trim().split('\n');
    for (const line of lines) {
      const pids = line.trim().split(/\s+/).map(x => parseInt(x, 10)).filter(Boolean);
      for (const p of pids) {
        try {
          process.kill(p, 0);
          ownedCleaned = false;
        } catch {}
      }
    }
  }

  // 5. Actual returned EXACT TWO unique filenames + finite positive inode/device at creation, and both unlinked BEFORE finally cleanup
  let tempsCleaned = true;
  let tempsDetail = '';
  if (fs.existsSync(mktempLog)) {
    const rawLines = fs.readFileSync(mktempLog, 'utf8').trim().split('\n').filter(Boolean);
    const records = [];
    for (const l of rawLines) {
      try { records.push(JSON.parse(l)); } catch {}
    }
    if (rawLines.length !== 2 || records.length !== 2) {
      tempsCleaned = false;
      tempsDetail = `Expected exactly 2 raw lines and 2 valid records, got lines=${rawLines.length}, records=${records.length}`;
    } else {
      const r1 = records[0];
      const r2 = records[1];
      const p1 = r1.path;
      const p2 = r2.path;
      if (!p1 || !p2 || !path.isAbsolute(p1) || !path.isAbsolute(p2)) {
        tempsCleaned = false;
        tempsDetail = `Expected non-empty absolute temp paths: p1='${p1}', p2='${p2}'`;
      } else if (p1 === p2) {
        tempsCleaned = false;
        tempsDetail = `Expected 2 distinct temp paths, got duplicates: '${p1}'`;
      } else if (typeof r1.ino !== 'number' || r1.ino <= 0 || typeof r2.ino !== 'number' || r2.ino <= 0 ||
                 typeof r1.dev !== 'number' || r1.dev <= 0 || typeof r2.dev !== 'number' || r2.dev <= 0) {
        tempsCleaned = false;
        tempsDetail = `Expected finite positive ino/dev: r1={ino:${r1.ino},dev:${r1.dev}}, r2={ino:${r2.ino},dev:${r2.dev}}`;
      } else if (r1.dev === r2.dev && r1.ino === r2.ino) {
        tempsCleaned = false;
        tempsDetail = `Expected distinct file identity across temp files: same dev=${r1.dev} and ino=${r1.ino}`;
      } else {
        // Assert both are unlinked before test finally cleanup
        for (const rec of records) {
          if (fs.existsSync(rec.path)) {
            tempsCleaned = false;
            tempsDetail = `Temp file '${rec.path}' (ino ${rec.ino}) still exists before cleanup`;
          }
        }
      }
    }
  } else {
    tempsCleaned = false;
    tempsDetail = 'mktemp log missing';
  }

  // 6. Assert exact ONE docker call reached (or not required if failed before docker)
  let dockerCallPass = true;
  let dockerCallDetail = '';
  if (requireDockerCall) {
    const dockerVerification = verifyDockerInvocation(dockerArgsLog, env.IMAGE_REFERENCE);
    dockerCallPass = dockerVerification.pass;
    dockerCallDetail = dockerVerification.detail;
  }

  // 7. Bounds assertion on elapsed time if specified
  let elapsedBoundsPass = true;
  let elapsedBoundsDetail = '';
  if (minElapsedSeconds !== null && elapsedSec < minElapsedSeconds) {
    elapsedBoundsPass = false;
    elapsedBoundsDetail = `Elapsed ${elapsedSec.toFixed(2)}s < min ${minElapsedSeconds}s`;
  }
  if (maxElapsedSeconds !== null && elapsedSec > maxElapsedSeconds) {
    elapsedBoundsPass = false;
    elapsedBoundsDetail = `Elapsed ${elapsedSec.toFixed(2)}s > max ${maxElapsedSeconds}s`;
  }

  // 8. Held-proof record assertion if nodeMode is exit_42_after_held
  let heldProofPass = true;
  let heldProofDetail = '';
  if (nodeMode === 'exit_42_after_held') {
    if (!fs.existsSync(heldProofLog)) {
      heldProofPass = false;
      heldProofDetail = 'Held proof log missing';
    } else {
      const proofText = fs.readFileSync(heldProofLog, 'utf8').trim();
      const match = proofText.match(/^ALIVE:(\d+):(\d+)$/);
      if (!match) {
        heldProofPass = false;
        heldProofDetail = `Invalid proof text format: '${proofText}'`;
      } else {
        const parentPid = parseInt(match[1], 10);
        const childPid = parseInt(match[2], 10);
        if (parentPid <= 0 || childPid <= 0 || parentPid === childPid) {
          heldProofPass = false;
          heldProofDetail = `Invalid verified PIDs: parent=${parentPid}, child=${childPid}`;
        }
      }
    }
  }

  // 9. Sentinel infra unchanged assertion
  let infraPass = false;
  let infraAfterBytes = null;
  let infraAfterMode = null;
  try {
    infraAfterBytes = fs.readFileSync(infraSentinel);
    infraAfterMode = fs.statSync(infraSentinel).mode & 0o777;
    infraPass = Buffer.compare(infraBeforeBytes, infraAfterBytes) === 0 && (infraBeforeMode === infraAfterMode);
  } catch {}

  // 10. Optional fixture evidence retention (TEST_EVIDENCE_DIR)
  if (process.env.TEST_EVIDENCE_DIR) {
    try {
      const evDir = path.resolve(process.env.TEST_EVIDENCE_DIR);
      fs.mkdirSync(evDir, { recursive: true });
      const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
      const evFile = path.join(evDir, `${safeName}.json`);

      const mktempRecords = [];
      if (fs.existsSync(mktempLog)) {
        for (const l of fs.readFileSync(mktempLog, 'utf8').trim().split('\n').filter(Boolean)) {
          try {
            const r = JSON.parse(l);
            mktempRecords.push({ ...r, observed_absent_before_cleanup: !fs.existsSync(r.path) });
          } catch {}
        }
      }

      const ownedRecords = [];
      if (fs.existsSync(dockerLog)) {
        for (const l of fs.readFileSync(dockerLog, 'utf8').trim().split('\n').filter(Boolean)) {
          const pids = l.trim().split(/\s+/).map(x => parseInt(x, 10)).filter(Boolean);
          for (const p of pids) {
            let alive = false;
            try { process.kill(p, 0); alive = true; } catch {}
            ownedRecords.push({ pid: p, observed_alive_before_cleanup: alive, observed_absent_before_cleanup: !alive });
          }
        }
      }

      const parsedDockerCalls = fs.existsSync(dockerArgsLog) ? parseDockerCalls(fs.readFileSync(dockerArgsLog)) : [];

      const evidence = {
        name,
        source_body_sha256: sha256(Buffer.from(REGISTRY_STEP_BODY)),
        actual_exit: proc.status,
        expected_exit: expectedExit,
        elapsed_seconds: elapsedSec,
        elapsed_bounds: { min: minElapsedSeconds, max: maxElapsedSeconds, satisfied: elapsedBoundsPass },
        sentinel_pid: sentinelPid,
        sentinel_alive: sentinelAlive,
        controlled_infra: {
          before_sha256: sha256(infraBeforeBytes),
          after_sha256: infraAfterBytes ? sha256(infraAfterBytes) : null,
          before_mode: infraBeforeMode,
          after_mode: infraAfterMode,
          equal: infraPass
        },
        mktemp_records: mktempRecords,
        owned_processes: ownedRecords,
        held_proof: {
          raw: fs.existsSync(heldProofLog) ? fs.readFileSync(heldProofLog, 'utf8').trim() : null,
          pass: heldProofPass,
          detail: heldProofDetail
        },
        node_probe_receipt: probeReceipt,
        docker_invocations: {
          calls: parsedDockerCalls,
          reached_count: parsedDockerCalls.length,
          verification: requireDockerCall ? verifyDockerInvocation(dockerArgsLog, env.IMAGE_REFERENCE) : null
        },
        assertions: {
          exitPass,
          errPass,
          sentinelAlive,
          ownedCleaned,
          tempsCleaned,
          dockerCallPass,
          elapsedBoundsPass,
          heldProofPass,
          infraPass
        },
        passed: exitPass && errPass && sentinelAlive && ownedCleaned && tempsCleaned && dockerCallPass && elapsedBoundsPass && heldProofPass && infraPass
      };

      fs.writeFileSync(evFile, JSON.stringify(evidence, null, 2) + '\n');
    } catch {}
  }

  // Cleanup tmpDir
  fs.rmSync(tmpDir, { recursive: true, force: true });

  const passed = exitPass && errPass && sentinelAlive && ownedCleaned && tempsCleaned && dockerCallPass && elapsedBoundsPass && heldProofPass && infraPass;
  const failureDetails = [
    !exitPass ? `exit=${proc.status}` : '',
    !errPass ? 'errPass=false' : '',
    !sentinelAlive ? 'sentinelAlive=false' : '',
    !ownedCleaned ? 'ownedCleaned=false' : '',
    !tempsCleaned ? `tempsCleaned=false (${tempsDetail})` : '',
    !dockerCallPass ? `dockerCallPass=false (${dockerCallDetail})` : '',
    !elapsedBoundsPass ? `elapsedBoundsPass=false (${elapsedBoundsDetail})` : '',
    !heldProofPass ? `heldProofPass=false (${heldProofDetail})` : '',
    !infraPass ? 'infraPass=false' : ''
  ].filter(Boolean).join(', ');

  report(`Registry step - ${name}`, passed, failureDetails ? `${failureDetails}, elapsed=${elapsedSec.toFixed(2)}s` : `elapsed=${elapsedSec.toFixed(2)}s`);
}

// Execute Registry Step test cases
runRegistryStepCase({
  name: 'canonical valid descriptor',
  nodeMode: 'normal',
  dockerMode: 'valid',
  expectedExit: 0,
  expectedErrSubstr: 'Remote canonical manifest digest verified'
});

runRegistryStepCase({
  name: 'valid descriptor with extra metadata',
  nodeMode: 'normal',
  dockerMode: 'valid_metadata',
  expectedExit: 0,
  expectedErrSubstr: 'Remote canonical manifest digest verified'
});

// JSON descriptor shape & refusal controls (malformed/null/array/multiple/rootmissing/nonstring/nested/config-only/mismatch/inspect-nonzero)
runRegistryStepCase({
  name: 'malformed non-JSON refusal',
  nodeMode: 'normal',
  dockerMode: 'malformed_json',
  expectedExit: 1,
  expectedErrSubstr: 'Malformed registry JSON output'
});

runRegistryStepCase({
  name: 'null JSON refusal',
  nodeMode: 'normal',
  dockerMode: 'null_json',
  expectedExit: 1,
  expectedErrSubstr: 'Registry descriptor is not a JSON object'
});

runRegistryStepCase({
  name: 'array JSON refusal',
  nodeMode: 'normal',
  dockerMode: 'array_json',
  expectedExit: 1,
  expectedErrSubstr: 'Registry descriptor is not a JSON object'
});

runRegistryStepCase({
  name: 'multiple JSON refusal',
  nodeMode: 'normal',
  dockerMode: 'multiple_json',
  expectedExit: 1,
  expectedErrSubstr: 'Malformed registry JSON output'
});

runRegistryStepCase({
  name: 'root digest missing refusal',
  nodeMode: 'normal',
  dockerMode: 'root_missing',
  expectedExit: 1,
  expectedErrSubstr: 'Registry descriptor missing or invalid canonical root digest'
});

runRegistryStepCase({
  name: 'nonstring digest refusal',
  nodeMode: 'normal',
  dockerMode: 'nonstring_digest',
  expectedExit: 1,
  expectedErrSubstr: 'Registry descriptor missing or invalid canonical root digest'
});

runRegistryStepCase({
  name: 'nested manifest digest only refusal',
  nodeMode: 'normal',
  dockerMode: 'nested_digest',
  expectedExit: 1,
  expectedErrSubstr: 'Registry descriptor missing or invalid canonical root digest'
});

runRegistryStepCase({
  name: 'config digest only confusion refusal',
  nodeMode: 'normal',
  dockerMode: 'config_only',
  expectedExit: 1,
  expectedErrSubstr: 'Registry descriptor missing or invalid canonical root digest'
});

runRegistryStepCase({
  name: 'canonical digest mismatch refusal',
  nodeMode: 'normal',
  dockerMode: 'digest_mismatch',
  expectedExit: 1,
  expectedErrSubstr: 'Remote manifest digest mismatch'
});

runRegistryStepCase({
  name: 'inspect nonzero exit code refusal',
  nodeMode: 'normal',
  dockerMode: 'inspect_nonzero',
  expectedExit: 1,
  expectedErrSubstr: 'Registry inspection failed with exit code 1'
});

runRegistryStepCase({
  name: 'streaming stdout oversize refusal',
  nodeMode: 'normal',
  dockerMode: 'streaming_stdout_oversize',
  expectedExit: 1,
  expectedErrSubstr: 'Registry inspection exceeded stdout cap of 65536 bytes'
});

runRegistryStepCase({
  name: 'streaming stderr oversize refusal',
  nodeMode: 'normal',
  dockerMode: 'streaming_stderr_oversize',
  expectedExit: 1,
  expectedErrSubstr: 'Registry inspection exceeded stderr cap of 16384 bytes'
});

runRegistryStepCase({
  name: 'monitor forced exit 42',
  nodeMode: 'exit_42_after_held',
  dockerMode: 'held_descendant',
  expectedExit: 1,
  expectedErrSubstr: 'Registry inspection monitor failed with exit code 42',
  requireDockerCall: true
});

runRegistryStepCase({
  name: 'missing node binary',
  nodeMode: 'missing',
  dockerMode: 'held_descendant',
  expectedExit: 1,
  expectedErrSubstr: 'Registry inspection monitor failed with exit code 127',
  requireDockerCall: false
});

runRegistryStepCase({
  name: 'unknown monitor status',
  nodeMode: 'unknown_status',
  dockerMode: 'held_descendant',
  expectedExit: 1,
  expectedErrSubstr: "Registry inspection monitor returned unexpected status 'UNKNOWN'",
  requireDockerCall: false
});

runRegistryStepCase({
  name: 'fast stdout oversize refusal',
  nodeMode: 'normal',
  dockerMode: 'fast_stdout_oversize',
  expectedExit: 1,
  expectedErrSubstr: 'Registry inspection exceeded stdout cap of 65536 bytes'
});

runRegistryStepCase({
  name: 'fast stderr oversize refusal',
  nodeMode: 'normal',
  dockerMode: 'fast_stderr_oversize',
  expectedExit: 1,
  expectedErrSubstr: 'Registry inspection exceeded stderr cap of 16384 bytes'
});

runRegistryStepCase({
  name: 'normal monotonic 30s deadline timeout',
  nodeMode: 'normal',
  dockerMode: 'sleep_35',
  expectedExit: 1,
  expectedErrSubstr: 'Registry inspection timed out after 30 seconds',
  minElapsedSeconds: 30.0,
  maxElapsedSeconds: 34.0,
  timeoutSeconds: 45
});

// Unit regression check of parseDockerCalls and verifyDockerInvocation:
// Accepts canonical array, rejects split/joined-equivalent format and second calls
function runDockerArgCheckerUnitControls() {
  const cases = [
    {
      name: 'Docker arg checker - canonical single call verification',
      kind: 'canonical',
      expectedPass: true
    },
    {
      name: 'Docker arg checker - split format arguments rejection',
      kind: 'split',
      expectedPass: false
    },
    {
      name: 'Docker arg checker - multiple invocations rejection',
      kind: 'double',
      expectedPass: false
    }
  ];

  for (const c of cases) {
    if (!shouldRun(c.name)) {
      skipCount++;
      continue;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-checker-unit-'));
    try {
      const fixtureImg = 'ghcr.io/duikindiesee/sportifine-server:0.1.0';
      const logPath = path.join(tmpDir, 'docker.log');

      const canonicalBuf = Buffer.from(
        'CALL_START\n' +
        ['buildx', 'imagetools', 'inspect', '--format', '{{json .Manifest}}', fixtureImg].join('\0') +
        '\0\nCALL_END\n',
        'binary'
      );

      let buf;
      if (c.kind === 'canonical') {
        buf = canonicalBuf;
      } else if (c.kind === 'split') {
        buf = Buffer.from(
          'CALL_START\n' +
          ['buildx', 'imagetools', 'inspect', '--format', '{{json', '.Manifest}}', fixtureImg].join('\0') +
          '\0\nCALL_END\n',
          'binary'
        );
      } else if (c.kind === 'double') {
        buf = Buffer.concat([canonicalBuf, canonicalBuf]);
      }

      fs.writeFileSync(logPath, buf);
      const res = verifyDockerInvocation(logPath, fixtureImg);
      const testPassed = (res.pass === c.expectedPass);
      report(c.name, testPassed, `expectedPass=${c.expectedPass}, actualPass=${res.pass}, detail=${res.detail}`);
    } catch (err) {
      report(c.name, false, err.message);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

runDockerArgCheckerUnitControls();

// =============================================================================
// SECTION 2: Consumer CLI & Kustomize Render Controls
// =============================================================================

function semanticEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!semanticEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i++) {
    if (keysA[i] !== keysB[i]) return false;
    if (!semanticEqual(a[keysA[i]], b[keysB[i]])) return false;
  }
  return true;
}

function getFullResourceKey(res) {
  if (!res || typeof res !== 'object') throw new Error('Resource is not an object');
  const kind = res.kind;
  const name = res.metadata && res.metadata.name;
  const namespace = (res.metadata && typeof res.metadata.namespace === 'string' && res.metadata.namespace.length > 0) ? res.metadata.namespace : null;
  if (!kind || !name) throw new Error(`Resource missing kind or name: kind=${kind}, name=${name}`);
  return namespace !== null ? `${kind}/${namespace}/${name}` : `${kind}/${name}`;
}

function deriveExpectedTargets(resources, expectedImage) {
  const targets = [];
  for (const res of resources) {
    if (!res || typeof res !== 'object') continue;
    const resourceKey = getFullResourceKey(res);

    const podSpecs = [];
    if (res.spec && res.spec.template && res.spec.template.spec) {
      podSpecs.push({ specPath: 'spec.template.spec', spec: res.spec.template.spec });
    }
    if (res.spec && res.spec.jobTemplate && res.spec.jobTemplate.spec && res.spec.jobTemplate.spec.template && res.spec.jobTemplate.spec.template.spec) {
      podSpecs.push({ specPath: 'spec.jobTemplate.spec.template.spec', spec: res.spec.jobTemplate.spec.template.spec });
    }
    if (res.spec && res.spec.containers && Array.isArray(res.spec.containers)) {
      podSpecs.push({ specPath: 'spec', spec: res.spec });
    }

    for (const { specPath, spec } of podSpecs) {
      for (const field of ['containers', 'initContainers']) {
        const list = spec[field];
        if (Array.isArray(list)) {
          for (const c of list) {
            if (c && typeof c === 'object') {
              const img = c.image || '';
              if (img === expectedImage || img.startsWith(`${expectedImage}:`)) {
                targets.push({
                  resourceKey,
                  specPath,
                  field,
                  containerName: c.name
                });
              }
            }
          }
        }
      }
    }
  }
  return targets;
}

function analyzeRender(renderedText, expectedImage) {
  const docs = yaml.parseAllDocuments(renderedText).map(d => d.toJSON()).filter(Boolean);
  const docsByKey = new Map();
  const targetIdentities = [];

  for (const doc of docs) {
    const resourceKey = getFullResourceKey(doc);
    if (docsByKey.has(resourceKey)) {
      throw new Error(`DUPLICATE_RESOURCE_KEY: Duplicate full resource key found in rendered output: '${resourceKey}'`);
    }
    docsByKey.set(resourceKey, doc);

    const podSpecs = [];
    if (doc.spec && doc.spec.template && doc.spec.template.spec) {
      podSpecs.push({ specPath: 'spec.template.spec', spec: doc.spec.template.spec });
    }
    if (doc.spec && doc.spec.jobTemplate && doc.spec.jobTemplate.spec && doc.spec.jobTemplate.spec.template && doc.spec.jobTemplate.spec.template.spec) {
      podSpecs.push({ specPath: 'spec.jobTemplate.spec.template.spec', spec: doc.spec.jobTemplate.spec.template.spec });
    }
    if (doc.spec && doc.spec.containers && Array.isArray(doc.spec.containers)) {
      podSpecs.push({ specPath: 'spec', spec: doc.spec });
    }

    for (const { specPath, spec } of podSpecs) {
      for (const field of ['containers', 'initContainers']) {
        const list = spec[field];
        if (Array.isArray(list)) {
          for (const c of list) {
            if (c && typeof c === 'object') {
              const img = c.image || '';
              if (img === expectedImage || img.startsWith(`${expectedImage}:`) || img.startsWith(`${expectedImage}@`)) {
                targetIdentities.push({
                  resourceKey,
                  specPath,
                  field,
                  containerName: c.name,
                  image: img
                });
              }
            }
          }
        }
      }
    }
  }
  return { docsByKey, targetIdentities };
}

function maskTargetImagesInDoc(doc, targetList) {
  const cloned = JSON.parse(JSON.stringify(doc));
  if (!targetList || targetList.length === 0) return cloned;
  const targetMap = new Map();
  for (const t of targetList) {
    targetMap.set(`${t.specPath}:${t.field}:${t.containerName}`, true);
  }

  const podSpecs = [];
  if (cloned.spec && cloned.spec.template && cloned.spec.template.spec) {
    podSpecs.push({ specPath: 'spec.template.spec', spec: cloned.spec.template.spec });
  }
  if (cloned.spec && cloned.spec.jobTemplate && cloned.spec.jobTemplate.spec && cloned.spec.jobTemplate.spec.template && cloned.spec.jobTemplate.spec.template.spec) {
    podSpecs.push({ specPath: 'spec.jobTemplate.spec.template.spec', spec: cloned.spec.jobTemplate.spec.template.spec });
  }
  if (cloned.spec && cloned.spec.containers && Array.isArray(cloned.spec.containers)) {
    podSpecs.push({ specPath: 'spec', spec: cloned.spec });
  }
  for (const { specPath, spec } of podSpecs) {
    for (const field of ['containers', 'initContainers']) {
      const list = spec[field];
      if (Array.isArray(list)) {
        for (const c of list) {
          if (c && typeof c === 'object' && targetMap.has(`${specPath}:${field}:${c.name}`)) {
            c.image = '__MASKED_TARGET_IMAGE__';
          }
        }
      }
    }
  }
  return cloned;
}

function runConsumerTestCase({
  name,
  resources,
  mutateSecondRender = null,
  envOverride = {},
  fixtureHook = null,
  cliPathOverride = null,
  expectedExit = 0,
  expectedErr = '',
  expectRendererNotReached = false,
  expectMutationReached = false
}) {
  const fullName = `Consumer CLI - ${name}`;
  if (!shouldRun(fullName)) {
    skipCount++;
    return;
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `consumer-test-${name.replace(/[^a-zA-Z0-9_-]/g, '_')}-`));
  const kustomizePath = 'manifests/overlays/develop/sportifine-server';
  const targetDir = path.join(tmpDir, 'infra', kustomizePath);
  fs.mkdirSync(targetDir, { recursive: true });

  const fileNames = [];
  if (resources) {
    for (let i = 0; i < resources.length; i++) {
      const fn = `resource${i}.json`;
      fs.writeFileSync(path.join(targetDir, fn), JSON.stringify(resources[i], null, 2) + '\n');
      fileNames.push(fn);
    }

    const kustObj = {
      apiVersion: 'kustomize.config.k8s.io/v1beta1',
      kind: 'Kustomization',
      resources: fileNames
    };
    fs.writeFileSync(path.join(targetDir, 'kustomization.yaml'), JSON.stringify(kustObj, null, 2) + '\n');
  }

  let effectiveCliPath = UPDATE_CLI_PATH;
  if (fixtureHook) {
    const hookResult = fixtureHook({ tmpDir, targetDir, kustomizePath, infraDir: path.join(tmpDir, 'infra') });
    if (hookResult && hookResult.cliPath) {
      effectiveCliPath = hookResult.cliPath;
    }
  }
  if (cliPathOverride) {
    effectiveCliPath = cliPathOverride;
  }

  const snapshotDir = (dir) => {
    const snap = {};
    if (!fs.existsSync(dir)) return snap;
    for (const f of fs.readdirSync(dir, { recursive: true })) {
      const full = path.join(dir, f);
      const lst = fs.lstatSync(full);
      if (lst.isFile()) {
        snap[f] = { type: 'file', sha: sha256(fs.readFileSync(full)), mode: lst.mode & 0o777 };
      } else if (lst.isSymbolicLink()) {
        snap[f] = { type: 'symlink', target: fs.readlinkSync(full) };
      }
    }
    return snap;
  };

  const beforeSnap = snapshotDir(path.join(tmpDir, 'infra'));

  // Setup bin adapter with execution tracing
  const binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const countFile = path.join(tmpDir, 'render_count.txt');
  const traceLog = path.join(tmpDir, 'render_trace.log');

  const mutateMode = mutateSecondRender || '';
  const adapterCode = `#!/bin/sh
COUNT=1
if [ -f "${countFile}" ]; then
  COUNT=$(cat "${countFile}")
  COUNT=$((COUNT + 1))
fi
echo "$COUNT" > "${countFile}"

echo "RENDER_CALL:$COUNT:$*" >> "${traceLog}"

RAW_OUT=$("$REAL_RENDERER" "$@")
STATUS=$?
if [ $STATUS -ne 0 ]; then
  echo "RENDER_FAIL:$COUNT:$STATUS" >> "${traceLog}"
  exit $STATUS
fi

if [ "$COUNT" -eq 2 ] && [ -n "${mutateMode}" ]; then
  echo "RENDER_MUTATE_START:$COUNT:${mutateMode}" >> "${traceLog}"
  echo "$RAW_OUT" | node -e '
    const fs = require("node:fs");
    const yaml = require("${path.join(__dirname, "node_modules/yaml")}");
    const docs = yaml.parseAllDocuments(fs.readFileSync(0, "utf8")).map(d => d.toJSON());
    const dep = docs.find(d => d && d.kind === "Deployment" && d.metadata && d.metadata.name === "sportifine-server");
    const mode = process.argv[1];
    let applied = false;
    let details = {};

    if (mode === "noop") {
      applied = true;
      details = { mode: "noop", target: "passthrough", mutated: false };
    } else if (mode === "sidecar") {
      const c = dep.spec.template.spec.containers.find(x => x.name === "cache");
      if (c) {
        c.image = "nginx:9.9-corrupted";
        applied = true;
        details = { mode: "sidecar", resource: "Deployment/kooker/sportifine-server", container: "cache", mutated_image: c.image };
      }
    } else if (mode === "env") {
      const c = dep.spec.template.spec.containers.find(x => x.name === "sportifine-server");
      if (c) {
        c.env = [{ name: "CORRUPTED", value: "MUTATED" }];
        applied = true;
        details = { mode: "env", resource: "Deployment/kooker/sportifine-server", container: "sportifine-server", mutated_env: c.env };
      }
    } else if (mode === "unpinned_stale") {
      const c = dep.spec.template.spec.containers.find(x => x.name === "sportifine-server");
      if (c) {
        c.image = "ghcr.io/duikindiesee/sportifine-server:placeholder";
        applied = true;
        details = { mode: "unpinned_stale", resource: "Deployment/kooker/sportifine-server", container: "sportifine-server", reverted_image: c.image };
      }
    } else if (mode === "identity_count_mismatch") {
      dep.spec.template.spec.containers.push({
        name: "extra-container",
        image: "ghcr.io/duikindiesee/sportifine-server@sha256:" + "a".repeat(64)
      });
      applied = true;
      details = { mode: "identity_count_mismatch", resource: "Deployment/kooker/sportifine-server", added_container: "extra-container", total_containers: dep.spec.template.spec.containers.length };
    } else if (mode === "identity_name_mismatch") {
      const oldName = dep.spec.template.spec.containers[0].name;
      dep.spec.template.spec.containers[0].name = "renamed-container";
      applied = true;
      details = { mode: "identity_name_mismatch", resource: "Deployment/kooker/sportifine-server", original_container: oldName, renamed_container: "renamed-container" };
    } else if (mode === "unexpected_resource") {
      const extraDoc = {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: { name: "unexpected-cm", namespace: "kooker" },
        data: { k: "v" }
      };
      docs.push(extraDoc);
      applied = true;
      details = { mode: "unexpected_resource", added_resource: "ConfigMap/kooker/unexpected-cm" };
    } else if (mode === "missing_resource") {
      const idx = docs.findIndex(d => d && d.kind === "ConfigMap" && d.metadata && d.metadata.name === "app-cfg");
      if (idx !== -1) {
        docs.splice(idx, 1);
        applied = true;
        details = { mode: "missing_resource", removed_resource: "ConfigMap/kooker/app-cfg", remaining_docs_count: docs.length };
      }
    }
    fs.appendFileSync(process.argv[2], "RENDER_MUTATE_DONE:" + mode + ":" + JSON.stringify(details) + String.fromCharCode(10));
    process.stdout.write(docs.map(d => yaml.stringify(d)).join("---" + String.fromCharCode(10)));
  ' "${mutateMode}" "${traceLog}"
else
  printf "%s" "$RAW_OUT"
fi
`;
  fs.writeFileSync(path.join(binDir, path.basename(KUSTOMIZE_TOOL.cmd)), adapterCode, { mode: 0o755 });

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    REAL_RENDERER: KUSTOMIZE_TOOL.cmd,
    NODE_PATH: path.join(__dirname, 'node_modules'),
    CALLER_REPO: 'duikindiesee/sportifine-server',
    IMAGE_NAME: 'ghcr.io/duikindiesee/sportifine-server',
    KUSTOMIZE_PATH: kustomizePath,
    NEW_DIGEST: 'sha256:' + 'a'.repeat(64),
    NEW_TAG: '1.14.0',
    INFRA_DIR: path.join(tmpDir, 'infra'),
    ...envOverride
  };

  const tStart = process.hrtime.bigint();
  const res = spawnSync(process.execPath, [effectiveCliPath], {
    cwd: tmpDir,
    env,
    encoding: 'utf8',
    timeout: 10000
  });
  const tEnd = process.hrtime.bigint();
  const elapsedSec = Number(tEnd - tStart) / 1e9;

  const afterSnap = snapshotDir(path.join(tmpDir, 'infra'));

  const exitPass = (res.status === expectedExit);
  const combinedOut = (res.stdout || '') + '\n' + (res.stderr || '');
  const errPass = expectedErr ? combinedOut.includes(expectedErr) : true;
  const rollbackPass = (expectedExit !== 0) ? (JSON.stringify(beforeSnap) === JSON.stringify(afterSnap)) : true;

  // Trace verification
  const traceContent = fs.existsSync(traceLog) ? fs.readFileSync(traceLog, 'utf8').trim() : '';
  const traceCalls = traceContent ? traceContent.split('\n') : [];
  const rendererCalls = traceCalls.filter(l => l.startsWith('RENDER_CALL:'));
  const mutateCalls = traceCalls.filter(l => l.startsWith('RENDER_MUTATE_START:') || l.startsWith('RENDER_MUTATE_DONE:'));

  let rendererNotReachedPass = true;
  if (expectRendererNotReached) {
    rendererNotReachedPass = (rendererCalls.length === 0);
  }

  let mutationReachedPass = true;
  if (expectMutationReached) {
    mutationReachedPass = (mutateCalls.length > 0);
  }

  let validAssertionsPass = true;
  let validDetail = '';

  let positivePinData = null;
  if (expectedExit === 0 && exitPass && resources) {
    try {
      const targetCanonical = path.join(tmpDir, 'infra', kustomizePath);
      const digestA = 'sha256:' + 'a'.repeat(64);
      const digestB = 'sha256:' + 'b'.repeat(64);
      const declaredTargets = deriveExpectedTargets(resources, CANONICAL_IMAGE);
      const targetIdentityKey = t => `${t.resourceKey}:${t.specPath}:${t.field}:${t.containerName}`;
      const sortedDeclaredKeys = declaredTargets.map(targetIdentityKey).sort();

      // Collect exact complete pre-fixture resources map (refusing duplicates)
      const preDocsByKey = new Map();
      for (const r of resources) {
        const key = getFullResourceKey(r);
        if (preDocsByKey.has(key)) {
          throw new Error(`DUPLICATE_FIXTURE_RESOURCE: Duplicate resource key in test fixture: '${key}'`);
        }
        preDocsByKey.set(key, r);
      }
      const sortedPreResourceKeys = [...preDocsByKey.keys()].sort();

      // 1. Absolute REAL Kustomize build after first CLI
      const render1 = spawnSync(KUSTOMIZE_TOOL.cmd, [...KUSTOMIZE_TOOL.args, targetCanonical], {
        encoding: 'utf8',
        timeout: 10000
      });
      assert.equal(render1.status, 0, `Kustomize build after digest A failed: ${render1.stderr}`);
      const analysis1 = analyzeRender(render1.stdout, CANONICAL_IMAGE);
      const sortedActualKeys1 = analysis1.targetIdentities.map(targetIdentityKey).sort();

      // Assert exact complete resource identity set pre vs render1
      const sortedRender1ResourceKeys = [...analysis1.docsByKey.keys()].sort();
      assert.deepEqual(sortedRender1ResourceKeys, sortedPreResourceKeys, 'Complete resource identity set mismatch pre vs render1');

      // Assert exact declared target identity set (including PodSpec path)
      assert.deepEqual(sortedActualKeys1, sortedDeclaredKeys, 'Target identity set mismatch after digest A update');

      // Assert all target images are pinned to digest A
      for (const t of analysis1.targetIdentities) {
        assert.equal(t.image, `${CANONICAL_IMAGE}@${digestA}`, `Target ${targetIdentityKey(t)} image mismatch after digest A update`);
      }

      // Assert unrelated semantics preserved: mask ONLY declared target images in pre-fixture and render1
      for (const [resKey, preDoc] of preDocsByKey) {
        const postDoc = analysis1.docsByKey.get(resKey);
        assert.ok(postDoc, `Resource ${resKey} missing in render1`);
        const targetsForRes = declaredTargets.filter(t => t.resourceKey === resKey);
        const maskedPre = maskTargetImagesInDoc(preDoc, targetsForRes);
        const maskedPost = maskTargetImagesInDoc(postDoc, targetsForRes);
        assert.ok(semanticEqual(maskedPre, maskedPost), `Resource ${resKey} unrelated fields mutated in render1`);
      }

      // 2. Invoke actual CLI again on SAME fixture with distinct digest B
      const envB = {
        ...env,
        NEW_DIGEST: digestB,
        NEW_TAG: '1.15.0'
      };
      const resB = spawnSync(process.execPath, [effectiveCliPath], {
        cwd: tmpDir,
        env: envB,
        encoding: 'utf8',
        timeout: 10000
      });
      assert.equal(resB.status, 0, `Second CLI invocation with digest B failed: ${resB.stderr}`);

      // 3. Absolute REAL Kustomize build after second CLI
      const render2 = spawnSync(KUSTOMIZE_TOOL.cmd, [...KUSTOMIZE_TOOL.args, targetCanonical], {
        encoding: 'utf8',
        timeout: 10000
      });
      assert.equal(render2.status, 0, `Kustomize build after digest B failed: ${render2.stderr}`);
      const analysis2 = analyzeRender(render2.stdout, CANONICAL_IMAGE);
      const sortedActualKeys2 = analysis2.targetIdentities.map(targetIdentityKey).sort();

      // Assert exact complete resource identity set pre vs render2
      const sortedRender2ResourceKeys = [...analysis2.docsByKey.keys()].sort();
      assert.deepEqual(sortedRender2ResourceKeys, sortedPreResourceKeys, 'Complete resource identity set mismatch pre vs render2');

      // Assert exact declared target identity set
      assert.deepEqual(sortedActualKeys2, sortedDeclaredKeys, 'Target identity set mismatch after digest B update');

      // Assert all target images are pinned to digest B, no digest A, no stale tag
      for (const t of analysis2.targetIdentities) {
        assert.equal(t.image, `${CANONICAL_IMAGE}@${digestB}`, `Target ${targetIdentityKey(t)} image mismatch after digest B update`);
      }
      assert.ok(!render2.stdout.includes(digestA), 'Rendered output after digest B must not contain prior digest A');
      assert.ok(!render2.stdout.includes(':1.14.0'), 'Rendered output after digest B must not contain prior tag 1.14.0');
      assert.ok(!render2.stdout.includes(':1.15.0'), 'Rendered output after digest B must not contain tag 1.15.0');

      // Assert unrelated semantics preserved between pre-fixture and render2
      for (const [resKey, preDoc] of preDocsByKey) {
        const postDoc = analysis2.docsByKey.get(resKey);
        assert.ok(postDoc, `Resource ${resKey} missing in render2`);
        const targetsForRes = declaredTargets.filter(t => t.resourceKey === resKey);
        const maskedPre = maskTargetImagesInDoc(preDoc, targetsForRes);
        const maskedPost = maskTargetImagesInDoc(postDoc, targetsForRes);
        assert.ok(semanticEqual(maskedPre, maskedPost), `Resource ${resKey} unrelated fields mutated in render2`);
      }

      positivePinData = {
        digest_a_pinned: digestA,
        digest_b_pinned: digestB,
        declared_target_identities: sortedDeclaredKeys,
        render1_target_identities: sortedActualKeys1,
        render2_target_identities: sortedActualKeys2,
        unrelated_semantics_preserved: true
      };
    } catch (e) {
      validAssertionsPass = false;
      validDetail = e.message;
    }
  }

  // Evidence retention if TEST_EVIDENCE_DIR set
  if (process.env.TEST_EVIDENCE_DIR) {
    try {
      const evDir = path.resolve(process.env.TEST_EVIDENCE_DIR);
      fs.mkdirSync(evDir, { recursive: true });
      const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
      const evFile = path.join(evDir, `consumer_cli_${safeName}.json`);

      const evidence = {
        name,
        actual_exit: res.status,
        expected_exit: expectedExit,
        elapsed_seconds: elapsedSec,
        stdout: res.stdout || '',
        stderr: res.stderr || '',
        render_trace_calls: traceCalls,
        renderer_invocations_count: rendererCalls.length,
        expect_renderer_not_reached: expectRendererNotReached,
        renderer_not_reached: rendererCalls.length === 0,
        expect_synthetic_fault_injection_reached: expectMutationReached,
        synthetic_fault_injection_reached: mutateCalls.length > 0,
        actual_digest_pin_successful: (expectedExit === 0 && exitPass),
        rollback_restored: (expectedExit !== 0) ? rollbackPass : 'not_applicable',
        before_infra_snapshot: beforeSnap,
        after_infra_snapshot: afterSnap,
        positive_pin_data: positivePinData,
        assertions: {
          exit_pass: exitPass,
          err_pass: errPass,
          rollback_pass: (expectedExit !== 0) ? rollbackPass : true,
          renderer_not_reached_pass: rendererNotReachedPass,
          synthetic_fault_injection_reached_pass: mutationReachedPass,
          valid_assertions_pass: validAssertionsPass
        }
      };
      fs.writeFileSync(evFile, JSON.stringify(evidence, null, 2) + '\n');
    } catch (e) {
      console.error(`Failed to write evidence for ${name}:`, e.message);
    }
  }

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });

  const passed = exitPass && errPass && rollbackPass && rendererNotReachedPass && mutationReachedPass && validAssertionsPass;
  report(`Consumer CLI - ${name}`, passed, `exit=${res.status} (exp ${expectedExit}), errPass=${errPass}, rollbackPass=${rollbackPass}, rendererCalls=${rendererCalls.length}, mutateCalls=${mutateCalls.length}${validDetail ? ', validErr=' + validDetail : ''}`);
}

const CANONICAL_IMAGE = 'ghcr.io/duikindiesee/sportifine-server';

// 1. Initial pin over Deployment + sidecar + ConfigMap
runConsumerTestCase({
  name: 'initial placeholder pin with sidecar and ConfigMap',
  resources: [
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'sportifine-server', namespace: 'kooker' },
      spec: {
        template: {
          spec: {
            containers: [
              { name: 'sportifine-server', image: `${CANONICAL_IMAGE}:placeholder`, env: [{ name: 'APP_ENV', value: 'develop' }] },
              { name: 'cache', image: 'nginx:1.25' }
            ]
          }
        }
      }
    },
    {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'app-cfg', namespace: 'kooker' },
      data: { DB_HOST: 'localhost' }
    }
  ],
  expectedExit: 0
});

// 2. Initial pin over Deployment + initContainer + Job + CronJob
runConsumerTestCase({
  name: 'multi-workload Deployment, initContainer, Job, CronJob',
  resources: [
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'sportifine-server', namespace: 'kooker' },
      spec: {
        template: {
          spec: {
            initContainers: [{ name: 'migration', image: `${CANONICAL_IMAGE}:placeholder` }],
            containers: [{ name: 'sportifine-server', image: `${CANONICAL_IMAGE}:placeholder` }]
          }
        }
      }
    },
    {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name: 'sportifine-worker', namespace: 'kooker' },
      spec: {
        template: {
          spec: {
            restartPolicy: 'Never',
            containers: [{ name: 'worker', image: `${CANONICAL_IMAGE}:placeholder` }]
          }
        }
      }
    },
    {
      apiVersion: 'batch/v1',
      kind: 'CronJob',
      metadata: { name: 'sportifine-cron', namespace: 'kooker' },
      spec: {
        schedule: '0 0 * * *',
        jobTemplate: {
          spec: {
            template: {
              spec: {
                restartPolicy: 'Never',
                containers: [{ name: 'cron-runner', image: `${CANONICAL_IMAGE}:placeholder` }]
              }
            }
          }
        }
      }
    }
  ],
  expectedExit: 0
});

// 2B. Neutral no-op mutation through same second-render injection branch succeeds
runConsumerTestCase({
  name: 'neutral no-op mutation through second-render branch succeeds',
  resources: [
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'sportifine-server', namespace: 'kooker' },
      spec: {
        template: {
          spec: {
            containers: [
              { name: 'sportifine-server', image: `${CANONICAL_IMAGE}:placeholder`, env: [{ name: 'APP_ENV', value: 'develop' }] },
              { name: 'cache', image: 'nginx:1.25' }
            ]
          }
        }
      }
    },
    {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'app-cfg', namespace: 'kooker' },
      data: { DB_HOST: 'localhost' }
    }
  ],
  mutateSecondRender: 'noop',
  expectedExit: 0,
  expectMutationReached: true
});

// 3. Sidecar mutation in target Deployment -> refusal and atomic rollback
runConsumerTestCase({
  name: 'sidecar mutation in target Deployment refused with rollback',
  resources: [
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'sportifine-server', namespace: 'kooker' },
      spec: {
        template: {
          spec: {
            containers: [
              { name: 'sportifine-server', image: `${CANONICAL_IMAGE}:placeholder` },
              { name: 'cache', image: 'nginx:1.25' }
            ]
          }
        }
      }
    }
  ],
  mutateSecondRender: 'sidecar',
  expectedExit: 1,
  expectedErr: 'RENDER_UNRELATED_MUTATION',
  expectMutationReached: true
});

// 4. Unrelated container env change in target Deployment -> refusal and atomic rollback
runConsumerTestCase({
  name: 'unrelated env mutation in target container refused with rollback',
  resources: [
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'sportifine-server', namespace: 'kooker' },
      spec: {
        template: {
          spec: {
            containers: [
              { name: 'sportifine-server', image: `${CANONICAL_IMAGE}:placeholder`, env: [{ name: 'KEEP', value: 'true' }] }
            ]
          }
        }
      }
    }
  ],
  mutateSecondRender: 'env',
  expectedExit: 1,
  expectedErr: 'RENDER_UNRELATED_MUTATION',
  expectMutationReached: true
});

// -----------------------------------------------------------------------------
// Additional Consumer Contract & Error Refusal Cases
// -----------------------------------------------------------------------------

// 5. Unauthorized caller repository refused before any render
runConsumerTestCase({
  name: 'unauthorized caller repo refused before render',
  resources: [
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'sportifine-server', namespace: 'kooker' },
      spec: { template: { spec: { containers: [{ name: 'sportifine-server', image: `${CANONICAL_IMAGE}:placeholder` }] } } }
    }
  ],
  envOverride: { CALLER_REPO: 'unauthorized/caller-repo' },
  expectedExit: 1,
  expectedErr: 'DIGEST_CONTRACT_ERROR: caller repository',
  expectRendererNotReached: true
});

// 6. Unauthorized image name refused before any render
runConsumerTestCase({
  name: 'unauthorized image name refused before render',
  resources: [
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'sportifine-server', namespace: 'kooker' },
      spec: { template: { spec: { containers: [{ name: 'sportifine-server', image: `${CANONICAL_IMAGE}:placeholder` }] } } }
    }
  ],
  envOverride: { IMAGE_NAME: 'ghcr.io/unauthorized/other-image' },
  expectedExit: 1,
  expectedErr: 'DIGEST_CONTRACT_ERROR: image_name',
  expectRendererNotReached: true
});

// 7. Unauthorized kustomize path refused before any render
runConsumerTestCase({
  name: 'unauthorized kustomize path refused before render',
  resources: [
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'sportifine-server', namespace: 'kooker' },
      spec: { template: { spec: { containers: [{ name: 'sportifine-server', image: `${CANONICAL_IMAGE}:placeholder` }] } } }
    }
  ],
  envOverride: { KUSTOMIZE_PATH: 'manifests/overlays/production/other-app' },
  expectedExit: 1,
  expectedErr: 'DIGEST_CONTRACT_ERROR: kustomize_path',
  expectRendererNotReached: true
});

// 8. Malformed digest format refused before any render
runConsumerTestCase({
  name: 'malformed digest format refused before render',
  resources: [
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'sportifine-server', namespace: 'kooker' },
      spec: { template: { spec: { containers: [{ name: 'sportifine-server', image: `${CANONICAL_IMAGE}:placeholder` }] } } }
    }
  ],
  envOverride: { NEW_DIGEST: 'sha256:not-a-valid-hex-digest-short' },
  expectedExit: 1,
  expectedErr: 'DIGEST_CONTRACT_ERROR: new_digest',
  expectRendererNotReached: true
});

// 9. Malformed tag characters refused before any render
runConsumerTestCase({
  name: 'malformed tag characters refused before render',
  resources: [
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'sportifine-server', namespace: 'kooker' },
      spec: { template: { spec: { containers: [{ name: 'sportifine-server', image: `${CANONICAL_IMAGE}:placeholder` }] } } }
    }
  ],
  envOverride: { NEW_TAG: 'tag with spaces not allowed' },
  expectedExit: 1,
  expectedErr: 'DIGEST_CONTRACT_ERROR: new_tag',
  expectRendererNotReached: true
});

// 10. Missing infra directory refused before any render
runConsumerTestCase({
  name: 'missing infra directory refused before render',
  resources: null,
  envOverride: { INFRA_DIR: '/tmp/nonexistent-infra-dir-refusal' },
  expectedExit: 1,
  expectedErr: 'INFRA_DIR_NOT_FOUND',
  expectRendererNotReached: true
});

// 11. Missing target overlay directory refused before any render
runConsumerTestCase({
  name: 'missing target directory refused before render',
  resources: null,
  fixtureHook: ({ targetDir }) => {
    fs.rmSync(targetDir, { recursive: true, force: true });
  },
  expectedExit: 1,
  expectedErr: 'TARGET_DIR_NOT_FOUND',
  expectRendererNotReached: true
});

// 12. Missing kustomization.yaml file refused before any render
runConsumerTestCase({
  name: 'missing kustomization file refused before render',
  resources: null,
  fixtureHook: ({ targetDir }) => {
    // targetDir exists but has no kustomization.yaml
  },
  expectedExit: 1,
  expectedErr: 'KUSTOMIZATION_NOT_FOUND',
  expectRendererNotReached: true
});

// 13. Pre-render missing backend Deployment refused before write
runConsumerTestCase({
  name: 'pre-render missing backend Deployment refused before write',
  resources: [
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'other-deployment', namespace: 'kooker' },
      spec: { template: { spec: { containers: [{ name: 'other', image: `${CANONICAL_IMAGE}:placeholder` }] } } }
    }
  ],
  expectedExit: 1,
  expectedErr: 'PRE_RENDER_MISSING_DEPLOYMENT'
});

// 14. Pre-render zero targets matching canonical image refused before write
runConsumerTestCase({
  name: 'pre-render zero matching targets refused before write',
  resources: [
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'sportifine-server', namespace: 'kooker' },
      spec: { template: { spec: { containers: [{ name: 'sportifine-server', image: 'nginx:1.25' }] } } }
    }
  ],
  expectedExit: 1,
  expectedErr: 'PRE_RENDER_ZERO_TARGETS'
});

// 15. Pre-render missing backend container anchor refused before write
runConsumerTestCase({
  name: 'pre-render missing container anchor refused before write',
  resources: [
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'sportifine-server', namespace: 'kooker' },
      spec: { template: { spec: { containers: [{ name: 'unrelated-container-name', image: `${CANONICAL_IMAGE}:placeholder` }] } } }
    }
  ],
  expectedExit: 1,
  expectedErr: 'PRE_RENDER_MISSING_CONTAINER'
});

// 16. Duplicate matching image entries in kustomization.yaml refused before write
runConsumerTestCase({
  name: 'duplicate image entries in kustomization refused before write',
  resources: [
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'sportifine-server', namespace: 'kooker' },
      spec: { template: { spec: { containers: [{ name: 'sportifine-server', image: `${CANONICAL_IMAGE}:placeholder` }] } } }
    }
  ],
  fixtureHook: ({ targetDir }) => {
    const kustObj = {
      apiVersion: 'kustomize.config.k8s.io/v1beta1',
      kind: 'Kustomization',
      resources: ['resource0.json'],
      images: [
        { name: CANONICAL_IMAGE, newName: CANONICAL_IMAGE, digest: 'sha256:' + 'b'.repeat(64) },
        { name: CANONICAL_IMAGE, newName: CANONICAL_IMAGE, digest: 'sha256:' + 'c'.repeat(64) }
      ]
    };
    fs.writeFileSync(path.join(targetDir, 'kustomization.yaml'), JSON.stringify(kustObj, null, 2) + '\n');
  },
  expectedExit: 1,
  expectedErr: 'KUSTOMIZATION_CONFLICT'
});

// 17. Post-render unpinned stale image retained refused with rollback
runConsumerTestCase({
  name: 'post-render unpinned stale image refused with rollback',
  resources: [
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'sportifine-server', namespace: 'kooker' },
      spec: { template: { spec: { containers: [{ name: 'sportifine-server', image: `${CANONICAL_IMAGE}:placeholder` }] } } }
    }
  ],
  mutateSecondRender: 'unpinned_stale',
  expectedExit: 1,
  expectedErr: 'RENDER_UNEXPECTED_TARGET',
  expectMutationReached: true
});

// 18. Post-render target identity count mismatch refused with rollback
runConsumerTestCase({
  name: 'post-render target identity count mismatch refused with rollback',
  resources: [
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'sportifine-server', namespace: 'kooker' },
      spec: { template: { spec: { containers: [{ name: 'sportifine-server', image: `${CANONICAL_IMAGE}:placeholder` }] } } }
    }
  ],
  mutateSecondRender: 'identity_count_mismatch',
  expectedExit: 1,
  expectedErr: 'RENDER_IDENTITY_SET_MISMATCH',
  expectMutationReached: true
});

// 19. Post-render target container name mismatch refused with rollback
runConsumerTestCase({
  name: 'post-render container name mismatch refused with rollback',
  resources: [
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'sportifine-server', namespace: 'kooker' },
      spec: { template: { spec: { containers: [{ name: 'sportifine-server', image: `${CANONICAL_IMAGE}:placeholder` }] } } }
    }
  ],
  mutateSecondRender: 'identity_name_mismatch',
  expectedExit: 1,
  expectedErr: 'RENDER_MISSING_CONTAINER',
  expectMutationReached: true
});

// 20. Post-render unexpected new resource refused with rollback
runConsumerTestCase({
  name: 'post-render unexpected new resource refused with rollback',
  resources: [
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'sportifine-server', namespace: 'kooker' },
      spec: { template: { spec: { containers: [{ name: 'sportifine-server', image: `${CANONICAL_IMAGE}:placeholder` }] } } }
    }
  ],
  mutateSecondRender: 'unexpected_resource',
  expectedExit: 1,
  expectedErr: 'RENDER_UNRELATED_MUTATION',
  expectMutationReached: true
});

// 21. Post-render missing pre-render resource refused with rollback
runConsumerTestCase({
  name: 'post-render missing pre-render resource refused with rollback',
  resources: [
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'sportifine-server', namespace: 'kooker' },
      spec: { template: { spec: { containers: [{ name: 'sportifine-server', image: `${CANONICAL_IMAGE}:placeholder` }] } } }
    },
    {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'app-cfg', namespace: 'kooker' },
      data: { DB_HOST: 'localhost' }
    }
  ],
  mutateSecondRender: 'missing_resource',
  expectedExit: 1,
  expectedErr: 'RENDER_UNRELATED_MUTATION',
  expectMutationReached: true
});

// 22. Missing mandatory Kustomize/kubectl tool refused
runConsumerTestCase({
  name: 'missing mandatory kustomize and kubectl tool refused',
  resources: [
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'sportifine-server', namespace: 'kooker' },
      spec: { template: { spec: { containers: [{ name: 'sportifine-server', image: `${CANONICAL_IMAGE}:placeholder` }] } } }
    }
  ],
  fixtureHook: ({ tmpDir }) => {
    // Setup restricted PATH toolbox containing only node/sh/basic utilities (no kustomize, no kubectl)
    const toolboxDir = path.join(tmpDir, 'empty-toolbox');
    fs.mkdirSync(toolboxDir, { recursive: true });
    fs.symlinkSync('/bin/sh', path.join(toolboxDir, 'sh'));
    fs.symlinkSync(process.execPath, path.join(toolboxDir, 'node'));
  },
  envOverride: {
    // Overridden PATH pointing exclusively to restricted toolbox
    PATH: '/bin:/usr/bin'
  },
  expectedExit: 1,
  expectedErr: 'ENOENT',
  expectRendererNotReached: true
});

// 23. Missing mandatory yaml parser in isolated fixture refused
runConsumerTestCase({
  name: 'missing mandatory yaml parser in isolated fixture refused',
  resources: [
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'sportifine-server', namespace: 'kooker' },
      spec: { template: { spec: { containers: [{ name: 'sportifine-server', image: `${CANONICAL_IMAGE}:placeholder` }] } } }
    }
  ],
  fixtureHook: ({ tmpDir }) => {
    // Copy real scripts/update-gitops-digest.mjs and scripts/lib/kustomize-digest.js to isolated fixture with no node_modules
    const fixtureScriptsDir = path.join(tmpDir, 'isolated-scripts');
    const fixtureLibDir = path.join(fixtureScriptsDir, 'lib');
    fs.mkdirSync(fixtureLibDir, { recursive: true });

    const cliContent = fs.readFileSync(UPDATE_CLI_PATH, 'utf8');
    const libContent = fs.readFileSync(path.join(__dirname, '../scripts/lib/kustomize-digest.js'), 'utf8');

    // Assert actual copied bytes match verified shasum
    assert.equal(sha256(Buffer.from(cliContent)), '6023d98bca1f169587523fdb9c112465318906ee62df9e57bd454e8c89860ab1');
    assert.equal(sha256(Buffer.from(libContent)), 'f6556b14bf946cbdf3805fd5944290992428fcb24ebc31dc869783797c8b671c');

    const isolatedCliPath = path.join(fixtureScriptsDir, 'update-gitops-digest.mjs');
    fs.writeFileSync(isolatedCliPath, cliContent, { mode: 0o755 });
    fs.writeFileSync(path.join(fixtureLibDir, 'kustomize-digest.js'), libContent, { mode: 0o644 });

    return { cliPath: isolatedCliPath };
  },
  envOverride: {
    // Force NODE_PATH to an empty non-existent directory
    NODE_PATH: '/tmp/empty-nonexistent-node-modules-dir'
  },
  expectedExit: 1,
  expectedErr: 'Cannot find module',
  expectRendererNotReached: true
});

// 24. Invalid real render input (malformed kustomization YAML) refused
runConsumerTestCase({
  name: 'invalid kustomization yaml render input refused',
  resources: [
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'sportifine-server', namespace: 'kooker' },
      spec: { template: { spec: { containers: [{ name: 'sportifine-server', image: `${CANONICAL_IMAGE}:placeholder` }] } } }
    }
  ],
  fixtureHook: ({ targetDir }) => {
    fs.writeFileSync(path.join(targetDir, 'kustomization.yaml'), ':: unparseable : yaml : syntax\n');
  },
  expectedExit: 1,
  expectedErr: 'Command failed: kustomize build'
});

// 25. Malformed images entry in kustomization (non-array images field) refused
runConsumerTestCase({
  name: 'malformed non-array images field in kustomization refused',
  resources: [
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'sportifine-server', namespace: 'kooker' },
      spec: { template: { spec: { containers: [{ name: 'sportifine-server', image: `${CANONICAL_IMAGE}:placeholder` }] } } }
    }
  ],
  fixtureHook: ({ targetDir }) => {
    const rawKust = `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - resource0.json
images: "not-an-array-string"
`;
    fs.writeFileSync(path.join(targetDir, 'kustomization.yaml'), rawKust);
  },
  expectedExit: 1,
  expectedErr: 'Command failed: kustomize build'
});

// 26. Conflicting newName in existing image entry refused
runConsumerTestCase({
  name: 'conflicting newName in existing image entry refused',
  resources: [
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'sportifine-server', namespace: 'kooker' },
      spec: { template: { spec: { containers: [{ name: 'sportifine-server', image: `${CANONICAL_IMAGE}:placeholder` }] } } }
    }
  ],
  fixtureHook: ({ targetDir }) => {
    const kustObj = {
      apiVersion: 'kustomize.config.k8s.io/v1beta1',
      kind: 'Kustomization',
      resources: ['resource0.json'],
      images: [
        { name: CANONICAL_IMAGE, newName: 'conflicting-registry.io/other-image', digest: 'sha256:' + 'b'.repeat(64) }
      ]
    };
    fs.writeFileSync(path.join(targetDir, 'kustomization.yaml'), JSON.stringify(kustObj, null, 2) + '\n');
  },
  expectedExit: 1,
  expectedErr: 'PRE_RENDER_ZERO_TARGETS'
});

// 27. Canonical explicit kooker positive with unrelated cluster-scoped resources (Namespace & ClusterRole)
runConsumerTestCase({
  name: 'canonical explicit kooker positive with unrelated cluster-scoped resources',
  resources: [
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'sportifine-server', namespace: 'kooker' },
      spec: {
        template: {
          spec: {
            containers: [
              { name: 'sportifine-server', image: `${CANONICAL_IMAGE}:placeholder` },
              { name: 'cache', image: 'nginx:1.25' }
            ]
          }
        }
      }
    },
    {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: 'kooker' }
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRole',
      metadata: { name: 'sportifine-reader' },
      rules: [{ apiGroups: [''], resources: ['pods'], verbs: ['get', 'list'] }]
    }
  ],
  expectedExit: 0
});

// 28. Missing namespace on intended target Deployment refused fail-closed before write
runConsumerTestCase({
  name: 'missing namespace on target Deployment refused before write',
  resources: [
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'sportifine-server' }, // Intentionally missing namespace
      spec: {
        template: {
          spec: {
            containers: [
              { name: 'sportifine-server', image: `${CANONICAL_IMAGE}:placeholder` },
              { name: 'cache', image: 'nginx:1.25' }
            ]
          }
        }
      }
    }
  ],
  expectedExit: 1,
  expectedErr: 'RENDER_INTENDED_NAMESPACE_MISSING'
});

// 29. Wrong namespace on intended target Deployment refused fail-closed before write
runConsumerTestCase({
  name: 'wrong namespace on target Deployment refused before write',
  resources: [
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'sportifine-server', namespace: 'other-namespace' }, // Wrong namespace
      spec: {
        template: {
          spec: {
            containers: [
              { name: 'sportifine-server', image: `${CANONICAL_IMAGE}:placeholder` },
              { name: 'cache', image: 'nginx:1.25' }
            ]
          }
        }
      }
    }
  ],
  expectedExit: 1,
  expectedErr: 'RENDER_INTENDED_NAMESPACE_MISMATCH'
});

// =============================================================================
// SECTION 2B: Consumer Physical Canonical Path & Boundary Regressions
// =============================================================================

function runConsumerPathBoundaryCase({
  name,
  setupFixture,
  expectedExit = 0,
  expectedErr = '',
  expectRealRendererNotReached = false,
  verifyTargetUntouched = null,
  verifyPositiveRender = false
}) {
  const fullName = `Consumer Path Boundary - ${name}`;
  if (!shouldRun(fullName)) {
    skipCount++;
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `consumer-path-boundary-${name.replace(/[^a-zA-Z0-9_-]/g, '_')}-`));
  const kustomizePath = 'manifests/overlays/develop/sportifine-server';
  const binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const renderTraceLog = path.join(tmpDir, 'render_trace.log');
  const rendererWrapperScript = `#!/bin/sh
echo "RENDER_INVOKED:$@" >> "${renderTraceLog}"
exec "${KUSTOMIZE_TOOL.cmd}" "$@"
`;
  fs.writeFileSync(path.join(binDir, path.basename(KUSTOMIZE_TOOL.cmd)), rendererWrapperScript, { mode: 0o755 });

  const fixtureInfo = setupFixture(tmpDir, kustomizePath);
  const infraDir = fixtureInfo.infraDir;

  const snapshotDir = (dir) => {
    const snap = {};
    if (!fs.existsSync(dir)) return snap;
    for (const f of fs.readdirSync(dir, { recursive: true })) {
      const full = path.join(dir, f);
      const lst = fs.lstatSync(full);
      if (lst.isFile()) {
        snap[f] = { type: 'file', sha: sha256(fs.readFileSync(full)), mode: lst.mode & 0o777 };
      } else if (lst.isSymbolicLink()) {
        snap[f] = { type: 'symlink', target: fs.readlinkSync(full) };
      }
    }
    return snap;
  };

  const beforeTargetSnap = fixtureInfo.targetToVerify ? snapshotDir(fixtureInfo.targetToVerify) : null;
  const beforeInfraSnap = snapshotDir(infraDir);

  const digestA = 'sha256:' + 'a'.repeat(64);
  const digestB = 'sha256:' + 'b'.repeat(64);

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    NODE_PATH: path.join(__dirname, 'node_modules'),
    CALLER_REPO: 'duikindiesee/sportifine-server',
    IMAGE_NAME: CANONICAL_IMAGE,
    KUSTOMIZE_PATH: kustomizePath,
    NEW_DIGEST: digestA,
    NEW_TAG: '1.14.0',
    INFRA_DIR: infraDir
  };

  const tStart = process.hrtime.bigint();
  const res = spawnSync(process.execPath, [UPDATE_CLI_PATH], {
    cwd: tmpDir,
    env,
    encoding: 'utf8',
    timeout: 10000
  });
  const tEnd = process.hrtime.bigint();
  const elapsedSec = Number(tEnd - tStart) / 1e9;

  const afterTargetSnap = fixtureInfo.targetToVerify ? snapshotDir(fixtureInfo.targetToVerify) : null;
  const afterInfraSnap = snapshotDir(infraDir);

  const exitPass = (res.status === expectedExit);
  const combinedOut = (res.stdout || '') + '\n' + (res.stderr || '');
  const errPass = expectedErr ? combinedOut.includes(expectedErr) : true;

  const renderTraceExists = fs.existsSync(renderTraceLog);
  const renderTraceContent = renderTraceExists ? fs.readFileSync(renderTraceLog, 'utf8') : '';
  const renderTraceCalls = renderTraceContent ? renderTraceContent.trim().split('\n') : [];
  const rendererNotReachedPass = expectRealRendererNotReached ? (renderTraceCalls.length === 0) : true;

  let targetUntouchedPass = true;
  if (fixtureInfo.targetToVerify && expectedExit !== 0) {
    targetUntouchedPass = (JSON.stringify(beforeTargetSnap) === JSON.stringify(afterTargetSnap));
  }

  let positivePass = true;
  let positiveDetail = '';

  if (verifyPositiveRender && exitPass) {
    try {
      const canonicalTarget = path.join(infraDir, kustomizePath);
      // Verify real Kustomize renders with digestA
      const render1 = spawnSync(KUSTOMIZE_TOOL.cmd, [...KUSTOMIZE_TOOL.args, canonicalTarget], {
        encoding: 'utf8',
        timeout: 10000
      });
      assert.equal(render1.status, 0, `Kustomize build after digest A failed: ${render1.stderr}`);
      const analysis1 = analyzeRender(render1.stdout, CANONICAL_IMAGE);
      const deploymentFound1 = analysis1.docsByKey.has('Deployment/kooker/sportifine-server');
      assert.ok(deploymentFound1, 'Deployment sportifine-server not found in render1');
      assert.equal(analysis1.targetIdentities.length, 1, 'Expected exactly 1 target identity in render1');
      assert.equal(analysis1.targetIdentities[0].image, `${CANONICAL_IMAGE}@${digestA}`);

      // Second pin with distinct digest B
      const envB = {
        ...env,
        NEW_DIGEST: digestB,
        NEW_TAG: '1.15.0'
      };
      const resB = spawnSync(process.execPath, [UPDATE_CLI_PATH], {
        cwd: tmpDir,
        env: envB,
        encoding: 'utf8',
        timeout: 10000
      });
      assert.equal(resB.status, 0, `Second CLI invocation with digest B failed: ${resB.stderr}`);

      const render2 = spawnSync(KUSTOMIZE_TOOL.cmd, [...KUSTOMIZE_TOOL.args, canonicalTarget], {
        encoding: 'utf8',
        timeout: 10000
      });
      assert.equal(render2.status, 0, `Kustomize build after digest B failed: ${render2.stderr}`);
      const analysis2 = analyzeRender(render2.stdout, CANONICAL_IMAGE);
      const deploymentFound2 = analysis2.docsByKey.has('Deployment/kooker/sportifine-server');
      assert.ok(deploymentFound2, 'Deployment sportifine-server not found in render2');
      assert.equal(analysis2.targetIdentities.length, 1, 'Expected exactly 1 target identity in render2');
      assert.equal(analysis2.targetIdentities[0].image, `${CANONICAL_IMAGE}@${digestB}`);
      assert.ok(!render2.stdout.includes(digestA), 'Render2 must not contain digest A');
      assert.ok(!render2.stdout.includes(':1.14.0'), 'Render2 must not contain 1.14.0');
      assert.ok(!render2.stdout.includes(':1.15.0'), 'Render2 must not contain 1.15.0');
    } catch (e) {
      positivePass = false;
      positiveDetail = e.message;
    }
  }

  // Evidence retention if TEST_EVIDENCE_DIR set
  if (process.env.TEST_EVIDENCE_DIR) {
    try {
      const evDir = path.resolve(process.env.TEST_EVIDENCE_DIR);
      fs.mkdirSync(evDir, { recursive: true });
      const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
      const evFile = path.join(evDir, `consumer_path_${safeName}.json`);

      const lexicalTarget = path.join(infraDir, kustomizePath);
      let realTarget = null;
      let targetLstat = null;
      try {
        realTarget = fs.realpathSync(lexicalTarget);
        targetLstat = fs.lstatSync(lexicalTarget);
      } catch (e) {}

      let realInfra = null;
      try {
        realInfra = fs.realpathSync(infraDir);
      } catch (e) {}

      const evidence = {
        name,
        actual_exit: res.status,
        expected_exit: expectedExit,
        elapsed_seconds: elapsedSec,
        lexical_infra_dir: infraDir,
        real_infra_dir: realInfra,
        lexical_target: lexicalTarget,
        real_target: realTarget,
        target_is_symlink: targetLstat ? targetLstat.isSymbolicLink() : false,
        renderer_invocations: renderTraceCalls,
        expect_real_renderer_not_reached: expectRealRendererNotReached,
        real_renderer_not_reached: renderTraceCalls.length === 0,
        target_untouched: targetUntouchedPass,
        before_target_snapshot: beforeTargetSnap,
        after_target_snapshot: afterTargetSnap,
        stdout: res.stdout || '',
        stderr: res.stderr || '',
        assertions: {
          exit_pass: exitPass,
          err_pass: errPass,
          renderer_not_reached_pass: rendererNotReachedPass,
          target_untouched_pass: targetUntouchedPass,
          positive_pass: positivePass
        }
      };
      fs.writeFileSync(evFile, JSON.stringify(evidence, null, 2) + '\n');
    } catch (e) {
      console.error(`Failed to write evidence for ${name}:`, e.message);
    }
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });

  const passed = exitPass && errPass && rendererNotReachedPass && targetUntouchedPass && positivePass;
  report(`Consumer Path Boundary - ${name}`, passed,
    `exit=${res.status} (exp ${expectedExit}), errPass=${errPass}, rendererNotReached=${rendererNotReachedPass}, targetUntouched=${targetUntouchedPass}${positiveDetail ? ', positiveErr=' + positiveDetail : ''}`);
}

// 1. Normal physical canonical positive
runConsumerPathBoundaryCase({
  name: 'normal physical canonical positive',
  setupFixture: (tmpDir, kustomizePath) => {
    const infraDir = path.join(tmpDir, 'infra');
    const targetDir = path.join(infraDir, kustomizePath);
    fs.mkdirSync(targetDir, { recursive: true });

    const deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'sportifine-server', namespace: 'kooker' },
      spec: {
        template: {
          spec: {
            containers: [
              { name: 'sportifine-server', image: `${CANONICAL_IMAGE}:placeholder` }
            ]
          }
        }
      }
    };
    fs.writeFileSync(path.join(targetDir, 'deployment.json'), JSON.stringify(deployment, null, 2) + '\n');

    const kustObj = {
      apiVersion: 'kustomize.config.k8s.io/v1beta1',
      kind: 'Kustomization',
      resources: ['deployment.json']
    };
    fs.writeFileSync(path.join(targetDir, 'kustomization.yaml'), JSON.stringify(kustObj, null, 2) + '\n');

    return {
      infraDir,
      targetToVerify: targetDir
    };
  },
  expectedExit: 0,
  expectedErr: '',
  expectRealRendererNotReached: false,
  verifyPositiveRender: true
});

// 2. Canonical overlay directory symlink OUTSIDE real infra refused
runConsumerPathBoundaryCase({
  name: 'symlink outside infra refused',
  setupFixture: (tmpDir, kustomizePath) => {
    const infraDir = path.join(tmpDir, 'infra');
    const parentDir = path.join(infraDir, path.dirname(kustomizePath));
    fs.mkdirSync(parentDir, { recursive: true });

    const outsideDir = path.join(tmpDir, 'outside-infra-fixture');
    fs.mkdirSync(outsideDir, { recursive: true });

    const deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'sportifine-server', namespace: 'kooker' },
      spec: {
        template: {
          spec: {
            containers: [
              { name: 'sportifine-server', image: `${CANONICAL_IMAGE}:placeholder` }
            ]
          }
        }
      }
    };
    fs.writeFileSync(path.join(outsideDir, 'deployment.json'), JSON.stringify(deployment, null, 2) + '\n');

    const kustObj = {
      apiVersion: 'kustomize.config.k8s.io/v1beta1',
      kind: 'Kustomization',
      resources: ['deployment.json']
    };
    fs.writeFileSync(path.join(outsideDir, 'kustomization.yaml'), JSON.stringify(kustObj, null, 2) + '\n');

    // Create symlink from infra/manifests/overlays/develop/sportifine-server -> outsideDir
    const linkTarget = path.join(infraDir, kustomizePath);
    fs.symlinkSync(outsideDir, linkTarget);

    return {
      infraDir,
      targetToVerify: outsideDir
    };
  },
  expectedExit: 1,
  expectedErr: 'PATH_TRAVERSAL_ERROR',
  expectRealRendererNotReached: true,
  verifyPositiveRender: false
});

// 3. Canonical overlay directory alias OTHER physical overlay INSIDE real infra refused
runConsumerPathBoundaryCase({
  name: 'symlink alias other inside infra refused',
  setupFixture: (tmpDir, kustomizePath) => {
    const infraDir = path.join(tmpDir, 'infra');
    const parentDir = path.join(infraDir, path.dirname(kustomizePath));
    fs.mkdirSync(parentDir, { recursive: true });

    const otherOverlayDir = path.join(infraDir, 'manifests/overlays/develop/other-overlay');
    fs.mkdirSync(otherOverlayDir, { recursive: true });

    const deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'sportifine-server', namespace: 'kooker' },
      spec: {
        template: {
          spec: {
            containers: [
              { name: 'sportifine-server', image: `${CANONICAL_IMAGE}:placeholder` }
            ]
          }
        }
      }
    };
    fs.writeFileSync(path.join(otherOverlayDir, 'deployment.json'), JSON.stringify(deployment, null, 2) + '\n');

    const kustObj = {
      apiVersion: 'kustomize.config.k8s.io/v1beta1',
      kind: 'Kustomization',
      resources: ['deployment.json']
    };
    fs.writeFileSync(path.join(otherOverlayDir, 'kustomization.yaml'), JSON.stringify(kustObj, null, 2) + '\n');

    // Create symlink from infra/manifests/overlays/develop/sportifine-server -> otherOverlayDir
    const linkTarget = path.join(infraDir, kustomizePath);
    fs.symlinkSync(otherOverlayDir, linkTarget);

    return {
      infraDir,
      targetToVerify: otherOverlayDir
    };
  },
  expectedExit: 1,
  expectedErr: 'PATH_TRAVERSAL_ERROR',
  expectRealRendererNotReached: true,
  verifyPositiveRender: false
});

// 4. Kustomization file symlink escaping canonical overlay directory refused
runConsumerPathBoundaryCase({
  name: 'kustomization file symlink escaping directory refused',
  setupFixture: (tmpDir, kustomizePath) => {
    const infraDir = path.join(tmpDir, 'infra');
    const targetDir = path.join(infraDir, kustomizePath);
    fs.mkdirSync(targetDir, { recursive: true });

    const outsideDir = path.join(tmpDir, 'outside-infra-fixture');
    fs.mkdirSync(outsideDir, { recursive: true });

    const deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'sportifine-server', namespace: 'kooker' },
      spec: {
        template: {
          spec: {
            containers: [
              { name: 'sportifine-server', image: `${CANONICAL_IMAGE}:placeholder` }
            ]
          }
        }
      }
    };
    fs.writeFileSync(path.join(targetDir, 'deployment.json'), JSON.stringify(deployment, null, 2) + '\n');

    const kustObj = {
      apiVersion: 'kustomize.config.k8s.io/v1beta1',
      kind: 'Kustomization',
      resources: ['deployment.json']
    };
    const externalKustPath = path.join(outsideDir, 'external-kustomization.yaml');
    fs.writeFileSync(externalKustPath, JSON.stringify(kustObj, null, 2) + '\n');

    // Create symlink kustomization.yaml pointing outside canonical directory
    fs.symlinkSync(externalKustPath, path.join(targetDir, 'kustomization.yaml'));

    return {
      infraDir,
      targetToVerify: outsideDir
    };
  },
  expectedExit: 1,
  expectedErr: 'PATH_TRAVERSAL_ERROR',
  expectRealRendererNotReached: true,
  verifyPositiveRender: false
});

// =============================================================================
// SECTION 3: Workflow Guard Step Controls (Legacy Omitted, CityLife, Approver)
// =============================================================================

const STEP_VALIDATE = stepMap.get('Validate the immutable image reference');
const STEP_HOLD = stepMap.get('Enforce release hold and adoption lock');
const STEP_UPDATE = stepMap.get('Update Kustomize Image');
const STEP_PR = stepMap.get('Open the deploy PR');
const STEP_APPROVER = stepMap.get('Approve and merge as the deploy approver');
const STEP_VALIDATE_HELPER = stepMap.get('Validate shared workflow helper identity');
const STEP_VERIFY_HELPER_HEAD = stepMap.get('Verify checked-out helper source HEAD');

assert.ok(
  STEP_VALIDATE &&
  STEP_HOLD &&
  STEP_UPDATE &&
  STEP_PR &&
  STEP_APPROVER &&
  STEP_VALIDATE_HELPER &&
  STEP_VERIFY_HELPER_HEAD,
  'Guard steps must be present in gitops-sync.yml'
);

function runGuardTestCase({ name, testFn }) {
  const fullName = `Workflow guard - ${name}`;
  if (!shouldRun(fullName)) {
    skipCount++;
    return;
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `guard-test-${name}-`));
  try {
    testFn(tmpDir);
    report(`Workflow guard - ${name}`, true);
  } catch (err) {
    report(`Workflow guard - ${name}`, false, err.message);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// 1. Legacy omitted new_digest triggers mode=tag and updates image tag cleanly
runGuardTestCase({
  name: 'legacy omitted default new_digest triggers mode=tag',
  testFn: (tmpDir) => {
    const targetDir = path.join(tmpDir, 'infra/manifests/overlays/develop/client');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'deployment.yaml'), `apiVersion: apps/v1
kind: Deployment
metadata:
  name: client
spec:
  template:
    spec:
      containers:
        - name: client
          image: ghcr.io/duikindiesee/client:old
`);
    fs.writeFileSync(path.join(targetDir, 'kustomization.yaml'), `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - deployment.yaml
`);

    const env = {
      ...process.env,
      IMAGE_NAME: 'ghcr.io/duikindiesee/client',
      NEW_TAG: '2.0.0',
      NEW_DIGEST: '', // default empty
      CALLER_REPO: 'duikindiesee/client',
      KUSTOMIZE_PATH: 'manifests/overlays/develop/client',
      GITHUB_OUTPUT: path.join(tmpDir, 'output.txt'),
      INFRA_DIR: 'infra'
    };

    // Run Validate step
    const r1 = spawnSync('/bin/bash', ['-c', STEP_VALIDATE], { cwd: tmpDir, env, encoding: 'utf8' });
    assert.equal(r1.status, 0, r1.stderr);
    const outTxt = fs.readFileSync(path.join(tmpDir, 'output.txt'), 'utf8');
    assert.ok(outTxt.includes('mode=tag'), 'Validate step must output mode=tag');

    // Run Hold step
    env.MODE = 'tag';
    const r2 = spawnSync('/bin/bash', ['-c', STEP_HOLD], { cwd: tmpDir, env, encoding: 'utf8' });
    assert.equal(r2.status, 0, r2.stderr);

    // Run Update step
    const r3 = spawnSync('/bin/bash', ['-c', STEP_UPDATE], { cwd: tmpDir, env, encoding: 'utf8' });
    assert.equal(r3.status, 0, r3.stderr);

    // Render with kustomize
    const rendered = spawnSync(KUSTOMIZE_TOOL.cmd, [...KUSTOMIZE_TOOL.args, targetDir], { encoding: 'utf8' });
    assert.equal(rendered.status, 0, rendered.stderr);
    assert.ok(rendered.stdout.includes('ghcr.io/duikindiesee/client:2.0.0'), 'Rendered output must have new tag');
  }
});

// 2. Protected CityLife release hold refuses before any infra change
for (const service of ['citylife', 'citylife-server']) {
  for (const lockmode of ['valid_json', 'malformed', 'absent']) {
    runGuardTestCase({
      name: `CityLife hold refusal (${service}, ${lockmode})`,
      testFn: (tmpDir) => {
        const targetDir = path.join(tmpDir, `infra/manifests/overlays/develop/${service}`);
        fs.mkdirSync(targetDir, { recursive: true });
        fs.writeFileSync(path.join(targetDir, 'deployment.yaml'), `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: ${service}\n`);
        fs.writeFileSync(path.join(targetDir, 'kustomization.yaml'), `apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - deployment.yaml\n`);

        const lockFile = path.join(tmpDir, 'infra/manifests/adoption-locks/citylife-multiplayer.lock');
        fs.mkdirSync(path.dirname(lockFile), { recursive: true });
        if (lockmode === 'valid_json') fs.writeFileSync(lockFile, '{}');
        else if (lockmode === 'malformed') fs.writeFileSync(lockFile, 'not-json');

        const env = {
          ...process.env,
          IMAGE_NAME: `ghcr.io/duikindiesee/${service}`,
          NEW_TAG: '1.0.0',
          NEW_DIGEST: '',
          CALLER_REPO: `duikindiesee/${service}`,
          KUSTOMIZE_PATH: `manifests/overlays/develop/${service}`,
          GITHUB_OUTPUT: path.join(tmpDir, 'output.txt'),
          MODE: 'tag',
          INFRA_DIR: 'infra'
        };

        const r = spawnSync('/bin/bash', ['-c', STEP_HOLD], { cwd: tmpDir, env, encoding: 'utf8' });
        assert.equal(r.status, 1, 'CityLife release hold must exit 1');
        const combined = (r.stdout || '') + '\n' + (r.stderr || '');
        assert.ok(combined.includes('Evaluating fail-closed release hold for protected overlay'), 'Actual protected hold must be reached');
        const reason = lockmode === 'absent' ? 'Missing adoption lock file' : lockmode === 'malformed' ? 'Malformed or unreadable adoption lock file' : 'Release hold active';
        assert.ok(combined.includes(reason) || (lockmode === 'malformed' && combined.includes('Release hold active')), 'Expected classified protected hold refusal');
      }
    });
  }
}

// 3. Approver and merge gate: synthetic token / review states
for (const mode of ['missing_token', 'review_denied', 'merge_blocked']) {
  runGuardTestCase({
    name: `approver gate (${mode})`,
    testFn: (tmpDir) => {
      const binDir = path.join(tmpDir, 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      const ghLog = path.join(tmpDir, 'gh_calls.log');
      const canonicalPath = 'manifests/overlays/develop/sportifine-server';
      const targetDir = path.join(tmpDir, 'infra', canonicalPath);
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, 'synthetic.txt'), 'controlled infra remains unchanged\n');
      const infraBefore = snapshotTree(path.join(tmpDir, 'infra'));
      const prStatePath = path.join(tmpDir, 'synthetic-open-pr.json');
      fs.writeFileSync(prStatePath, JSON.stringify({ state: 'OPEN', merged: false }));
      const prBefore = fs.readFileSync(prStatePath, 'utf8');


      // Scoped fake gh wrapper
      const fakeGh = path.join(binDir, 'gh');
      const ghScript = `#!/bin/sh
echo "$@" >> "${ghLog}"
if [ "$GH_CASE" = "review_denied" ]; then
  exit 1
fi
if [ "$1" = "pr" ] && [ "$2" = "merge" ]; then
  exit 1
fi
exit 0
`;
      fs.writeFileSync(fakeGh, ghScript, { mode: 0o755 });

      const env = {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        GH_TOKEN: (mode === 'missing_token') ? '' : 'synthetic-approver-token',
        GH_CASE: mode,
        KUSTOMIZE_PATH: canonicalPath,
        PR_URL: 'https://example.invalid/org/repo/pull/42'
      };

      const r = spawnSync('/bin/bash', ['-c', STEP_APPROVER], { cwd: tmpDir, env, encoding: 'utf8' });
      assert.equal(r.status, 1, 'Approver step must exit 1 on refusal or merge failure');
      const calls = fs.existsSync(ghLog) ? fs.readFileSync(ghLog, 'utf8').trim().split('\n').filter(Boolean) : [];
      const output = (r.stdout || '') + '\n' + (r.stderr || '');
      assert.equal(calls.length, mode === 'missing_token' ? 0 : mode === 'review_denied' ? 1 : 4, 'Actual scoped fake-gh branch call count');
      if (mode === 'missing_token') assert.ok(output.includes('GITOPS_APPROVER_TOKEN is not set'), 'Must reach actual missing-token refusal');
      else {
        assert.ok(calls[0].startsWith('pr review --approve '), 'Actual approver review must be attempted');
        if (mode === 'merge_blocked') {
          assert.equal(calls.filter(c => c.startsWith('pr merge ')).length, 3);
          assert.ok(output.includes('Could not merge deploy PR after 3 attempts'));
        }
      }
      assert.equal(fs.readFileSync(prStatePath, 'utf8'), prBefore, 'Synthetic PR remains open; no real GitHub access');
      assert.deepEqual(snapshotTree(path.join(tmpDir, 'infra')), infraBefore, 'Approval failure leaves infra bytes and modes unchanged');

    }
  });
}

// 4. Helper identity & checked-out HEAD verification controls
function runHelperIdentityCase({
  name,
  envVars,
  setupCheckout = null,
  stepToRun = 'validate', // 'validate' | 'head'
  expectedExit = 0,
  expectedSubstr = ''
}) {
  const fullName = `Workflow guard - ${name}`;
  if (!shouldRun(fullName)) {
    skipCount++;
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-test-'));
  try {
    const infraDir = path.join(tmpDir, 'infra');
    fs.mkdirSync(infraDir, { recursive: true });
    fs.writeFileSync(path.join(infraDir, 'sentinel.txt'), 'infra unchanged\n', { mode: 0o644 });
    const infraBefore = snapshotTree(infraDir);

    let actualHead = null;
    let gitDirPresent = false;
    if (setupCheckout) {
      const checkoutDir = path.join(tmpDir, '.shared-workflows');
      if (setupCheckout.mode === 'valid_git') {
        fs.mkdirSync(checkoutDir, { recursive: true });
        spawnSync('git', ['init', '-b', 'main'], { cwd: checkoutDir });
        spawnSync('git', ['config', 'user.name', 'Test'], { cwd: checkoutDir });
        spawnSync('git', ['config', 'user.email', 'test@test.local'], { cwd: checkoutDir });
        fs.writeFileSync(path.join(checkoutDir, 'README.md'), 'test helper\n');
        spawnSync('git', ['add', '.'], { cwd: checkoutDir });
        spawnSync('git', ['commit', '-m', 'init'], { cwd: checkoutDir });
        actualHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: checkoutDir, encoding: 'utf8' }).stdout.trim();
        gitDirPresent = true;
      } else if (setupCheckout.mode === 'missing_git') {
        fs.mkdirSync(checkoutDir, { recursive: true });
        fs.writeFileSync(path.join(checkoutDir, 'README.md'), 'test helper without git\n');
        gitDirPresent = false;
      }
    }

    const effectiveEnv = {
      ...process.env,
      ...envVars
    };
    if (envVars && envVars.WORKFLOW_SHA === '__USE_ACTUAL_HEAD__') {
      effectiveEnv.WORKFLOW_SHA = actualHead;
    }
    if (envVars && envVars.EXPECTED_SHA === '__USE_ACTUAL_HEAD__') {
      effectiveEnv.EXPECTED_SHA = actualHead;
    }

    const script = (stepToRun === 'validate') ? STEP_VALIDATE_HELPER : STEP_VERIFY_HELPER_HEAD;
    const t0 = process.hrtime.bigint();
    const res = spawnSync('/bin/bash', ['-c', script], {
      cwd: tmpDir,
      env: effectiveEnv,
      encoding: 'utf8'
    });
    const elapsedSec = Number(process.hrtime.bigint() - t0) / 1e9;

    const exitPass = (res.status === expectedExit);
    const combined = (res.stdout || '') + '\n' + (res.stderr || '');
    const substrPass = expectedSubstr ? combined.includes(expectedSubstr) : true;
    const infraPass = (JSON.stringify(snapshotTree(infraDir)) === JSON.stringify(infraBefore));

    const testPassed = exitPass && substrPass && infraPass;

    if (process.env.TEST_EVIDENCE_DIR) {
      try {
        const evDir = path.resolve(process.env.TEST_EVIDENCE_DIR);
        fs.mkdirSync(evDir, { recursive: true });
        const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
        const evFile = path.join(evDir, `helper_${safeName}.json`);

        const checkoutStepDoc = workflowDoc.jobs.sync.steps.find(s => s.name === 'Checkout shared workflow helper');

        const evidence = {
          name,
          step_to_run: stepToRun,
          step_body_sha256: sha256(Buffer.from(script)),
          actual_exit: res.status,
          expected_exit: expectedExit,
          elapsed_seconds: elapsedSec,
          stdout: res.stdout || '',
          stderr: res.stderr || '',
          actual_head: actualHead,
          requested_ref: effectiveEnv.WORKFLOW_SHA || effectiveEnv.EXPECTED_SHA || null,
          git_dir_present: gitDirPresent,
          checkout_yaml_binding: checkoutStepDoc ? {
            repository: checkoutStepDoc.with.repository,
            ref: checkoutStepDoc.with.ref,
            path: checkoutStepDoc.with.path,
            sparse_checkout: checkoutStepDoc.with['sparse-checkout']
          } : null,
          controlled_infra_unchanged: infraPass,
          assertions: {
            exitPass,
            substrPass,
            infraPass
          },
          passed: testPassed
        };
        fs.writeFileSync(evFile, JSON.stringify(evidence, null, 2) + '\n');
      } catch {}
    }

    report(fullName, testPassed, `exit=${res.status}, substrPass=${substrPass}, infraPass=${infraPass}`);
  } catch (err) {
    report(fullName, false, err.message);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// 4a. Static checkout step YAML declaration assertion
{
  const checkoutStep = workflowDoc.jobs.sync.steps.find(s => s.name === 'Checkout shared workflow helper');
  assert.ok(checkoutStep, 'Checkout shared workflow helper step must exist in workflow');
  assert.equal(checkoutStep.with.repository, '${{ job.workflow_repository }}');
  assert.equal(checkoutStep.with.ref, '${{ job.workflow_sha }}');
  assert.equal(checkoutStep.with.path, '.shared-workflows');
  assert.ok(checkoutStep.with['sparse-checkout'].includes('scripts/lib'));
  assert.ok(checkoutStep.with['sparse-checkout'].includes('scripts/update-gitops-digest.mjs'));
}

// 4b. Step 1: Validate shared workflow helper identity cases
runHelperIdentityCase({
  name: 'helper identity - valid parameters',
  envVars: {
    WORKFLOW_REPO: 'duikindiesee/kooker-workflows',
    WORKFLOW_PATH: '.github/workflows/gitops-sync.yml',
    WORKFLOW_SHA: 'a'.repeat(40)
  },
  stepToRun: 'validate',
  expectedExit: 0,
  expectedSubstr: 'Verified shared workflow identity: duikindiesee/kooker-workflows / .github/workflows/gitops-sync.yml'
});

runHelperIdentityCase({
  name: 'helper identity - wrong repository refused',
  envVars: {
    WORKFLOW_REPO: 'unauthorized/other-workflows',
    WORKFLOW_PATH: '.github/workflows/gitops-sync.yml',
    WORKFLOW_SHA: 'a'.repeat(40)
  },
  stepToRun: 'validate',
  expectedExit: 1,
  expectedSubstr: "Invalid reusable workflow repository: 'unauthorized/other-workflows'"
});

runHelperIdentityCase({
  name: 'helper identity - wrong workflow file path refused',
  envVars: {
    WORKFLOW_REPO: 'duikindiesee/kooker-workflows',
    WORKFLOW_PATH: '.github/workflows/other.yml',
    WORKFLOW_SHA: 'a'.repeat(40)
  },
  stepToRun: 'validate',
  expectedExit: 1,
  expectedSubstr: "Invalid reusable workflow file path: '.github/workflows/other.yml'"
});

runHelperIdentityCase({
  name: 'helper identity - branch name ref refused',
  envVars: {
    WORKFLOW_REPO: 'duikindiesee/kooker-workflows',
    WORKFLOW_PATH: '.github/workflows/gitops-sync.yml',
    WORKFLOW_SHA: 'main'
  },
  stepToRun: 'validate',
  expectedExit: 1,
  expectedSubstr: "Invalid reusable workflow SHA: 'main' (must be 40 lowercase hex characters)"
});

runHelperIdentityCase({
  name: 'helper identity - uppercase SHA refused',
  envVars: {
    WORKFLOW_REPO: 'duikindiesee/kooker-workflows',
    WORKFLOW_PATH: '.github/workflows/gitops-sync.yml',
    WORKFLOW_SHA: 'A'.repeat(40)
  },
  stepToRun: 'validate',
  expectedExit: 1,
  expectedSubstr: 'Invalid reusable workflow SHA'
});

// 4c. Step 2: Verify checked-out helper source HEAD cases
runHelperIdentityCase({
  name: 'helper checkout HEAD - matching SHA verified',
  setupCheckout: { mode: 'valid_git' },
  envVars: {
    EXPECTED_SHA: '__USE_ACTUAL_HEAD__'
  },
  stepToRun: 'head',
  expectedExit: 0,
  expectedSubstr: 'Verified shared workflow helper HEAD matches expected SHA'
});

runHelperIdentityCase({
  name: 'helper checkout HEAD - mismatch refused',
  setupCheckout: { mode: 'valid_git' },
  envVars: {
    EXPECTED_SHA: '0'.repeat(40)
  },
  stepToRun: 'head',
  expectedExit: 1,
  expectedSubstr: 'Shared workflow helper HEAD mismatch'
});

runHelperIdentityCase({
  name: 'helper checkout HEAD - missing .git directory refused',
  setupCheckout: { mode: 'missing_git' },
  envVars: {
    EXPECTED_SHA: '0'.repeat(40)
  },
  stepToRun: 'head',
  expectedExit: 1,
  expectedSubstr: 'Shared workflow helper checkout missing .git directory'
});

// 5. Valid Offline Full Chain Test (Identity -> Emulated Actions Checkout -> HEAD Verify -> Checked-Out CLI -> Kustomize Render)
function runValidHelperOfflineChainCase() {
  const name = 'helper valid offline chain - identity checkout HEAD CLI render';
  const fullName = `Workflow guard - ${name}`;
  if (!shouldRun(fullName)) {
    skipCount++;
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-chain-test-'));
  const t0 = process.hrtime.bigint();
  const trace = [];

  try {
    // 1. Set up private offline Git repository representing duikindiesee/kooker-workflows
    const remoteRepoDir = path.join(tmpDir, 'mock-kooker-workflows');
    fs.mkdirSync(remoteRepoDir, { recursive: true });
    spawnSync('git', ['init', '-b', 'main'], { cwd: remoteRepoDir });
    spawnSync('git', ['config', 'user.name', 'Kooker Bot'], { cwd: remoteRepoDir });
    spawnSync('git', ['config', 'user.email', 'bot@kooker.local'], { cwd: remoteRepoDir });

    // Copy current actual workflow and helper files into private mock repo
    fs.mkdirSync(path.join(remoteRepoDir, '.github/workflows'), { recursive: true });
    fs.copyFileSync(WORKFLOW_PATH, path.join(remoteRepoDir, '.github/workflows/gitops-sync.yml'));
    fs.cpSync(path.join(REPO_ROOT, 'scripts'), path.join(remoteRepoDir, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(remoteRepoDir, 'tests'), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, 'tests/package.json'), path.join(remoteRepoDir, 'tests/package.json'));
    fs.copyFileSync(path.join(REPO_ROOT, 'tests/package-lock.json'), path.join(remoteRepoDir, 'tests/package-lock.json'));

    spawnSync('git', ['add', '.'], { cwd: remoteRepoDir });
    spawnSync('git', ['commit', '-m', 'Add current shared workflow and helper scripts'], { cwd: remoteRepoDir });

    const requestedCommitSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: remoteRepoDir, encoding: 'utf8' }).stdout.trim();
    assert.equal(requestedCommitSha.length, 40, 'Actual mock repo requested commit SHA must be 40 hex characters');

    // Collect helper file hashes from the first (requested) commit
    const helperFiles = [
      '.github/workflows/gitops-sync.yml',
      'scripts/lib/kustomize-digest.js',
      'scripts/update-gitops-digest.mjs',
      'tests/package.json',
      'tests/package-lock.json'
    ];
    const requestedFileHashes = {};
    for (const f of helperFiles) {
      requestedFileHashes[f] = sha256(fs.readFileSync(path.join(remoteRepoDir, f)));
    }

    // Add SECOND decoy commit to private remote repository changing helper content
    // This ensures default branch HEAD != requestedCommitSha, proving explicit ref selection
    fs.appendFileSync(path.join(remoteRepoDir, 'scripts/lib/kustomize-digest.js'), '\n// DECOY_SECOND_COMMIT_MUTATION\n');
    spawnSync('git', ['add', '.'], { cwd: remoteRepoDir });
    spawnSync('git', ['commit', '-m', 'Decoy second commit on default branch'], { cwd: remoteRepoDir });

    const decoyCommitSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: remoteRepoDir, encoding: 'utf8' }).stdout.trim();
    assert.equal(decoyCommitSha.length, 40);
    assert.notEqual(requestedCommitSha, decoyCommitSha, 'Decoy commit SHA must differ from requested commit SHA');

    // 2. Set up synthetic Actions runner workspace
    const runnerWorkspace = path.join(tmpDir, 'runner-workspace');
    fs.mkdirSync(runnerWorkspace, { recursive: true });

    // Set up synthetic target infra repository
    const canonicalPath = 'manifests/overlays/develop/sportifine-server';
    const infraDir = path.join(runnerWorkspace, 'infra', canonicalPath);
    fs.mkdirSync(infraDir, { recursive: true });

    const placeholderDep = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'sportifine-server', namespace: 'kooker' },
      spec: {
        template: {
          spec: {
            containers: [
              { name: 'sportifine-server', image: 'ghcr.io/duikindiesee/sportifine-server:placeholder', env: [{ name: 'ENV', value: 'develop' }] },
              { name: 'cache', image: 'nginx:1.25' }
            ]
          }
        }
      }
    };
    fs.writeFileSync(path.join(infraDir, 'deployment.json'), JSON.stringify(placeholderDep, null, 2) + '\n');
    fs.writeFileSync(path.join(infraDir, 'kustomization.yaml'), JSON.stringify({
      apiVersion: 'kustomize.config.k8s.io/v1beta1',
      kind: 'Kustomization',
      resources: ['deployment.json']
    }, null, 2) + '\n');

    const infraBeforeSnap = snapshotTree(path.join(runnerWorkspace, 'infra'));

    // Step A: Execute actual Validate shared workflow helper identity step
    const valEnv = {
      ...process.env,
      WORKFLOW_REPO: 'duikindiesee/kooker-workflows',
      WORKFLOW_PATH: '.github/workflows/gitops-sync.yml',
      WORKFLOW_SHA: requestedCommitSha
    };
    const r1 = spawnSync('/bin/bash', ['-c', STEP_VALIDATE_HELPER], {
      cwd: runnerWorkspace,
      env: valEnv,
      encoding: 'utf8'
    });
    trace.push({ stage: '1_validate_identity', exit: r1.status, stdout: r1.stdout.trim(), stderr: r1.stderr.trim() });
    assert.equal(r1.status, 0, `Validate step failed: ${r1.stderr}`);
    assert.ok(r1.stdout.includes('Verified shared workflow identity'), 'Validate output missing success confirmation');

    // Step B: Emulated Actions checkout boundary
    // 1) Local git clone without shallow restriction
    const checkoutTarget = path.join(runnerWorkspace, '.shared-workflows');
    const r2Clone = spawnSync('git', ['clone', remoteRepoDir, checkoutTarget], { encoding: 'utf8' });
    assert.equal(r2Clone.status, 0, `Clone failed: ${r2Clone.stderr}`);
    const cloneInitialHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: checkoutTarget, encoding: 'utf8' }).stdout.trim();
    assert.equal(cloneInitialHead, decoyCommitSha, 'Clone without ref selection initially points to decoy default branch HEAD');

    // 2) Explicit actions/checkout ref checkout: git checkout --detach <requestedCommitSha>
    const checkoutArgv = ['checkout', '--detach', requestedCommitSha];
    const r2Checkout = spawnSync('git', checkoutArgv, { cwd: checkoutTarget, encoding: 'utf8' });
    assert.equal(r2Checkout.status, 0, `Checkout of requested SHA failed: ${r2Checkout.stderr}`);
    const finalCheckedOutHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: checkoutTarget, encoding: 'utf8' }).stdout.trim();

    assert.equal(finalCheckedOutHead, requestedCommitSha, 'Final checked out HEAD must exactly equal requested SHA');
    assert.notEqual(finalCheckedOutHead, decoyCommitSha, 'Final checked out HEAD must not be decoy commit');

    trace.push({
      stage: '2_emulated_actions_checkout',
      requested_ref: requestedCommitSha,
      clone_initial_head: cloneInitialHead,
      decoy_head: decoyCommitSha,
      checkout_argv: ['git', ...checkoutArgv],
      checkout_exit: r2Checkout.status,
      final_head: finalCheckedOutHead,
      destination: '.shared-workflows'
    });

    // Verify checked-out helper file hashes strictly equal requested commit file hashes
    for (const f of helperFiles) {
      const checkedOutHash = sha256(fs.readFileSync(path.join(checkoutTarget, f)));
      assert.equal(checkedOutHash, requestedFileHashes[f], `File ${f} hash mismatch after checkout of requested ref`);
    }

    // Symlink tests/node_modules into .shared-workflows/tests so npm ci is satisfied offline
    fs.symlinkSync(path.join(REPO_ROOT, 'tests/node_modules'), path.join(checkoutTarget, 'tests/node_modules'));

    // Step C: Execute actual Verify checked-out helper source HEAD step
    const headEnv = {
      ...process.env,
      EXPECTED_SHA: requestedCommitSha
    };
    const r3 = spawnSync('/bin/bash', ['-c', STEP_VERIFY_HELPER_HEAD], {
      cwd: runnerWorkspace,
      env: headEnv,
      encoding: 'utf8'
    });
    trace.push({ stage: '3_verify_helper_head', exit: r3.status, stdout: r3.stdout.trim(), stderr: r3.stderr.trim() });
    assert.equal(r3.status, 0, `Verify HEAD step failed: ${r3.stderr}`);
    assert.ok(r3.stdout.includes('Verified shared workflow helper HEAD matches expected SHA'), 'HEAD verify output missing confirmation');

    // Step D: Execute ACTUAL checked-out scripts/update-gitops-digest.mjs
    const targetDigest = 'sha256:' + 'a'.repeat(64);
    const cliEnv = {
      ...process.env,
      NODE_PATH: path.join(checkoutTarget, 'tests/node_modules'),
      CALLER_REPO: 'duikindiesee/sportifine-server',
      IMAGE_NAME: 'ghcr.io/duikindiesee/sportifine-server',
      KUSTOMIZE_PATH: canonicalPath,
      NEW_DIGEST: targetDigest,
      NEW_TAG: '1.14.0',
      INFRA_DIR: path.join(runnerWorkspace, 'infra')
    };
    const r4 = spawnSync(process.execPath, [path.join(checkoutTarget, 'scripts/update-gitops-digest.mjs')], {
      cwd: runnerWorkspace,
      env: cliEnv,
      encoding: 'utf8'
    });
    trace.push({ stage: '4_execute_checked_out_cli', exit: r4.status, stdout: r4.stdout.trim(), stderr: r4.stderr.trim() });
    assert.equal(r4.status, 0, `Checked-out CLI execution failed: ${r4.stderr}`);

    // Step E: Real Kustomize render and verify target digest and unrelated semantics
    const renderRes = spawnSync(KUSTOMIZE_TOOL.cmd, [...KUSTOMIZE_TOOL.args, infraDir], { encoding: 'utf8' });
    trace.push({ stage: '5_kustomize_render', exit: renderRes.status, stdout_length: (renderRes.stdout || '').length });
    assert.equal(renderRes.status, 0, `Kustomize build failed: ${renderRes.stderr}`);

    const renderedYaml = renderRes.stdout;
    assert.ok(renderedYaml.includes(`ghcr.io/duikindiesee/sportifine-server@${targetDigest}`), 'Rendered output must have target digest');
    assert.ok(renderedYaml.includes('nginx:1.25'), 'Rendered output must preserve sidecar image nginx:1.25');
    assert.ok(renderedYaml.includes('ENV'), 'Rendered output must preserve container env');

    const elapsedSec = Number(process.hrtime.bigint() - t0) / 1e9;

    // Retain evidence if TEST_EVIDENCE_DIR set
    if (process.env.TEST_EVIDENCE_DIR) {
      try {
        const evDir = path.resolve(process.env.TEST_EVIDENCE_DIR);
        fs.mkdirSync(evDir, { recursive: true });
        const evFile = path.join(evDir, 'helper_valid_offline_chain.json');
        const evidence = {
          name,
          requested_commit_sha: requestedCommitSha,
          decoy_commit_sha: decoyCommitSha,
          clone_initial_head: cloneInitialHead,
          final_checked_out_head: finalCheckedOutHead,
          helper_file_hashes: requestedFileHashes,
          step_bodies_sha256: {
            validate: sha256(Buffer.from(STEP_VALIDATE_HELPER)),
            verify_head: sha256(Buffer.from(STEP_VERIFY_HELPER_HEAD))
          },
          ordered_trace: trace,
          target_digest: targetDigest,
          elapsed_seconds: elapsedSec,
          passed: true
        };
        fs.writeFileSync(evFile, JSON.stringify(evidence, null, 2) + '\n');
      } catch {}
    }

    report(fullName, true, `elapsed=${elapsedSec.toFixed(2)}s`);
  } catch (err) {
    report(fullName, false, err.message);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

runValidHelperOfflineChainCase();

// 6. Connected Fail-Stop Helper Negative Controls (Gated Execution & Invariant Checks)
function runConnectedHelperNegativeChainCase({
  name,
  envOverride = {},
  checkoutFault = null, // 'missing_git' | 'mismatched_head' | null
  expectedFailureStage, // '1_validate_identity' | '3_verify_helper_head'
  expectedDiagnosticSubstr
}) {
  const fullName = `Workflow guard - helper failstop - ${name}`;
  if (!shouldRun(fullName)) {
    skipCount++;
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-neg-chain-'));
  const t0 = process.hrtime.bigint();
  const trace = [];

  try {
    // 1. Private mock git repository setup
    const remoteRepoDir = path.join(tmpDir, 'mock-kooker-workflows');
    fs.mkdirSync(remoteRepoDir, { recursive: true });
    spawnSync('git', ['init', '-b', 'main'], { cwd: remoteRepoDir });
    spawnSync('git', ['config', 'user.name', 'Kooker Bot'], { cwd: remoteRepoDir });
    spawnSync('git', ['config', 'user.email', 'bot@kooker.local'], { cwd: remoteRepoDir });

    fs.mkdirSync(path.join(remoteRepoDir, '.github/workflows'), { recursive: true });
    fs.copyFileSync(WORKFLOW_PATH, path.join(remoteRepoDir, '.github/workflows/gitops-sync.yml'));
    fs.cpSync(path.join(REPO_ROOT, 'scripts'), path.join(remoteRepoDir, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(remoteRepoDir, 'tests'), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, 'tests/package.json'), path.join(remoteRepoDir, 'tests/package.json'));
    fs.copyFileSync(path.join(REPO_ROOT, 'tests/package-lock.json'), path.join(remoteRepoDir, 'tests/package-lock.json'));

    spawnSync('git', ['add', '.'], { cwd: remoteRepoDir });
    spawnSync('git', ['commit', '-m', 'Init commit'], { cwd: remoteRepoDir });

    const actualValidCommitSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: remoteRepoDir, encoding: 'utf8' }).stdout.trim();

    // 2. Synthetic runner workspace & target infra
    const runnerWorkspace = path.join(tmpDir, 'runner-workspace');
    fs.mkdirSync(runnerWorkspace, { recursive: true });
    const canonicalPath = 'manifests/overlays/develop/sportifine-server';
    const infraDir = path.join(runnerWorkspace, 'infra', canonicalPath);
    fs.mkdirSync(infraDir, { recursive: true });

    const placeholderDep = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'sportifine-server', namespace: 'kooker' },
      spec: {
        template: {
          spec: {
            containers: [
              { name: 'sportifine-server', image: 'ghcr.io/duikindiesee/sportifine-server:placeholder', env: [{ name: 'ENV', value: 'develop' }] },
              { name: 'cache', image: 'nginx:1.25' }
            ]
          }
        }
      }
    };
    fs.writeFileSync(path.join(infraDir, 'deployment.json'), JSON.stringify(placeholderDep, null, 2) + '\n');
    fs.writeFileSync(path.join(infraDir, 'kustomization.yaml'), JSON.stringify({
      apiVersion: 'kustomize.config.k8s.io/v1beta1',
      kind: 'Kustomization',
      resources: ['deployment.json']
    }, null, 2) + '\n');

    const infraBeforeSnap = snapshotTree(path.join(runnerWorkspace, 'infra'));

    // Step A: Determine effective environment for validation step
    // Missing job identity env vars are explicitly EMPTY strings, never inherited host values
    const valEnv = {
      ...process.env,
      WORKFLOW_REPO: (envOverride.WORKFLOW_REPO !== undefined) ? envOverride.WORKFLOW_REPO : 'duikindiesee/kooker-workflows',
      WORKFLOW_PATH: (envOverride.WORKFLOW_PATH !== undefined) ? envOverride.WORKFLOW_PATH : '.github/workflows/gitops-sync.yml',
      WORKFLOW_SHA: (envOverride.WORKFLOW_SHA !== undefined) ? envOverride.WORKFLOW_SHA : actualValidCommitSha
    };

    const r1 = spawnSync('/bin/bash', ['-c', STEP_VALIDATE_HELPER], {
      cwd: runnerWorkspace,
      env: valEnv,
      encoding: 'utf8'
    });
    trace.push({
      stage: '1_validate_identity',
      exit: r1.status,
      stdout: r1.stdout.trim(),
      stderr: r1.stderr.trim()
    });

    let actualHeadAfterCheckout = null;
    let lateWriteProbeReached = false;
    let actualFailureStage = null;
    let actualFailureDiagnostic = null;

    if (r1.status !== 0) {
      actualFailureStage = '1_validate_identity';
      actualFailureDiagnostic = (r1.stdout || '') + '\n' + (r1.stderr || '');
    } else {
      // Step B: Emulated Actions checkout boundary
      const checkoutTarget = path.join(runnerWorkspace, '.shared-workflows');
      if (checkoutFault === 'missing_git') {
        fs.mkdirSync(checkoutTarget, { recursive: true });
        fs.writeFileSync(path.join(checkoutTarget, 'README.md'), 'dummy checkout without git\n');
        trace.push({ stage: '2_emulated_actions_checkout', mode: 'missing_git' });
      } else {
        const rClone = spawnSync('git', ['clone', remoteRepoDir, checkoutTarget], { encoding: 'utf8' });
        assert.equal(rClone.status, 0, `Clone failed: ${rClone.stderr}`);
        if (checkoutFault === 'mismatched_head') {
          // Checkout a separate commit so HEAD differs from expected
          fs.writeFileSync(path.join(remoteRepoDir, 'extra.txt'), 'extra commit\n');
          spawnSync('git', ['add', '.'], { cwd: remoteRepoDir });
          spawnSync('git', ['commit', '-m', 'Extra commit'], { cwd: remoteRepoDir });
          const extraSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: remoteRepoDir, encoding: 'utf8' }).stdout.trim();
          spawnSync('git', ['fetch', 'origin'], { cwd: checkoutTarget });
          spawnSync('git', ['checkout', '--detach', extraSha], { cwd: checkoutTarget });
          actualHeadAfterCheckout = extraSha;
        } else {
          actualHeadAfterCheckout = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: checkoutTarget, encoding: 'utf8' }).stdout.trim();
        }
        trace.push({ stage: '2_emulated_actions_checkout', actual_head: actualHeadAfterCheckout });
      }

      // Symlink tests/node_modules into .shared-workflows/tests so npm ci is satisfied offline
      try {
        fs.symlinkSync(path.join(REPO_ROOT, 'tests/node_modules'), path.join(checkoutTarget, 'tests/node_modules'));
      } catch {}

      // Step C: Execute actual Verify checked-out helper source HEAD step
      const headEnv = {
        ...process.env,
        EXPECTED_SHA: actualValidCommitSha
      };
      const r3 = spawnSync('/bin/bash', ['-c', STEP_VERIFY_HELPER_HEAD], {
        cwd: runnerWorkspace,
        env: headEnv,
        encoding: 'utf8'
      });
      trace.push({
        stage: '3_verify_helper_head',
        exit: r3.status,
        stdout: r3.stdout.trim(),
        stderr: r3.stderr.trim()
      });

      if (r3.status !== 0) {
        actualFailureStage = '3_verify_helper_head';
        actualFailureDiagnostic = (r3.stdout || '') + '\n' + (r3.stderr || '');
      } else {
        // Step D: Execute ACTUAL checked-out scripts/update-gitops-digest.mjs
        const targetDigest = 'sha256:' + 'a'.repeat(64);
        const cliEnv = {
          ...process.env,
          NODE_PATH: path.join(checkoutTarget, 'tests/node_modules'),
          CALLER_REPO: 'duikindiesee/sportifine-server',
          IMAGE_NAME: 'ghcr.io/duikindiesee/sportifine-server',
          KUSTOMIZE_PATH: canonicalPath,
          NEW_DIGEST: targetDigest,
          NEW_TAG: '1.14.0',
          INFRA_DIR: path.join(runnerWorkspace, 'infra')
        };
        const r4 = spawnSync(process.execPath, [path.join(checkoutTarget, 'scripts/update-gitops-digest.mjs')], {
          cwd: runnerWorkspace,
          env: cliEnv,
          encoding: 'utf8'
        });
        trace.push({
          stage: '4_execute_checked_out_cli',
          exit: r4.status,
          stdout: r4.stdout.trim(),
          stderr: r4.stderr.trim()
        });
        assert.equal(r4.status, 0, `Downstream CLI execution failed: ${r4.stderr}`);

        // Step E: Real Kustomize render
        const renderRes = spawnSync(KUSTOMIZE_TOOL.cmd, [...KUSTOMIZE_TOOL.args, infraDir], { encoding: 'utf8' });
        trace.push({
          stage: '5_kustomize_render',
          exit: renderRes.status,
          stdout_length: (renderRes.stdout || '').length
        });
        assert.equal(renderRes.status, 0, `Kustomize build failed: ${renderRes.stderr}`);
        const renderedYaml = renderRes.stdout;
        assert.ok(renderedYaml.includes(`ghcr.io/duikindiesee/sportifine-server@${targetDigest}`), 'Rendered output missing target digest');

        // Step F: Synthetic local late write probe marker (NOT real GitHub/PR action)
        const lateProbeFile = path.join(runnerWorkspace, 'synthetic-late-write-probe.marker');
        fs.writeFileSync(lateProbeFile, 'synthetic PR gate boundary reached\n');
        lateWriteProbeReached = fs.existsSync(lateProbeFile);
        trace.push({
          stage: '6_synthetic_late_write_probe',
          reached: lateWriteProbeReached,
          marker_file: 'synthetic-late-write-probe.marker'
        });
      }
    }

    // Derive actual execution booleans from real trace
    const cliReached = trace.some(t => t.stage === '4_execute_checked_out_cli');
    const renderReached = trace.some(t => t.stage === '5_kustomize_render');
    const lateProbeReached = trace.some(t => t.stage === '6_synthetic_late_write_probe');

    // Invariant: Controlled infra byte/mode equality check
    const infraAfterSnap = snapshotTree(path.join(runnerWorkspace, 'infra'));
    const infraUnchanged = (JSON.stringify(infraBeforeSnap) === JSON.stringify(infraAfterSnap));

    // Assertions based on case expectation
    if (expectedFailureStage === null) {
      // Neutral baseline case: must succeed completely through late probe with mutated infra
      assert.equal(actualFailureStage, null, `Baseline unexpectedly failed at stage: ${actualFailureStage}`);
      assert.ok(cliReached, 'Baseline must reach stage 4_execute_checked_out_cli');
      assert.ok(renderReached, 'Baseline must reach stage 5_kustomize_render');
      assert.ok(lateProbeReached, 'Baseline must reach stage 6_synthetic_late_write_probe');
      assert.equal(infraUnchanged, false, 'Baseline infra must be updated with target digest');
    } else {
      // Fault case: must fail at exact expectedFailureStage with exact expected diagnostic
      assert.equal(actualFailureStage, expectedFailureStage, `Expected failure at '${expectedFailureStage}', but actually stopped at '${actualFailureStage}'`);
      assert.ok(actualFailureDiagnostic && actualFailureDiagnostic.includes(expectedDiagnosticSubstr), `Expected diagnostic '${expectedDiagnosticSubstr}' not found in: ${actualFailureDiagnostic}`);
      assert.equal(cliReached, false, 'Downstream CLI execution must NOT be reached on fault');
      assert.equal(renderReached, false, 'Downstream Kustomize render must NOT be reached on fault');
      assert.equal(lateProbeReached, false, 'Late write probe must NOT be reached on fault');
      assert.equal(infraUnchanged, true, 'Controlled infra must remain strictly UNCHANGED on fault');
    }

    const elapsedSec = Number(process.hrtime.bigint() - t0) / 1e9;

    // Retain evidence if TEST_EVIDENCE_DIR set
    if (process.env.TEST_EVIDENCE_DIR) {
      try {
        const evDir = path.resolve(process.env.TEST_EVIDENCE_DIR);
        fs.mkdirSync(evDir, { recursive: true });
        const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
        const evFile = path.join(evDir, `helper_failstop_${safeName}.json`);
        const evidence = {
          name,
          expected_failure_stage: expectedFailureStage,
          actual_failure_stage: actualFailureStage,
          expected_diagnostic_substr: expectedDiagnosticSubstr,
          actual_failure_diagnostic: actualFailureDiagnostic ? actualFailureDiagnostic.trim() : null,
          attempted_trace: trace,
          requested_sha: valEnv.WORKFLOW_SHA,
          actual_head: actualHeadAfterCheckout,
          step_bodies_sha256: {
            validate: sha256(Buffer.from(STEP_VALIDATE_HELPER)),
            verify_head: sha256(Buffer.from(STEP_VERIFY_HELPER_HEAD))
          },
          derived_stages_reached: {
            cli_reached: cliReached,
            render_reached: renderReached,
            late_write_probe_reached: lateProbeReached
          },
          controlled_infra_unchanged: infraUnchanged,
          elapsed_seconds: elapsedSec,
          passed: true
        };
        fs.writeFileSync(evFile, JSON.stringify(evidence, null, 2) + '\n');
      } catch {}
    }

    report(fullName, true, `actualStage=${actualFailureStage || 'SUCCESS'}, cliReached=${cliReached}, infraUnchanged=${infraUnchanged}, elapsed=${elapsedSec.toFixed(2)}s`);
  } catch (err) {
    report(fullName, false, err.message);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Register 1 neutral valid baseline + 9 connected fail-stop cases:
// 0. Neutral valid baseline through SAME executor
runConnectedHelperNegativeChainCase({
  name: 'neutral valid baseline succeeds through late probe',
  envOverride: {},
  checkoutFault: null,
  expectedFailureStage: null,
  expectedDiagnosticSubstr: ''
});

// 1. Empty repository
runConnectedHelperNegativeChainCase({
  name: 'empty repository refused',
  envOverride: { WORKFLOW_REPO: '' },
  expectedFailureStage: '1_validate_identity',
  expectedDiagnosticSubstr: "Invalid reusable workflow repository: ''"
});

// 2. Empty workflow file path
runConnectedHelperNegativeChainCase({
  name: 'empty workflow path refused',
  envOverride: { WORKFLOW_PATH: '' },
  expectedFailureStage: '1_validate_identity',
  expectedDiagnosticSubstr: "Invalid reusable workflow file path: ''"
});

// 3. Empty workflow SHA
runConnectedHelperNegativeChainCase({
  name: 'empty workflow SHA refused',
  envOverride: { WORKFLOW_SHA: '' },
  expectedFailureStage: '1_validate_identity',
  expectedDiagnosticSubstr: "Invalid reusable workflow SHA: ''"
});

// 4. Malformed short SHA (e.g. 7 hex characters)
runConnectedHelperNegativeChainCase({
  name: 'malformed short SHA refused',
  envOverride: { WORKFLOW_SHA: 'a1b2c3d' },
  expectedFailureStage: '1_validate_identity',
  expectedDiagnosticSubstr: "Invalid reusable workflow SHA: 'a1b2c3d' (must be 40 lowercase hex characters)"
});

// 5. Wrong workflow repository
runConnectedHelperNegativeChainCase({
  name: 'wrong repository refused',
  envOverride: { WORKFLOW_REPO: 'unauthorized/caller-repo' },
  expectedFailureStage: '1_validate_identity',
  expectedDiagnosticSubstr: "Invalid reusable workflow repository: 'unauthorized/caller-repo'"
});

// 6. Wrong workflow file path
runConnectedHelperNegativeChainCase({
  name: 'wrong workflow path refused',
  envOverride: { WORKFLOW_PATH: '.github/workflows/other.yml' },
  expectedFailureStage: '1_validate_identity',
  expectedDiagnosticSubstr: "Invalid reusable workflow file path: '.github/workflows/other.yml'"
});

// 7. Uppercase SHA refused
runConnectedHelperNegativeChainCase({
  name: 'uppercase SHA refused',
  envOverride: { WORKFLOW_SHA: 'A'.repeat(40) },
  expectedFailureStage: '1_validate_identity',
  expectedDiagnosticSubstr: 'Invalid reusable workflow SHA'
});

// 8. Missing checkout .git directory
runConnectedHelperNegativeChainCase({
  name: 'missing checkout git directory refused',
  checkoutFault: 'missing_git',
  expectedFailureStage: '3_verify_helper_head',
  expectedDiagnosticSubstr: 'Shared workflow helper checkout missing .git directory'
});

// 9. Mismatched actual checkout HEAD
runConnectedHelperNegativeChainCase({
  name: 'mismatched actual checkout HEAD refused',
  checkoutFault: 'mismatched_head',
  expectedFailureStage: '3_verify_helper_head',
  expectedDiagnosticSubstr: 'Shared workflow helper HEAD mismatch'
});

// =============================================================================
// SECTION 4: Controlled Workflow Body Chain Execution & PR Write-Trace Tests
// =============================================================================

function runControlledWorkflowChainCase({
  name,
  chainFault = null, // null | 'legacy_omitted_digest' | 'empty_digest_tag_mode' | 'citylife_hold' | 'citylife_hold_malformed' | 'citylife_hold_valid' | 'approver_token_missing' | 'review_denied' | 'merge_blocked' | 'registry_nonzero_exit' | 'registry_malformed_json'
  expectedFailureStage = null, // null | '1_validate_image' | '2_prove_image_registry' | '3_hold_gate' | '7_open_pr' | '8_approve_and_merge'
  expectedDiagnosticSubstr = ''
}) {
  const fullName = `Workflow chain - ${name}`;
  if (!shouldRun(fullName)) {
    skipCount++;
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-chain-'));
  const t0 = process.hrtime.bigint();
  const trace = [];
  const githubOutput = path.join(tmpDir, 'github_output.txt');
  fs.writeFileSync(githubOutput, '');

  try {
    // 1. Synthetic local git repository representing kooker-workflows helper repo
    const remoteHelperDir = path.join(tmpDir, 'mock-kooker-workflows');
    fs.mkdirSync(remoteHelperDir, { recursive: true });
    spawnSync('git', ['init', '-b', 'main'], { cwd: remoteHelperDir });
    spawnSync('git', ['config', 'user.name', 'Kooker Bot'], { cwd: remoteHelperDir });
    spawnSync('git', ['config', 'user.email', 'bot@kooker.local'], { cwd: remoteHelperDir });
    fs.mkdirSync(path.join(remoteHelperDir, '.github/workflows'), { recursive: true });
    fs.copyFileSync(WORKFLOW_PATH, path.join(remoteHelperDir, '.github/workflows/gitops-sync.yml'));
    fs.cpSync(path.join(REPO_ROOT, 'scripts'), path.join(remoteHelperDir, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(remoteHelperDir, 'tests'), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, 'tests/package.json'), path.join(remoteHelperDir, 'tests/package.json'));
    fs.copyFileSync(path.join(REPO_ROOT, 'tests/package-lock.json'), path.join(remoteHelperDir, 'tests/package-lock.json'));
    spawnSync('git', ['add', '.'], { cwd: remoteHelperDir });
    spawnSync('git', ['commit', '-m', 'Init helper repo'], { cwd: remoteHelperDir });
    const actualValidCommitSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: remoteHelperDir, encoding: 'utf8' }).stdout.trim();

    // 2. Synthetic local bare git repository representing origin for kooker-infra
    const infraOriginDir = path.join(tmpDir, 'mock-kooker-infra.git');
    spawnSync('git', ['init', '--bare', '-b', 'main', infraOriginDir]);

    // 3. Runner workspace
    const runnerWorkspace = path.join(tmpDir, 'runner-workspace');
    fs.mkdirSync(runnerWorkspace, { recursive: true });

    // Clone bare origin into runnerWorkspace/infra
    const infraDir = path.join(runnerWorkspace, 'infra');
    const rCloneInfra = spawnSync('git', ['clone', infraOriginDir, infraDir]);
    assert.equal(rCloneInfra.status, 0, `Infra clone failed: ${rCloneInfra.stderr}`);
    spawnSync('git', ['config', 'user.name', 'Kooker Infra Bot'], { cwd: infraDir });
    spawnSync('git', ['config', 'user.email', 'infra-bot@kooker.local'], { cwd: infraDir });

    const isCityLifeFault = (chainFault === 'citylife_hold' || chainFault === 'citylife_hold_malformed' || chainFault === 'citylife_hold_valid');
    const isTagMode = (chainFault === 'legacy_omitted_digest' || chainFault === 'empty_digest_tag_mode' || isCityLifeFault);

    const canonicalPath = isCityLifeFault
      ? 'manifests/overlays/develop/citylife'
      : 'manifests/overlays/develop/sportifine-server';
    const targetDir = path.join(infraDir, canonicalPath);
    fs.mkdirSync(targetDir, { recursive: true });

    const placeholderDep = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: isCityLifeFault ? 'citylife' : 'sportifine-server',
        namespace: 'kooker'
      },
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: isCityLifeFault ? 'citylife' : 'sportifine-server',
                image: isCityLifeFault
                  ? 'ghcr.io/duikindiesee/citylife:placeholder'
                  : 'ghcr.io/duikindiesee/sportifine-server:placeholder',
                env: [{ name: 'ENV', value: 'develop' }]
              },
              { name: 'cache', image: 'nginx:1.25' }
            ]
          }
        }
      }
    };
    fs.writeFileSync(path.join(targetDir, 'deployment.json'), JSON.stringify(placeholderDep, null, 2) + '\n');
    fs.writeFileSync(path.join(targetDir, 'kustomization.yaml'), JSON.stringify({
      apiVersion: 'kustomize.config.k8s.io/v1beta1',
      kind: 'Kustomization',
      resources: ['deployment.json']
    }, null, 2) + '\n');

    // CityLife adoption lock variants
    if (chainFault === 'citylife_hold_malformed') {
      const lockFile = path.join(infraDir, 'manifests/adoption-locks/citylife-multiplayer.lock');
      fs.mkdirSync(path.dirname(lockFile), { recursive: true });
      fs.writeFileSync(lockFile, 'not-valid-json\n');
    } else if (chainFault === 'citylife_hold_valid') {
      const lockFile = path.join(infraDir, 'manifests/adoption-locks/citylife-multiplayer.lock');
      fs.mkdirSync(path.dirname(lockFile), { recursive: true });
      fs.writeFileSync(lockFile, JSON.stringify({ schemaVersion: 1, active: true }, null, 2) + '\n');
    }

    spawnSync('git', ['add', '.'], { cwd: infraDir });
    spawnSync('git', ['commit', '-m', 'Initial infra layout'], { cwd: infraDir });
    spawnSync('git', ['push', 'origin', 'main'], { cwd: infraDir });

    const infraBeforeSnap = snapshotTree(infraDir);

    // 4. Synthetic bin tools directory for scoped fake gh / docker and strict local git wrapper
    const binDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const ghLog = path.join(tmpDir, 'gh_calls.log');
    const dockerLog = path.join(tmpDir, 'docker_calls.log');
    const dockerNulLog = path.join(tmpDir, 'docker_raw.log');
    const gitLog = path.join(tmpDir, 'git_calls.log');

    // Strict local git wrapper allowlisting actual needed commands
    const realGitPath = resolveExecutable('git') || '/usr/bin/git';
    const fakeGitScript = `#!/bin/sh
# Disallow -c or -C overrides
for arg in "$@"; do
  case "$arg" in
    -c|-C|--git-dir*|--work-tree*)
      echo "FAIL_CLOSED: git flag '$arg' forbidden in strict local wrapper" >&2
      exit 128
      ;;
    http://*|https://*|ssh://*|git@*|ftp://*|ftps://*)
      echo "FAIL_CLOSED: Non-local git remote or URL blocked: $arg" >&2
      exit 128
      ;;
  esac
done

# Verify cwd is inside owned tmpDir
PHYSICAL_PWD="$(pwd -P)"
case "$PHYSICAL_PWD" in
  "${tmpDir}"*|"/private${tmpDir}"*)
    ;;
  *)
    echo "FAIL_CLOSED: git invoked outside owned fixture workspace: $PHYSICAL_PWD" >&2
    exit 128
    ;;
esac

# Allowlist supported command patterns
CMD="$1"
case "$CMD" in
  diff)
    if [ "$#" -ne 2 ] || [ "$2" != "--quiet" ]; then
      echo "FAIL_CLOSED: Disallowed git diff invocation: $*" >&2
      exit 128
    fi
    ;;
  config)
    if [ "$#" -ne 3 ] || { [ "$2" != "user.name" ] && [ "$2" != "user.email" ]; }; then
      echo "FAIL_CLOSED: Disallowed git config invocation: $*" >&2
      exit 128
    fi
    ;;
  checkout)
    if [ "$#" -ne 3 ] || [ "$2" != "-b" ]; then
      echo "FAIL_CLOSED: Disallowed git checkout invocation: $*" >&2
      exit 128
    fi
    ;;
  add)
    if [ "$#" -ne 2 ] || [ "$2" != "." ]; then
      echo "FAIL_CLOSED: Disallowed git add invocation: $*" >&2
      exit 128
    fi
    ;;
  commit)
    if [ "$#" -ne 3 ] || [ "$2" != "-m" ]; then
      echo "FAIL_CLOSED: Disallowed git commit invocation: $*" >&2
      exit 128
    fi
    ;;
  push)
    if [ "$#" -ne 3 ] || [ "$2" != "origin" ]; then
      echo "FAIL_CLOSED: Disallowed git push invocation: $*" >&2
      exit 128
    fi
    # Verify origin resolves exactly to owned bare repository path
    RESOLVED_ORIGIN="$("${realGitPath}" remote get-url origin 2>/dev/null || echo "")"
    if [ "$RESOLVED_ORIGIN" != "${infraOriginDir}" ]; then
      echo "FAIL_CLOSED: git push origin does not resolve to owned bare repository: $RESOLVED_ORIGIN" >&2
      exit 128
    fi
    ;;
  clone|rev-parse)
    ;;
  *)
    echo "FAIL_CLOSED: Unknown or unallowlisted git command: $*" >&2
    exit 128
    ;;
esac

echo "GIT_CALL:$*" >> "${gitLog}"
exec "${realGitPath}" "$@"
`;
    fs.writeFileSync(path.join(binDir, 'git'), fakeGitScript, { mode: 0o755 });

    const fakeGhScript = `#!/bin/sh
TOKEN_LABEL="\${GH_TOKEN_LABEL:-synthetic-unlabeled-token}"
echo "GH_CALL:TOKEN=\${TOKEN_LABEL}:$*" >> "${ghLog}"
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  if [ "$TOKEN_LABEL" != "SYNTHETIC_AUTHOR_TOKEN" ]; then
    echo "ERROR: pr create requires SYNTHETIC_AUTHOR_TOKEN context, got \${TOKEN_LABEL}" >&2
    exit 1
  fi
  # Verify exact supported arguments: --repo duikindiesee/kooker-infra --base <target> --head <branch> --title <title> --body <body>
  if [ "$3" != "--repo" ] || [ "$4" != "duikindiesee/kooker-infra" ] || [ "$5" != "--base" ] || [ "$7" != "--head" ] || [ "$9" != "--title" ] || [ "\${11}" != "--body" ]; then
    echo "ERROR: pr create invoked with unexpected arguments: $*" >&2
    exit 1
  fi
  echo "https://example.invalid/org/kooker-infra/pull/99"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "review" ]; then
  if [ "$TOKEN_LABEL" != "SYNTHETIC_APPROVER_TOKEN" ]; then
    echo "ERROR: pr review requires SYNTHETIC_APPROVER_TOKEN context, got \${TOKEN_LABEL}" >&2
    exit 1
  fi
  # Verify exact supported arguments: --approve <PR_URL> --repo duikindiesee/kooker-infra
  if [ "$3" != "--approve" ] || [ "$4" != "https://example.invalid/org/kooker-infra/pull/99" ] || [ "$5" != "--repo" ] || [ "$6" != "duikindiesee/kooker-infra" ]; then
    echo "ERROR: pr review invoked with unexpected arguments: $*" >&2
    exit 1
  fi
  if [ "$GH_REVIEW_FAIL" = "1" ]; then
    echo "Review denied by security policy" >&2
    exit 1
  fi
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "merge" ]; then
  if [ "$TOKEN_LABEL" != "SYNTHETIC_APPROVER_TOKEN" ]; then
    echo "ERROR: pr merge requires SYNTHETIC_APPROVER_TOKEN context, got \${TOKEN_LABEL}" >&2
    exit 1
  fi
  # Verify exact supported arguments: <PR_URL> --repo duikindiesee/kooker-infra --squash --delete-branch
  if [ "$3" != "https://example.invalid/org/kooker-infra/pull/99" ] || [ "$4" != "--repo" ] || [ "$5" != "duikindiesee/kooker-infra" ] || [ "$6" != "--squash" ] || [ "$7" != "--delete-branch" ]; then
    echo "ERROR: pr merge invoked with unexpected arguments: $*" >&2
    exit 1
  fi
  if [ "$GH_MERGE_FAIL" = "1" ]; then
    echo "Merge blocked by required status check" >&2
    exit 1
  fi
  echo "Merged pull request 99"
  exit 0
fi
echo "Unexpected gh command: $*" >&2
exit 1
`;
    fs.writeFileSync(path.join(binDir, 'gh'), fakeGhScript, { mode: 0o755 });

    const fakeDockerScript = `#!/bin/sh
printf "CALL_START\\n" >> "${dockerNulLog}"
for arg in "$@"; do printf "%s\\0" "$arg" >> "${dockerNulLog}"; done
printf "\\nCALL_END\\n" >> "${dockerNulLog}"
echo "DOCKER_CALL:$*" >> "${dockerLog}"

# Verify canonical inspect arguments:
# Either exactly 6 args: buildx imagetools inspect --format {{json .Manifest}} <image>
# Or exactly 4 args: buildx imagetools inspect <image>
if [ "$#" -eq 6 ]; then
  if [ "$1" != "buildx" ] || [ "$2" != "imagetools" ] || [ "$3" != "inspect" ] || [ "$4" != "--format" ] || [ "$5" != "{{json .Manifest}}" ]; then
    echo "FAIL_CLOSED: Unexpected docker 6-arg invocation: $*" >&2
    exit 1
  fi
elif [ "$#" -eq 4 ]; then
  if [ "$1" != "buildx" ] || [ "$2" != "imagetools" ] || [ "$3" != "inspect" ]; then
    echo "FAIL_CLOSED: Unexpected docker 4-arg invocation: $*" >&2
    exit 1
  fi
else
  echo "FAIL_CLOSED: Unexpected docker argument count $#: $*" >&2
  exit 1
fi

if [ "$DOCKER_FAULT" = "registry_nonzero_exit" ]; then
  echo "docker: buildx imagetools inspect: image not found in registry" >&2
  exit 1
fi

if [ "$DOCKER_FAULT" = "registry_malformed_json" ]; then
  echo "this is not json at all"
  exit 0
fi

# Return canonical valid OCI manifest descriptor JSON or simple inspect for tag mode
if [ "$#" -eq 6 ]; then
  cat << 'EOF'
{
  "schemaVersion": 2,
  "mediaType": "application/vnd.docker.distribution.manifest.v2+json",
  "digest": "${isTagMode ? '' : 'sha256:' + 'a'.repeat(64)}",
  "size": 1234
}
EOF
else
  echo "Name: $4"
  echo "MediaType: application/vnd.docker.distribution.manifest.v2+json"
fi
exit 0
`;
    fs.writeFileSync(path.join(binDir, 'docker'), fakeDockerScript, { mode: 0o755 });

    let actualFailureStage = null;
    let actualFailureDiagnostic = null;

    // -------------------------------------------------------------------------
    // STAGE 1: Actual "Validate the immutable image reference" Step
    // -------------------------------------------------------------------------
    const targetDigest = isTagMode ? '' : ('sha256:' + 'a'.repeat(64));
    const targetImageName = isCityLifeFault ? 'ghcr.io/duikindiesee/citylife' : 'ghcr.io/duikindiesee/sportifine-server';
    const targetCallerRepo = isCityLifeFault ? 'duikindiesee/citylife' : 'duikindiesee/sportifine-server';

    const stage1Env = {
      ...process.env,
      GITHUB_OUTPUT: githubOutput,
      CALLER_REPO: targetCallerRepo,
      IMAGE_NAME: targetImageName,
      NEW_TAG: '1.14.0',
      NEW_DIGEST: (chainFault === 'legacy_omitted_digest') ? '' : targetDigest,
      KUSTOMIZE_PATH: canonicalPath
    };

    const r1 = spawnSync('/bin/bash', ['-c', STEP_VALIDATE], {
      cwd: runnerWorkspace,
      env: stage1Env,
      encoding: 'utf8'
    });
    trace.push({
      stage: '1_validate_image',
      exit: r1.status,
      stdout: r1.stdout.trim(),
      stderr: r1.stderr.trim()
    });

    if (r1.status !== 0) {
      actualFailureStage = '1_validate_image';
      actualFailureDiagnostic = (r1.stdout || '') + '\n' + (r1.stderr || '');
    }

    // Read GITHUB_OUTPUT from stage 1
    const parseGithubOutput = (file) => {
      const out = {};
      if (!fs.existsSync(file)) return out;
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const eq = line.indexOf('=');
        if (eq !== -1) {
          out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
        }
      }
      return out;
    };
    const outputs = parseGithubOutput(githubOutput);
    const activeMode = outputs.mode || (isTagMode ? 'tag' : 'digest');

    // -------------------------------------------------------------------------
    // STAGE 2: Actual "Prove the exact image exists before changing GitOps" Step (Registry Proof)
    // -------------------------------------------------------------------------
    if (!actualFailureStage) {
      const stage2Env = {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        MODE: activeMode,
        IMAGE_REFERENCE: `${targetImageName}:1.14.0`,
        EXPECTED_DIGEST: targetDigest,
        DOCKER_FAULT: chainFault // passes 'registry_nonzero_exit', 'registry_malformed_json', etc. to fake docker stub
      };
      const r2 = spawnSync('/bin/bash', ['-c', REGISTRY_STEP_BODY], {
        cwd: runnerWorkspace,
        env: stage2Env,
        encoding: 'utf8'
      });
      trace.push({
        stage: '2_prove_image_registry',
        exit: r2.status,
        stdout: r2.stdout.trim(),
        stderr: r2.stderr.trim()
      });
      if (r2.status !== 0) {
        actualFailureStage = '2_prove_image_registry';
        actualFailureDiagnostic = (r2.stdout || '') + '\n' + (r2.stderr || '');
      }
    }

    // -------------------------------------------------------------------------
    // STAGE 3: Actual "Enforce release hold and adoption lock" Step
    // -------------------------------------------------------------------------
    if (!actualFailureStage) {
      const stage3Env = {
        ...process.env,
        INFRA_DIR: 'infra',
        KUSTOMIZE_PATH: canonicalPath,
        IMAGE_NAME: targetImageName,
        NEW_TAG: '1.14.0'
      };
      const r3 = spawnSync('/bin/bash', ['-c', STEP_HOLD], {
        cwd: runnerWorkspace,
        env: stage3Env,
        encoding: 'utf8'
      });
      trace.push({
        stage: '3_hold_gate',
        exit: r3.status,
        stdout: r3.stdout.trim(),
        stderr: r3.stderr.trim()
      });
      if (r3.status !== 0) {
        actualFailureStage = '3_hold_gate';
        actualFailureDiagnostic = (r3.stdout || '') + '\n' + (r3.stderr || '');
      }
    }

    // -------------------------------------------------------------------------
    // STAGE 4: Actual "Validate shared workflow helper identity" Step
    // (Only executed if activeMode === 'digest' as per workflow `if: steps.image.outputs.mode == 'digest'`)
    // -------------------------------------------------------------------------
    if (!actualFailureStage && activeMode === 'digest') {
      const stage4Env = {
        ...process.env,
        WORKFLOW_REPO: 'duikindiesee/kooker-workflows',
        WORKFLOW_PATH: '.github/workflows/gitops-sync.yml',
        WORKFLOW_SHA: actualValidCommitSha
      };
      const r4 = spawnSync('/bin/bash', ['-c', STEP_VALIDATE_HELPER], {
        cwd: runnerWorkspace,
        env: stage4Env,
        encoding: 'utf8'
      });
      trace.push({
        stage: '4_validate_helper_identity',
        exit: r4.status,
        stdout: r4.stdout.trim(),
        stderr: r4.stderr.trim()
      });
      if (r4.status !== 0) {
        actualFailureStage = '4_validate_helper_identity';
        actualFailureDiagnostic = (r4.stdout || '') + '\n' + (r4.stderr || '');
      }
    }

    // -------------------------------------------------------------------------
    // STAGE 5: Emulated Actions Checkout & "Verify checked-out helper source HEAD" Step
    // (Only executed if activeMode === 'digest' as per workflow)
    // -------------------------------------------------------------------------
    if (!actualFailureStage && activeMode === 'digest') {
      const checkoutTarget = path.join(runnerWorkspace, '.shared-workflows');
      const rCloneHelper = spawnSync('git', ['clone', remoteHelperDir, checkoutTarget], { encoding: 'utf8' });
      assert.equal(rCloneHelper.status, 0, `Helper clone failed: ${rCloneHelper.stderr}`);
      try {
        fs.symlinkSync(path.join(REPO_ROOT, 'tests/node_modules'), path.join(checkoutTarget, 'tests/node_modules'));
      } catch {}

      const stage5Env = {
        ...process.env,
        EXPECTED_SHA: actualValidCommitSha
      };
      const r5 = spawnSync('/bin/bash', ['-c', STEP_VERIFY_HELPER_HEAD], {
        cwd: runnerWorkspace,
        env: stage5Env,
        encoding: 'utf8'
      });
      trace.push({
        stage: '5_verify_helper_head',
        exit: r5.status,
        stdout: r5.stdout.trim(),
        stderr: r5.stderr.trim()
      });
      if (r5.status !== 0) {
        actualFailureStage = '5_verify_helper_head';
        actualFailureDiagnostic = (r5.stdout || '') + '\n' + (r5.stderr || '');
      }
    }

    // -------------------------------------------------------------------------
    // STAGE 6: Actual "Update Kustomize Image" Step (calling scripts/update-gitops-digest.mjs in digest mode or kustomize edit in tag mode)
    // -------------------------------------------------------------------------
    if (!actualFailureStage) {
      const stage6Env = {
        ...process.env,
        PATH: `${binDir}:${path.dirname(KUSTOMIZE_TOOL.cmd)}:${process.env.PATH}`,
        MODE: activeMode,
        NODE_PATH: path.join(runnerWorkspace, '.shared-workflows/tests/node_modules'),
        CALLER_REPO: targetCallerRepo,
        IMAGE_NAME: targetImageName,
        KUSTOMIZE_PATH: canonicalPath,
        NEW_DIGEST: targetDigest,
        NEW_TAG: '1.14.0',
        INFRA_DIR: 'infra'
      };
      const r6 = spawnSync('/bin/bash', ['-c', STEP_UPDATE], {
        cwd: runnerWorkspace,
        env: stage6Env,
        encoding: 'utf8'
      });
      trace.push({
        stage: '6_update_kustomize',
        exit: r6.status,
        stdout: r6.stdout.trim(),
        stderr: r6.stderr.trim()
      });
      if (r6.status !== 0) {
        actualFailureStage = '6_update_kustomize';
        actualFailureDiagnostic = (r6.stdout || '') + '\n' + (r6.stderr || '');
      }
    }

    // -------------------------------------------------------------------------
    // STAGE 7: Actual "Open the deploy PR" Step (calling git and fake gh pr create)
    // -------------------------------------------------------------------------
    let deployPrUrl = null;
    if (!actualFailureStage) {
      const stage7Env = {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        GH_TOKEN_LABEL: 'SYNTHETIC_AUTHOR_TOKEN',
        GITHUB_OUTPUT: githubOutput,
        MODE: activeMode,
        CALLER_REPO: targetCallerRepo,
        IMAGE_NAME: targetImageName,
        KUSTOMIZE_PATH: canonicalPath,
        NEW_DIGEST: targetDigest,
        NEW_TAG: '1.14.0',
        RUN_ID: '777001',
        TARGET_BRANCH: 'main'
      };
      const r7 = spawnSync('/bin/bash', ['-c', STEP_PR], {
        cwd: runnerWorkspace,
        env: stage7Env,
        encoding: 'utf8'
      });
      trace.push({
        stage: '7_open_pr',
        exit: r7.status,
        stdout: r7.stdout.trim(),
        stderr: r7.stderr.trim()
      });
      if (r7.status !== 0) {
        actualFailureStage = '7_open_pr';
        actualFailureDiagnostic = (r7.stdout || '') + '\n' + (r7.stderr || '');
      } else {
        const postPrOutputs = parseGithubOutput(githubOutput);
        deployPrUrl = postPrOutputs.pr_url || 'https://example.invalid/org/kooker-infra/pull/99';
      }
    }

    // -------------------------------------------------------------------------
    // STAGE 8: Actual "Approve and merge as the deploy approver" Step
    // -------------------------------------------------------------------------
    if (!actualFailureStage) {
      const stage8Env = {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        GH_TOKEN_LABEL: 'SYNTHETIC_APPROVER_TOKEN',
        GH_TOKEN: (chainFault === 'approver_token_missing') ? '' : 'synthetic-approver-token-valid',
        GH_REVIEW_FAIL: (chainFault === 'review_denied') ? '1' : '0',
        GH_MERGE_FAIL: (chainFault === 'merge_blocked') ? '1' : '0',
        KUSTOMIZE_PATH: canonicalPath,
        PR_URL: deployPrUrl || 'https://example.invalid/org/kooker-infra/pull/99'
      };
      const r8 = spawnSync('/bin/bash', ['-c', STEP_APPROVER], {
        cwd: runnerWorkspace,
        env: stage8Env,
        encoding: 'utf8'
      });
      trace.push({
        stage: '8_approve_and_merge',
        exit: r8.status,
        stdout: r8.stdout.trim(),
        stderr: r8.stderr.trim()
      });
      if (r8.status !== 0) {
        actualFailureStage = '8_approve_and_merge';
        actualFailureDiagnostic = (r8.stdout || '') + '\n' + (r8.stderr || '');
      }
    }

    const tEnd = process.hrtime.bigint();
    const elapsedSec = Number(tEnd - t0) / 1e9;

    // Derived flags from actual execution
    const prStepExecuted = trace.some(t => t.stage === '7_open_pr' && t.exit === 0);
    const approverStepExecuted = trace.some(t => t.stage === '8_approve_and_merge' && t.exit === 0);
    const actualExit = (actualFailureStage === null) ? 0 : 1;
    const expectedExit = (expectedFailureStage === null) ? 0 : 1;
    const infraAfterSnap = snapshotTree(infraDir);

    // Parse logs for verification and evidence
    const ghTrace = fs.existsSync(ghLog) ? fs.readFileSync(ghLog, 'utf8').trim().split('\n').filter(Boolean) : [];
    const dockerTrace = fs.existsSync(dockerLog) ? fs.readFileSync(dockerLog, 'utf8').trim().split('\n').filter(Boolean) : [];
    const gitTrace = fs.existsSync(gitLog) ? fs.readFileSync(gitLog, 'utf8').trim().split('\n').filter(Boolean) : [];
    const dockerNulCalls = fs.existsSync(dockerNulLog) ? parseDockerCalls(fs.readFileSync(dockerNulLog)) : [];

    // Derive gh operation counts
    const ghCreateCalls = ghTrace.filter(call => call.includes('pr create'));
    const ghReviewCalls = ghTrace.filter(call => call.includes('pr review'));
    const ghMergeCalls = ghTrace.filter(call => call.includes('pr merge'));

    // Evidence retention if TEST_EVIDENCE_DIR set
    if (process.env.TEST_EVIDENCE_DIR) {
      try {
        const evDir = path.resolve(process.env.TEST_EVIDENCE_DIR);
        fs.mkdirSync(evDir, { recursive: true });
        const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
        const evFile = path.join(evDir, `workflow_chain_${safeName}.json`);

        const evidence = {
          name,
          actual_exit: actualExit,
          expected_exit: expectedExit,
          actual_failure_stage: actualFailureStage,
          expected_failure_stage: expectedFailureStage,
          elapsed_seconds: elapsedSec,
          parsed_step_bodies_sha256: {
            validate: sha256(Buffer.from(STEP_VALIDATE)),
            registry: sha256(Buffer.from(REGISTRY_STEP_BODY)),
            hold: sha256(Buffer.from(STEP_HOLD)),
            validate_helper: sha256(Buffer.from(STEP_VALIDATE_HELPER)),
            verify_helper_head: sha256(Buffer.from(STEP_VERIFY_HELPER_HEAD)),
            update: sha256(Buffer.from(STEP_UPDATE)),
            open_pr: sha256(Buffer.from(STEP_PR)),
            approve_and_merge: sha256(Buffer.from(STEP_APPROVER))
          },
          trace_stages: trace,
          scoped_gh_calls: ghTrace,
          scoped_gh_counts: {
            create: ghCreateCalls.length,
            review: ghReviewCalls.length,
            merge: ghMergeCalls.length
          },
          scoped_docker_calls: dockerTrace,
          scoped_docker_nul_calls: dockerNulCalls,
          scoped_git_calls: gitTrace,
          pr_step_executed: prStepExecuted,
          approver_step_executed: approverStepExecuted,
          deploy_pr_url: deployPrUrl,
          before_infra_snapshot: infraBeforeSnap,
          after_infra_snapshot: infraAfterSnap,
          assertions: {
            stage_match: (actualFailureStage === expectedFailureStage),
            exit_match: (actualExit === expectedExit)
          }
        };
        fs.writeFileSync(evFile, JSON.stringify(evidence, null, 2) + '\n');
      } catch (e) {
        console.error(`Failed to write chain evidence for ${name}:`, e.message);
      }
    }

    // Stage assertion
    assert.equal(actualFailureStage, expectedFailureStage, `Workflow chain failure stage mismatch: expected '${expectedFailureStage}', got '${actualFailureStage}'`);
    if (expectedDiagnosticSubstr) {
      assert.ok(
        actualFailureDiagnostic && actualFailureDiagnostic.includes(expectedDiagnosticSubstr),
        `Expected diagnostic substring '${expectedDiagnosticSubstr}' not found in: ${actualFailureDiagnostic}`
      );
    }

    // Positive vs Negative invariants
    if (expectedExit === 0) {
      assert.ok(prStepExecuted, 'PR creation step must succeed in positive chain');
      assert.ok(approverStepExecuted, 'Approver review/merge step must succeed in positive chain');

      // Verify real Kustomize renders digest or tag pin
      const finalRender = spawnSync(KUSTOMIZE_TOOL.cmd, [...KUSTOMIZE_TOOL.args, targetDir], { encoding: 'utf8' });
      assert.equal(finalRender.status, 0, `Final Kustomize render failed: ${finalRender.stderr}`);

      const { docsByKey, targetIdentities } = analyzeRender(finalRender.stdout, targetImageName);
      assert.ok(docsByKey.size > 0, 'Rendered document must exist');

      // Assert exact complete pre-fixture resourcekeys and target identity set
      const expectedPreResourceKey = getFullResourceKey(placeholderDep);
      assert.deepEqual(Array.from(docsByKey.keys()).sort(), [expectedPreResourceKey], 'Exact complete resource keys must match pre-fixture manifest');

      const expectedTargets = deriveExpectedTargets([placeholderDep], targetImageName);
      assert.equal(targetIdentities.length, expectedTargets.length, 'Target container count must match derived expected targets');
      assert.equal(targetIdentities.length, 1, 'Exactly one target container identity must match');

      if (activeMode === 'digest') {
        assert.equal(targetIdentities[0].image, `ghcr.io/duikindiesee/sportifine-server@${targetDigest}`);
      } else {
        assert.equal(targetIdentities[0].image, `ghcr.io/duikindiesee/sportifine-server:1.14.0`);
      }
      assert.equal(targetIdentities[0].containerName, 'sportifine-server');
      assert.equal(targetIdentities[0].resourceKey, expectedPreResourceKey);

      // Verify semantic equality when target image is masked (preserves env, sidecars, namespace, etc.)
      const beforeRender = spawnSync(KUSTOMIZE_TOOL.cmd, [...KUSTOMIZE_TOOL.args, targetDir], { encoding: 'utf8' });
      const beforeAnalyzed = analyzeRender(beforeRender.stdout, targetImageName);
      const maskedBeforeDoc = maskTargetImagesInDoc(beforeAnalyzed.docsByKey.get(expectedPreResourceKey), beforeAnalyzed.targetIdentities);
      const maskedFinalDoc = maskTargetImagesInDoc(docsByKey.get(expectedPreResourceKey), targetIdentities);
      assert.deepEqual(maskedFinalDoc, maskedBeforeDoc, 'Unrelated resource semantics (env, sidecars, metadata) must be strictly preserved across update');

      // Verify unrelated sidecar preserved explicitly
      const depDoc = docsByKey.get('Deployment/kooker/sportifine-server');
      assert.ok(depDoc, 'sportifine-server Deployment must be in rendered output');
      const containers = depDoc.spec.template.spec.containers;
      const sidecar = containers.find(c => c.name === 'cache');
      assert.ok(sidecar, 'Sidecar cache container must be preserved');
      assert.equal(sidecar.image, 'nginx:1.25', 'Sidecar image must remain nginx:1.25');

      // Verify Docker inspect was called with exact canonical arguments (exactly 1 call)
      assert.equal(dockerNulCalls.length, 1, `Expected exactly 1 docker inspect call, got ${dockerNulCalls.length}`);
      if (activeMode === 'digest') {
        const expectedDockerArgs = ['buildx', 'imagetools', 'inspect', '--format', '{{json .Manifest}}', `${targetImageName}:1.14.0`];
        assert.deepEqual(dockerNulCalls[0], expectedDockerArgs, 'Docker inspect arguments must match canonical buildx specification');
      } else {
        const expectedDockerArgs = ['buildx', 'imagetools', 'inspect', `${targetImageName}:1.14.0`];
        assert.deepEqual(dockerNulCalls[0], expectedDockerArgs, 'Docker inspect arguments must match tag mode specification');
      }

      // Verify gh calls: 1 pr create (SYNTHETIC_AUTHOR_TOKEN), 1 pr review (SYNTHETIC_APPROVER_TOKEN), 1 pr merge (SYNTHETIC_APPROVER_TOKEN)
      assert.equal(ghTrace.length, 3, `Expected exactly 3 gh calls, got ${ghTrace.length}: ${JSON.stringify(ghTrace)}`);
      assert.equal(ghCreateCalls.length, 1, 'Exactly 1 pr create call');
      assert.equal(ghReviewCalls.length, 1, 'Exactly 1 pr review call');
      assert.equal(ghMergeCalls.length, 1, 'Exactly 1 pr merge call');
      assert.ok(ghCreateCalls[0].startsWith('GH_CALL:TOKEN=SYNTHETIC_AUTHOR_TOKEN:pr create'), `pr create must use author token: ${ghCreateCalls[0]}`);
      assert.ok(ghReviewCalls[0].startsWith('GH_CALL:TOKEN=SYNTHETIC_APPROVER_TOKEN:pr review'), `pr review must use approver token: ${ghReviewCalls[0]}`);
      assert.ok(ghMergeCalls[0].startsWith('GH_CALL:TOKEN=SYNTHETIC_APPROVER_TOKEN:pr merge'), `pr merge must use approver token: ${ghMergeCalls[0]}`);
    } else {
      // For failures occurring before PR/merge, assert no merge and infra integrity preserved as expected
      if (expectedFailureStage === '2_prove_image_registry' || expectedFailureStage === '3_hold_gate') {
        assert.deepEqual(infraAfterSnap, infraBeforeSnap, 'Early refusal must leave infra untouched');
        assert.ok(!prStepExecuted, 'PR step must NOT be reached on early refusal');
      }
      if (expectedFailureStage === '8_approve_and_merge') {
        assert.ok(prStepExecuted, 'PR was opened but approver gate refused merge');
        assert.ok(!approverStepExecuted, 'Approver merge must NOT succeed');
        if (chainFault === 'review_denied') {
          // Assert 0 merge attempts made after review failure
          assert.equal(ghMergeCalls.length, 0, 'No pr merge calls should occur after review denial');
        } else if (chainFault === 'merge_blocked') {
          // Assert exactly 3 merge attempts made
          assert.equal(ghMergeCalls.length, 3, 'Exactly 3 pr merge attempts should occur when merge is blocked');
        }
      }
    }

    report(fullName, true, `stage=${actualFailureStage || 'SUCCESS_MERGED'}, prOpened=${prStepExecuted}, approverMerged=${approverStepExecuted}, elapsed=${elapsedSec.toFixed(2)}s`);
  } catch (err) {
    report(fullName, false, err.message);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// -----------------------------------------------------------------------------
// Workflow Chain Test Cases
// -----------------------------------------------------------------------------

// 1. Neutral valid chain (digest mode): full end-to-end execution through digest update, PR create, review, squash-merge
runControlledWorkflowChainCase({
  name: 'neutral valid chain reaches digest update and PR merge',
  chainFault: null,
  expectedFailureStage: null,
  expectedDiagnosticSubstr: ''
});

// 2. Tag mode positive: legacy omitted digest input executes kustomize edit set image, 4-arg inspect, PR create & merge
runControlledWorkflowChainCase({
  name: 'legacy omitted digest tag mode reaches tag update and PR merge',
  chainFault: 'legacy_omitted_digest',
  expectedFailureStage: null,
  expectedDiagnosticSubstr: ''
});

// 3. Tag mode positive: explicit empty digest input executes kustomize edit set image, 4-arg inspect, PR create & merge
runControlledWorkflowChainCase({
  name: 'empty digest tag mode reaches tag update and PR merge',
  chainFault: 'empty_digest_tag_mode',
  expectedFailureStage: null,
  expectedDiagnosticSubstr: ''
});

// 4. Registry inspect non-zero exit: fails closed before any infra change or PR write
runControlledWorkflowChainCase({
  name: 'registry inspect nonzero exit stops before infra or PR',
  chainFault: 'registry_nonzero_exit',
  expectedFailureStage: '2_prove_image_registry',
  expectedDiagnosticSubstr: 'Registry inspection failed with exit code 1'
});

// 5. Registry malformed JSON output: fails closed before any infra change or PR write
runControlledWorkflowChainCase({
  name: 'registry malformed JSON stops before infra or PR',
  chainFault: 'registry_malformed_json',
  expectedFailureStage: '2_prove_image_registry',
  expectedDiagnosticSubstr: 'Malformed registry JSON output'
});

// 6. CityLife missing adoption lock refusal: fails closed before any helper/consumer update or PR write
runControlledWorkflowChainCase({
  name: 'CityLife missing adoption lock refusal stops before update or PR',
  chainFault: 'citylife_hold',
  expectedFailureStage: '3_hold_gate',
  expectedDiagnosticSubstr: 'Missing adoption lock file at'
});

// 7. CityLife malformed adoption lock refusal: fails closed before any helper/consumer update or PR write
runControlledWorkflowChainCase({
  name: 'CityLife malformed adoption lock refusal stops before update or PR',
  chainFault: 'citylife_hold_malformed',
  expectedFailureStage: '3_hold_gate',
  expectedDiagnosticSubstr: 'Malformed or unreadable adoption lock file at'
});

// 8. CityLife valid adoption lock refusal (release hold active): fails closed before any helper/consumer update or PR write
runControlledWorkflowChainCase({
  name: 'CityLife valid adoption lock release hold active stops before update or PR',
  chainFault: 'citylife_hold_valid',
  expectedFailureStage: '3_hold_gate',
  expectedDiagnosticSubstr: 'Release hold active: Single-service automated adoption is strictly blocked'
});

// 9. Approver token missing refusal: PR is opened but merge step fails closed immediately
runControlledWorkflowChainCase({
  name: 'missing approver token refuses merge after PR open',
  chainFault: 'approver_token_missing',
  expectedFailureStage: '8_approve_and_merge',
  expectedDiagnosticSubstr: 'GITOPS_APPROVER_TOKEN is not set. Deploy PR opened but NOT merged'
});

// 10. Approver review denied refusal: PR opened but review denied fails closed before merge
runControlledWorkflowChainCase({
  name: 'approver review denied refuses merge after PR open',
  chainFault: 'review_denied',
  expectedFailureStage: '8_approve_and_merge',
  expectedDiagnosticSubstr: 'Review denied by security policy'
});

// 11. Merge check blocked refusal: PR opened, review approved, but merge blocked after 3 attempts
runControlledWorkflowChainCase({
  name: 'merge checks blocked refuses merge after 3 attempts',
  chainFault: 'merge_blocked',
  expectedFailureStage: '8_approve_and_merge',
  expectedDiagnosticSubstr: 'Could not merge deploy PR after 3 attempts'
});

// =============================================================================
// Summary
// =============================================================================

console.log(`\n=== Integration Test Summary: ${passCount} passed, ${failCount} failed, ${skipCount} skipped (NOTRUN) ===`);
if (failCount > 0) {
  process.exit(1);
}
if (passCount === 0) {
  console.error("::error::NO_MATCHING_TESTS: Filter did not match any test cases");
  process.exit(1);
}
process.exit(0);
