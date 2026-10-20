// scripts/lib/kustomize-digest.js
// Dedicated Node 24 helper for canonical Kustomize digest updating and validation.
// Evaluates and manipulates Kustomization documents with YAML 2.9.1.
// Fails closed on any ambiguity, mismatch, or unexpected resource mutation.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
let yaml;
try {
  yaml = require('yaml');
} catch (e) {
  yaml = require(path.resolve(__dirname, '../../tests/node_modules/yaml'));
}

const CANONICAL_CALLER_REPO = 'duikindiesee/sportifine-server';
const CANONICAL_IMAGE_NAME = 'ghcr.io/duikindiesee/sportifine-server';
const CANONICAL_KUSTOMIZE_PATH = 'manifests/overlays/develop/sportifine-server';
const INTENDED_DEPLOYMENT_NAME = 'sportifine-server';
const INTENDED_CONTAINER_NAME = 'sportifine-server';
const INTENDED_NAMESPACE = 'kooker';

function validateInputs({ callerRepo, imageName, kustomizePath, newDigest, newTag }) {
  if (callerRepo !== CANONICAL_CALLER_REPO) {
    throw new Error(`DIGEST_CONTRACT_ERROR: caller repository '${callerRepo}' is not authorized for digest mode (expected '${CANONICAL_CALLER_REPO}')`);
  }
  if (imageName !== CANONICAL_IMAGE_NAME) {
    throw new Error(`DIGEST_CONTRACT_ERROR: image_name '${imageName}' is not authorized for digest mode (expected '${CANONICAL_IMAGE_NAME}')`);
  }
  if (kustomizePath !== CANONICAL_KUSTOMIZE_PATH) {
    throw new Error(`DIGEST_CONTRACT_ERROR: kustomize_path '${kustomizePath}' is not authorized for digest mode (expected '${CANONICAL_KUSTOMIZE_PATH}')`);
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(newDigest)) {
    throw new Error(`DIGEST_CONTRACT_ERROR: new_digest '${newDigest}' is not a valid lowercase sha256:64hex digest`);
  }
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(newTag)) {
    throw new Error(`DIGEST_CONTRACT_ERROR: new_tag '${newTag}' is not a valid OCI tag`);
  }
}

function runKustomizeBuild(targetDir) {
  // Support both standalone kustomize and kubectl kustomize
  try {
    return execFileSync('kustomize', ['build', targetDir], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return execFileSync('kubectl', ['kustomize', targetDir], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    }
    throw err;
  }
}

function semanticEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }
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

