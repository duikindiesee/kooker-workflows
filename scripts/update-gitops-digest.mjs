#!/usr/bin/env node
// scripts/update-gitops-digest.mjs
// Entrypoint script for canonical Kustomize digest update.
// Reads parameters strictly from structured environment variables:
//   CALLER_REPO: github.repository (e.g. duikindiesee/sportifine-server)
//   IMAGE_NAME: inputs.image_name (ghcr.io/duikindiesee/sportifine-server)
//   KUSTOMIZE_PATH: inputs.kustomize_path (manifests/overlays/develop/sportifine-server)
//   NEW_DIGEST: inputs.new_digest (sha256:64hex)
//   NEW_TAG: inputs.new_tag (e.g. 1.14.0)
//   INFRA_DIR: path to infra checkout (default: 'infra')

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { executeDigestUpdate } = require('./lib/kustomize-digest.js');

const callerRepo = process.env.CALLER_REPO || '';
const imageName = process.env.IMAGE_NAME || '';
const kustomizePath = process.env.KUSTOMIZE_PATH || '';
const newDigest = process.env.NEW_DIGEST || '';
const newTag = process.env.NEW_TAG || '';
const infraDir = process.env.INFRA_DIR || 'infra';

try {
  const result = executeDigestUpdate({
    callerRepo,
    imageName,
    kustomizePath,
    newDigest,
    newTag,
    infraDir,
  });

  console.log(`INFO: Successfully updated Kustomize digest pin to ${imageName}@${newDigest}`);
  console.log(`INFO: Verified intended Deployment 'sportifine-server' with container 'sportifine-server'`);
  process.exit(0);
} catch (err) {
  console.error(`::error::${err.message}`);
  process.exit(1);
}
