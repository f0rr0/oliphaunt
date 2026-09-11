import { readFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { requestGithubRepositoryJson } from '../../tools/release/github-read.mts';

const HASH = /^[0-9a-f]{64}$/u;

/** Moon owns input hashing. A receipt only records a complete, observed chain. */
export function producerHashes(report, cacheRoot, target) {
  const actions = report.actions.filter((action) => action.node?.action === 'run-task');
  const action = actions.find((entry) => entry.node.params.target === target);
  if (!action || !['passed', 'cached'].includes(action.status))
    return { eligible: false, reason: 'producer did not complete in this invocation' };
  const hash = action.operations.find((operation) => operation.meta?.type === 'hash-generation')
    ?.meta.hash;
  if (!HASH.test(hash ?? '')) return { eligible: false, reason: 'producer hashing is disabled' };
  const hashes = new Map();
  const visit = (expectedTarget, currentHash) => {
    if (!HASH.test(currentHash ?? ''))
      throw new Error(`incomplete producer hash: ${expectedTarget}=${currentHash}`);
    if (hashes.has(expectedTarget)) {
      assert.equal(hashes.get(expectedTarget).hash, currentHash, 'inconsistent producer ancestry');
      return;
    }
    const manifest = JSON.parse(
      readFileSync(path.join(cacheRoot, 'hashes', `${currentHash}.json`), 'utf8'),
    );
    const task = manifest.find((part) => part.target === expectedTarget);
    assert(
      task && task.deps && Array.isArray(task.toolchains),
      `missing Moon task manifest: ${expectedTarget}`,
    );
    hashes.set(expectedTarget, {
      target: expectedTarget,
      hash: currentHash,
      dependencies: task.deps,
    });
    for (const [dependency, dependencyHash] of Object.entries(task.deps))
      visit(dependency, dependencyHash);
  };
  try {
    visit(target, hash);
  } catch (error) {
    return { eligible: false, reason: error.message };
  }
  return {
    eligible: true,
    taskHash: hash,
    cacheHit: action.status === 'cached',
    hashes: [...hashes.values()].sort((left, right) => left.target.localeCompare(right.target)),
  };
}

if (import.meta.main) {
  const [target, artifactName] = process.argv.slice(2);
  assert(target && artifactName, 'usage: moon-producer-receipt.mts TARGET ARTIFACT_NAME');
  const artifactId = Number(process.env.PRODUCER_ARTIFACT_ID);
  assert(Number.isSafeInteger(artifactId) && artifactId > 0, 'immutable artifact ID is required');
  const artifact = await requestGithubRepositoryJson(
    `repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts/${artifactId}`,
  );
  assert.equal(artifact.id, artifactId);
  assert.equal(artifact.name, artifactName);
  assert.equal(artifact.expired, false);
  const uploadDigest = (process.env.PRODUCER_ARTIFACT_DIGEST ?? '').replace(/^sha256:/u, '');
  assert(HASH.test(uploadDigest), 'upload did not return a SHA-256 digest');
  assert.equal(artifact.digest, `sha256:${uploadDigest}`);
  assert.equal(String(artifact.workflow_run?.id), process.env.GITHUB_RUN_ID);
  assert.equal(artifact.workflow_run?.head_sha, process.env.CI_HEAD_SHA);
  const report = JSON.parse(readFileSync('.moon/cache/runReport.json', 'utf8'));
  const scope = producerHashes(report, '.moon/cache', target);
  const receipt = {
    target,
    ...scope,
    producer: {
      sha: process.env.CI_HEAD_SHA,
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    },
    toolchain: {
      moon: process.env.PRODUCER_MOON_VERSION,
      bun: Bun.version,
      typescript: JSON.parse(readFileSync('node_modules/typescript/package.json', 'utf8')).version,
      target: 'portable-typescript',
    },
    artifact: {
      id: artifact.id,
      name: artifact.name,
      digest: artifact.digest,
      size: artifact.size_in_bytes,
    },
  };
  assert(
    receipt.toolchain.moon && receipt.toolchain.typescript,
    'actual producer toolchain is required',
  );
  appendFileSync(process.env.GITHUB_OUTPUT, `receipt=${JSON.stringify(receipt)}\n`);
}