function parseAndAnalyzeRender(renderedYamlText, expectedImage, expectedDigest = null) {
  const docs = yaml.parseAllDocuments(renderedYamlText);
  let backendDeploymentFound = false;
  const targetIdentities = [];
  const docsByKey = new Map();
  const targetPrefix = `${expectedImage}@`;
  const exactTarget = expectedDigest ? `${expectedImage}@${expectedDigest}` : null;

  for (const doc of docs) {
    if (doc.errors && doc.errors.length > 0) {
      throw new Error(`RENDER_PARSE_ERROR: ${doc.errors[0].message}`);
    }
    const res = doc.toJSON();
    if (!res || typeof res !== 'object') continue;

    const kind = res.kind;
    const metadata = res.metadata || {};
    const name = metadata.name;
    const namespace = (typeof metadata.namespace === 'string' && metadata.namespace.length > 0) ? metadata.namespace : null;
    const resourceKey = namespace !== null ? `${kind}/${namespace}/${name}` : `${kind}/${name}`;

    if (docsByKey.has(resourceKey)) {
      throw new Error(`RENDER_DUPLICATE_RESOURCE: Duplicate resource found in rendered output: '${resourceKey}'`);
    }
    docsByKey.set(resourceKey, res);

    if (kind === 'Deployment' && name === INTENDED_DEPLOYMENT_NAME) {
      if (namespace === null) {
        throw new Error(`RENDER_INTENDED_NAMESPACE_MISSING: Deployment '${name}' is missing required namespace (expected '${INTENDED_NAMESPACE}')`);
      }
      if (namespace !== INTENDED_NAMESPACE) {
        throw new Error(`RENDER_INTENDED_NAMESPACE_MISMATCH: Deployment '${name}' has namespace '${namespace}' (expected '${INTENDED_NAMESPACE}')`);
      }
      backendDeploymentFound = true;
    }

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
      const containerLists = [
        { field: 'containers', list: spec.containers },
        { field: 'initContainers', list: spec.initContainers }
      ];

      for (const { field, list } of containerLists) {
        if (!list) continue;
        if (!Array.isArray(list)) {
          throw new Error(`RENDER_MALFORMED_PODSPEC: '${resourceKey}' field '${field}' is not an array`);
        }
        for (const c of list) {
          if (!c || typeof c !== 'object' || typeof c.name !== 'string') {
            throw new Error(`RENDER_MALFORMED_CONTAINER: '${resourceKey}' contains malformed container in '${field}'`);
          }
          const cName = c.name;
          const img = c.image || '';

          const isExactTarget = exactTarget !== null && img === exactTarget;
          const isTargetBase = img === expectedImage || img.startsWith(`${expectedImage}:`) || img.startsWith(targetPrefix);

          if (expectedDigest !== null) {
            if (isExactTarget) {
              targetIdentities.push({
                resourceKey,
                field,
                containerName: cName,
                image: img
              });
            } else if (img.startsWith(targetPrefix)) {
              throw new Error(`RENDER_UNEXPECTED_TARGET: RENDER_IMAGE_MISMATCH: '${resourceKey}' container '${cName}' has image '${img}', expected '${exactTarget}'`);
            } else if (img === expectedImage || img.startsWith(`${expectedImage}:`)) {
              throw new Error(`RENDER_UNEXPECTED_TARGET: RENDER_IMAGE_MISMATCH: '${resourceKey}' container '${cName}' retained un-pinned image '${img}', expected '${exactTarget}'`);
            }
          } else {
            if (isTargetBase) {
              targetIdentities.push({
                resourceKey,
                field,
                containerName: cName,
                image: img
              });
            }
          }
        }
      }
    }
  }

  return {
    backendDeploymentFound,
    targetIdentities,
    docsByKey
  };
}

function inspectRenderedDocuments(renderedYamlText, expectedImage, expectedDigest, preRenderContext = null) {
  const analysis = parseAndAnalyzeRender(renderedYamlText, expectedImage, expectedDigest);
  const { backendDeploymentFound, targetIdentities: postTargetIdentities, docsByKey: postDocsByKey } = analysis;

  if (!backendDeploymentFound) {
    throw new Error(`RENDER_MISSING_WORKLOAD: Expected Deployment '${INTENDED_DEPLOYMENT_NAME}' in namespace '${INTENDED_NAMESPACE}' not found in rendered output`);
  }

  const backendTargets = postTargetIdentities.filter(t => t.resourceKey === `Deployment/${INTENDED_NAMESPACE}/${INTENDED_DEPLOYMENT_NAME}`);
  if (backendTargets.length === 0) {
    throw new Error(`RENDER_MISSING_CONTAINER: Deployment '${INTENDED_DEPLOYMENT_NAME}' has 0 containers matching target image`);
  }

  const mainContainerFound = backendTargets.some(t => t.containerName === INTENDED_CONTAINER_NAME);
  if (!mainContainerFound) {
    throw new Error(`RENDER_MISSING_CONTAINER: Expected container '${INTENDED_CONTAINER_NAME}' not found with target image in Deployment '${INTENDED_DEPLOYMENT_NAME}'`);
  }

  if (preRenderContext) {
    const { expectedTargetIdentities, preDocsByKey } = preRenderContext;

    if (postTargetIdentities.length !== expectedTargetIdentities.length) {
      throw new Error(`RENDER_IDENTITY_SET_MISMATCH: Pre-render expected ${expectedTargetIdentities.length} target containers, post-render has ${postTargetIdentities.length}`);
    }

    const identityKey = t => `${t.resourceKey}:${t.field}:${t.containerName}`;
    const sortedPre = [...expectedTargetIdentities].sort((a, b) => identityKey(a).localeCompare(identityKey(b)));
    const sortedPost = [...postTargetIdentities].sort((a, b) => identityKey(a).localeCompare(identityKey(b)));

    for (let i = 0; i < sortedPre.length; i++) {
      const p = sortedPre[i];
      const q = sortedPost[i];
      if (p.resourceKey !== q.resourceKey || p.field !== q.field || p.containerName !== q.containerName) {
        throw new Error(`RENDER_IDENTITY_SET_MISMATCH: Target identity mismatch: expected '${identityKey(p)}', got '${identityKey(q)}'`);
      }
    }

    const maskTargetImages = (doc, targetList) => {
      const cloned = JSON.parse(JSON.stringify(doc));
      if (!targetList || targetList.length === 0) return cloned;
      const targetNames = new Set(targetList.map(t => `${t.field}:${t.containerName}`));
      const podSpecs = [];
      if (cloned.spec && cloned.spec.template && cloned.spec.template.spec) {
        podSpecs.push(cloned.spec.template.spec);
      }
      if (cloned.spec && cloned.spec.jobTemplate && cloned.spec.jobTemplate.spec && cloned.spec.jobTemplate.spec.template && cloned.spec.jobTemplate.spec.template.spec) {
        podSpecs.push(cloned.spec.jobTemplate.spec.template.spec);
      }
      if (cloned.spec && cloned.spec.containers && Array.isArray(cloned.spec.containers)) {
        podSpecs.push(cloned.spec);
      }
      for (const ps of podSpecs) {
        for (const field of ['containers', 'initContainers']) {
          const list = ps[field];
          if (Array.isArray(list)) {
            for (const c of list) {
              if (c && typeof c === 'object' && targetNames.has(`${field}:${c.name}`)) {
                c.image = '__MASKED_INTENDED_TARGET_IMAGE__';
              }
            }
          }
        }
      }
      return cloned;
    };

    for (const [resKey, preDoc] of preDocsByKey) {
      const postDoc = postDocsByKey.get(resKey);
      if (!postDoc) {
        throw new Error(`RENDER_UNRELATED_MUTATION: Resource '${resKey}' present in pre-render is missing in post-render`);
      }

      const targetsInThisResource = expectedTargetIdentities.filter(t => t.resourceKey === resKey);
      const maskedPre = maskTargetImages(preDoc, targetsInThisResource);
      const maskedPost = maskTargetImages(postDoc, targetsInThisResource);
      if (!semanticEqual(maskedPre, maskedPost)) {
        throw new Error(`RENDER_UNRELATED_MUTATION: Resource '${resKey}' semantically mutated`);
      }
    }

    for (const [resKey] of postDocsByKey) {
      if (!preDocsByKey.has(resKey)) {
        throw new Error(`RENDER_UNRELATED_MUTATION: Unexpected new resource '${resKey}' added in post-render`);
      }
    }
  } else {
    // Standalone post-render validation fallback
    const exactTarget = `${expectedImage}@${expectedDigest}`;
    const targetPrefix = `${expectedImage}@`;
    for (const [resKey, res] of postDocsByKey) {
      const isExpectedDeployment = (resKey === `Deployment/${INTENDED_NAMESPACE}/${INTENDED_DEPLOYMENT_NAME}`);
      if (!isExpectedDeployment) {
        const podSpecs = [];
        if (res.spec && res.spec.template && res.spec.template.spec) {
          podSpecs.push(res.spec.template.spec);
        }
        if (res.spec && res.spec.jobTemplate && res.spec.jobTemplate.spec && res.spec.jobTemplate.spec.template && res.spec.jobTemplate.spec.template.spec) {
          podSpecs.push(res.spec.jobTemplate.spec.template.spec);
        }
        if (res.spec && res.spec.containers && Array.isArray(res.spec.containers)) {
          podSpecs.push(res.spec);
        }
        for (const ps of podSpecs) {
          const containers = ps.containers || [];
          if (Array.isArray(containers)) {
            for (const c of containers) {
              if (c && c.image && (c.image === exactTarget || c.image.startsWith(targetPrefix))) {
                throw new Error(`RENDER_UNRELATED_MUTATION: Unrelated resource '${resKey}' container '${c.name}' has image '${c.image}'`);
              }
            }
          }
        }
      }
    }
  }

  const matchingDeploymentFound = backendDeploymentFound;
  const matchingContainerCount = backendTargets.length;
  return {
    matchingDeploymentFound,
    matchingContainerCount,
    backendDeploymentFound,
    targetContainerCount: postTargetIdentities.length,
    targetIdentities: postTargetIdentities
  };
}

function updateKustomizationFile(kustomizationFilePath, imageName, newDigest) {
  if (!fs.existsSync(kustomizationFilePath)) {
    throw new Error(`KUSTOMIZATION_NOT_FOUND: '${kustomizationFilePath}' does not exist`);
  }
  const rawText = fs.readFileSync(kustomizationFilePath, 'utf8');
  const doc = yaml.parseDocument(rawText, { uniqueKeys: true });
  if (doc.errors && doc.errors.length > 0) {
    throw new Error(`KUSTOMIZATION_PARSE_ERROR: ${doc.errors[0].message}`);
  }

  const jsObj = doc.toJS();
  if (!jsObj || typeof jsObj !== 'object') {
    throw new Error('KUSTOMIZATION_INVALID: parsed document is not an object');
  }

  let images = jsObj.images;
  if (!images) {
    images = [];
  } else if (!Array.isArray(images)) {
    throw new Error('KUSTOMIZATION_INVALID: images field is not an array');
  }

  // Count matching entries
  const matchingIndices = [];
  for (let i = 0; i < images.length; i++) {
    const entry = images[i];
    if (entry && entry.name === imageName) {
      matchingIndices.push(i);
    }
  }

  if (matchingIndices.length > 1) {
    throw new Error(`KUSTOMIZATION_CONFLICT: Found duplicate image entries for '${imageName}'`);
  }

  if (matchingIndices.length === 0) {
    // Add entry
    images.push({
      name: imageName,
      newName: imageName,
      digest: newDigest,
    });
    doc.set('images', images);
  } else {
    // Update existing entry cleanly: set name, newName, digest; remove newTag
    const idx = matchingIndices[0];
    const existing = images[idx];
    if (existing.newName && existing.newName !== imageName) {
      throw new Error(`KUSTOMIZATION_CONFLICT: existing image entry has conflicting newName '${existing.newName}'`);
    }

    doc.setIn(['images', idx, 'name'], imageName);
    doc.setIn(['images', idx, 'newName'], imageName);
    doc.setIn(['images', idx, 'digest'], newDigest);
    doc.deleteIn(['images', idx, 'newTag']);
  }

  const updatedText = doc.toString();
  fs.writeFileSync(kustomizationFilePath, updatedText, 'utf8');
  return { updated: true };
}

function executeDigestUpdate({ callerRepo, imageName, kustomizePath, newDigest, newTag, infraDir }) {
  validateInputs({ callerRepo, imageName, kustomizePath, newDigest, newTag });

  if (!fs.existsSync(infraDir) || !fs.statSync(infraDir).isDirectory()) {
    throw new Error(`INFRA_DIR_NOT_FOUND: Infra directory does not exist: '${infraDir}'`);
  }
  const realInfra = fs.realpathSync(infraDir);

  const targetDir = path.resolve(infraDir, kustomizePath);
  if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
    throw new Error(`TARGET_DIR_NOT_FOUND: Target directory does not exist: '${targetDir}'`);
  }

  // Reject below-root overlay segment symlinks and enforce exact physical canonical location
  const rel = path.relative(infraDir, targetDir);
  const segments = rel.split(path.sep);
  let cur = infraDir;
  for (const seg of segments) {
    if (!seg || seg === '.') continue;
    cur = path.join(cur, seg);
    if (fs.lstatSync(cur).isSymbolicLink()) {
      throw new Error(`PATH_TRAVERSAL_ERROR: Symlink detected in overlay path segment: '${cur}'`);
    }
  }

  const realTarget = fs.realpathSync(targetDir);
  const expectedCanonical = path.join(realInfra, ...segments.filter(s => s && s !== '.'));
  if (realTarget !== expectedCanonical) {
    throw new Error(`PATH_TRAVERSAL_ERROR: Target directory realpath '${realTarget}' does not match expected canonical location '${expectedCanonical}'`);
  }

  // 1. Locate kustomization file and ensure it does not escape physical canonical directory via symlink
  let kustomizationFile = path.join(targetDir, 'kustomization.yaml');
  if (!fs.existsSync(kustomizationFile)) {
    kustomizationFile = path.join(targetDir, 'kustomization.yml');
  }
  if (!fs.existsSync(kustomizationFile)) {
    kustomizationFile = path.join(targetDir, 'Kustomization');
  }
  if (!fs.existsSync(kustomizationFile)) {
    throw new Error(`KUSTOMIZATION_NOT_FOUND: No kustomization.yaml found in '${targetDir}'`);
  }

  if (fs.lstatSync(kustomizationFile).isSymbolicLink()) {
    throw new Error(`PATH_TRAVERSAL_ERROR: Kustomization file must not be a symbolic link: '${kustomizationFile}'`);
  }
  const realKustomizationFile = fs.realpathSync(kustomizationFile);
  if (path.dirname(realKustomizationFile) !== realTarget) {
    throw new Error(`PATH_TRAVERSAL_ERROR: Kustomization file escapes physical canonical directory: '${realKustomizationFile}'`);
  }

  // 2. Verify pre-update render succeeds and perform complete workload & container identity analysis
  const preRender = runKustomizeBuild(targetDir);
  const preAnalysis = parseAndAnalyzeRender(preRender, imageName, null);

  if (!preAnalysis.backendDeploymentFound) {
    throw new Error(`PRE_RENDER_MISSING_DEPLOYMENT: Pre-update render does not contain intended Deployment '${INTENDED_DEPLOYMENT_NAME}'`);
  }
  if (preAnalysis.targetIdentities.length === 0) {
    throw new Error(`PRE_RENDER_ZERO_TARGETS: Pre-update render contains 0 target containers for image '${imageName}'`);
  }
  const preBackendTargets = preAnalysis.targetIdentities.filter(t => t.resourceKey === `Deployment/${INTENDED_NAMESPACE}/${INTENDED_DEPLOYMENT_NAME}`);
  if (preBackendTargets.length === 0) {
    throw new Error(`PRE_RENDER_MISSING_CONTAINER: Pre-update Deployment '${INTENDED_DEPLOYMENT_NAME}' has no containers matching '${imageName}'`);
  }
  if (!preBackendTargets.some(t => t.containerName === INTENDED_CONTAINER_NAME)) {
    throw new Error(`PRE_RENDER_MISSING_CONTAINER: Pre-update Deployment '${INTENDED_DEPLOYMENT_NAME}' missing expected container '${INTENDED_CONTAINER_NAME}'`);
  }

  const preRenderContext = {
    expectedTargetIdentities: preAnalysis.targetIdentities,
    preDocsByKey: preAnalysis.docsByKey
  };

  // Preserve backup of target directory files and modes for atomic rollback on post-validation failure
  const backupFiles = new Map();
  for (const entry of fs.readdirSync(targetDir)) {
    const p = path.join(targetDir, entry);
    const st = fs.statSync(p);
    if (st.isFile()) {
      backupFiles.set(p, {
        content: fs.readFileSync(p),
        mode: st.mode
      });
    }
  }

  const rollback = () => {
    for (const [p, backup] of backupFiles) {
      fs.writeFileSync(p, backup.content);
      fs.chmodSync(p, backup.mode);
    }
  };

  try {
    // 3. Update the Kustomization file
    updateKustomizationFile(kustomizationFile, imageName, newDigest);

    // 4. Run post-update render and strictly validate all output documents against pre-render context
    const postRender = runKustomizeBuild(targetDir);
    const inspectionResult = inspectRenderedDocuments(postRender, imageName, newDigest, preRenderContext);

    return {
      success: true,
      targetDir,
      kustomizationFile,
      renderedOutput: postRender,
      inspectionResult,
    };
  } catch (err) {
    rollback();
    throw err;
  }
}

module.exports = {
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
  INTENDED_NAMESPACE,
};
