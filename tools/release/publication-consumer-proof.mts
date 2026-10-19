import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPortableArchiveEntries } from '../packaging/portable-archive.mts';
import {
  boundedResponseBytes,
  requestGithubDownload,
  requestGithubPages,
  requestGithubRepositoryJson,
} from './github-read.mts';
import { loadPublicationLock, lockedCarrierFile } from './publication-lock.mts';
import { ROOT } from './release-graph.mts';

export const CONSUMER_PROOF_SCHEMA = 'oliphaunt-publication-consumer-proof-v1';
export const CONSUMER_PROOF_ARTIFACT = 'oliphaunt-publication-consumer-proof';
export const CONSUMER_CONFIGURATION_FILES = [
  'tools/release/frozen-consumer.mts',
  'tools/release/frozen-extension-consumer.mts',
  '.release-please-manifest.json',
  'tools/release/publication-consumer-proof.mts',
  'rust-toolchain.toml',
  '.github/workflows/release.yml',
  'tools/packaging/portable-archive.mts',
  'tools/release/public-consumer-smoke.mts',
  'src/native/sdks/swift/tools/prepare-swift-release-consumer.mts',
  'src/native/sdks/kotlin/gradle/libs.versions.toml',
  'src/native/sdks/kotlin/tests/public-api-consumer/src/main/kotlin/dev/oliphaunt/consumer/PublicApiConsumer.kt',
  'src/native/sdks/kotlin/tests/public-api-consumer/src/main/java/dev/oliphaunt/consumer/JavaPublicApiConsumer.java',
  'src/examples/native/react-native-expo/package.json',
  '.prototools',
  'src/native/sdks/ts/tools/frozen-consumer.mts',
  'src/query/ts/tools/frozen-consumer.mts',
  'src/wasix/sdks/ts/tools/frozen-consumer.mts',
  'src/wasix/sdks/ts/tools/frozen-browser-consumer.mts',
  'src/wasix/sdks/ts/tools/browser-cdp.mts',
  'src/wasix/sdks/ts/package.json',
  'src/native/runtime/smoke/frozen-consumer.c',
  'tools/release/release-artifact-targets.mts',
  'tools/release/github-read.mts',
  '.github/actions/setup-node-bun/action.yml',
  '.github/actions/setup-node-runtime/action.yml',
  '.github/actions/setup-moon/install-pinned-node.sh',
  'tools/dev/node-runtime.toml',
  '.github/actions/setup-npm-publisher/action.yml',
  '.github/actions/setup-npm-publisher/install.sh',
  'tools/release/npm-publisher.toml',
  '.github/actions/setup-bun/action.yml',
  '.github/actions/setup-deno/action.yml',
  '.github/actions/setup-rust/action.yml',
  '.github/actions/setup-msvc/action.yml',
  '.github/actions/setup-android/action.yml',
  '.github/actions/setup-apple/action.yml',
  'tools/dev/install-pinned-js-runtime.sh',
  'tools/dev/extract-pinned-binary.sh',
  'tools/dev/extract-pinned-zip.sh',
  'tools/dev/curl-platform-flags.sh',
  'tools/dev/acquisition.sh',
  'tools/dev/setup-android-sdk.sh',
  'tools/dev/android-sdk.toml',
  'tools/dev/bun.toml',
  'tools/dev/deno.toml',
  'src/native/sdks/kotlin/gradle/wrapper/gradle-wrapper.properties',
];

export function consumerDigest(value) {
  const canonical = (entry) =>
    Array.isArray(entry)
      ? entry.map(canonical)
      : entry && typeof entry === 'object'
        ? Object.fromEntries(
            Object.keys(entry)
              .sort()
              .map((key) => [key, canonical(entry[key])]),
          )
        : entry;
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

export function consumerConfigurationDigest(files = CONSUMER_CONFIGURATION_FILES, root = ROOT) {
  return consumerDigest(
    files.map((file) => [
      file,
      createHash('sha256')
        .update(readFileSync(path.join(root, file)))
        .digest('hex'),
    ]),
  );
}

function readJson(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024)
    throw new Error('consumer proof must be a bounded regular file');
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function aggregateConsumerResults(plan, results, producer) {
  const expected = new Map(plan.cases.map((test) => [test.id, test]));
  if (!expected.size || expected.size !== plan.cases.length)
    throw new Error('consumer plan must contain unique required cases');
  const cases = [];
  for (const result of results) {
    if (
      result.lockDigest !== plan.lockDigest ||
      result.casePlanDigest !== consumerDigest(plan) ||
      result.testConfigurationDigest !== plan.testConfigurationDigest
    )
      throw new Error('consumer result belongs to different bytes, cases or test configuration');
    for (const test of result.cases) {
      const specification = expected.get(test.id);
      if (
        !specification ||
        test.status !== 'success' ||
        consumerDigest(
          Object.fromEntries(Object.keys(specification).map((key) => [key, test[key]])),
        ) !== consumerDigest(specification) ||
        !/^[0-9a-f]{64}$/u.test(test.resolutionDigest ?? '') ||
        !Array.isArray(test.resolvedInputs) ||
        !test.resolvedInputs.length ||
        test.resolvedInputs.some(
          (input) =>
            typeof input.identity !== 'string' ||
            !input.identity ||
            typeof input.source !== 'string' ||
            !input.source ||
            typeof input.integrity !== 'string' ||
            !/^(?:sha256:[0-9a-f]{64}|sha(?:1|256|384|512)-[A-Za-z0-9+/]+=*)$/u.test(
              input.integrity,
            ),
        ) ||
        typeof test.toolchain !== 'string' ||
        !test.toolchain.trim() ||
        test.producer?.controllerSHA !== producer.controllerSHA ||
        test.producer?.runId !== producer.runId ||
        !Number.isSafeInteger(test.producer?.runAttempt) ||
        test.producer.runAttempt <= 0 ||
        test.producer.runAttempt > producer.runAttempt ||
        test.producer.jobName !== `Frozen consumers (${test.target})` ||
        typeof test.logReference !== 'string' ||
        !test.logReference
      )
        throw new Error(
          `consumer case ${test.id} is missing, duplicated, unexpected or unsuccessful`,
        );
      expected.delete(test.id);
      cases.push(test);
    }
  }
  if (expected.size) throw new Error(`missing consumer cases: ${[...expected.keys()].join(', ')}`);
  return {
    schema: CONSUMER_PROOF_SCHEMA,
    lockDigest: plan.lockDigest,
    casePlanDigest: consumerDigest(plan),
    testConfigurationDigest: plan.testConfigurationDigest,
    producer,
    cases: cases.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function validateConsumerProof(lock, plan, proof) {
  if (
    proof?.schema !== CONSUMER_PROOF_SCHEMA ||
    proof.lockDigest !== lock.lockDigest ||
    proof.casePlanDigest !== consumerDigest(plan) ||
    proof.testConfigurationDigest !== plan.testConfigurationDigest
  )
    throw new Error('publication requires current consumer proof for the exact frozen lock');
  aggregateConsumerResults(plan, [{ ...proof }], proof.producer);
  const producer = proof.producer;
  if (
    !producer ||
    !/^[0-9a-f]{40}$/u.test(producer.controllerSHA ?? '') ||
    !Number.isSafeInteger(producer.runId) ||
    producer.runId <= 0 ||
    !Number.isSafeInteger(producer.runAttempt) ||
    producer.runAttempt <= 0
  )
    throw new Error('consumer proof must identify its producing run and attempt');
  return proof;
}

const admitted = new Map();

export async function requirePublicationConsumerProof(
  lock,
  {
    environment = process.env,
    read = requestGithubRepositoryJson,
    list = requestGithubPages,
    download = requestGithubDownload,
  } = {},
) {
  lock ??= loadPublicationLock(
    environment.PUBLICATION_LOCK_PATH ?? environment.OLIPHAUNT_PUBLICATION_LOCK,
  );
  const { frozenConsumerPlan } = await import('./frozen-consumer.mts');
  const plan = frozenConsumerPlan(lock);
  const proof = readJson(
    environment.PUBLICATION_CONSUMER_PROOF_PATH ??
      path.join(ROOT, 'target/release/publication-consumer-proof.json'),
  );
  validateConsumerProof(lock, plan, proof);
  const repository = environment.GITHUB_REPOSITORY ?? environment.GH_REPO;
  const artifactId = Number(environment.PUBLICATION_CONSUMER_PROOF_ARTIFACT_ID);
  if (repository !== 'f0rr0/oliphaunt' || !Number.isSafeInteger(artifactId) || artifactId <= 0)
    throw new Error(
      'publication requires an immutable consumer-proof artifact from the canonical repository',
    );
  const key = `${artifactId}:${consumerDigest(proof)}:${consumerDigest(plan)}`;
  if (admitted.has(key)) return admitted.get(key);
  // Share a verified admission between isolated workers of this hosted job.
  // Direct/local calls always verify origin. Attempts and jobs never share it.
  const hostedJob =
    environment.GITHUB_ACTIONS === 'true' &&
    /^\d+$/u.test(environment.GITHUB_RUN_ID ?? '') &&
    /^\d+$/u.test(environment.GITHUB_RUN_ATTEMPT ?? '') &&
    environment.GITHUB_JOB &&
    path.isAbsolute(environment.RUNNER_TEMP ?? '');
  const cacheKey = consumerDigest({
    key,
    run: environment.GITHUB_RUN_ID,
    attempt: environment.GITHUB_RUN_ATTEMPT,
    job: environment.GITHUB_JOB,
  });
  const cache = hostedJob
    ? path.join(environment.RUNNER_TEMP, 'oliphaunt-consumer-admission', `${cacheKey}.json`)
    : null;
  if (cache && existsSync(cache)) {
    const cached = readJson(cache);
    if (
      cached.key !== key ||
      cached.admission?.artifactId !== artifactId ||
      cached.admission?.lockDigest !== lock.lockDigest ||
      cached.admission?.proofDigest !== consumerDigest(proof)
    )
      throw new Error('consumer admission cache differs from this exact job and proof');
    admitted.set(key, cached.admission);
    return cached.admission;
  }
  const readToken = environment.PUBLICATION_CONSUMER_READ_TOKEN;
  const options = {
    environment: readToken
      ? { ...environment, GH_TOKEN: readToken, GITHUB_TOKEN: readToken }
      : environment,
  };
  const artifact = await read(`repos/${repository}/actions/artifacts/${artifactId}`, options);
  const run = await read(`repos/${repository}/actions/runs/${proof.producer.runId}`, options);
  if (
    artifact.id !== artifactId ||
    artifact.name !== CONSUMER_PROOF_ARTIFACT ||
    artifact.expired !== false ||
    artifact.workflow_run?.id !== run.id ||
    run.id !== proof.producer.runId ||
    run.head_sha !== proof.producer.controllerSHA ||
    run.head_branch !== 'main' ||
    run.path !== '.github/workflows/release.yml' ||
    run.event !== 'workflow_dispatch' ||
    run.repository?.full_name !== repository ||
    run.head_repository?.full_name !== repository
  )
    throw new Error('consumer proof has an untrusted producing artifact or workflow');
  const jobs = await list(
    `repos/${repository}/actions/runs/${run.id}/attempts/${proof.producer.runAttempt}/jobs`,
    {
      ...options,
      itemsField: 'jobs',
    },
  );
  const ready = jobs.filter((job) => job.name === 'Publication ready');
  if (ready.length !== 1 || ready[0].conclusion !== 'success')
    throw new Error('consumer proof producing readiness job did not succeed');
  const attempts = new Map([[proof.producer.runAttempt, jobs]]);
  for (const test of proof.cases) {
    const attempt = test.producer.runAttempt;
    if (!attempts.has(attempt))
      attempts.set(
        attempt,
        await list(`repos/${repository}/actions/runs/${run.id}/attempts/${attempt}/jobs`, {
          ...options,
          itemsField: 'jobs',
        }),
      );
    const matches = attempts.get(attempt).filter((job) => job.name === test.producer.jobName);
    if (matches.length !== 1 || matches[0].conclusion !== 'success')
      throw new Error(
        `consumer proof has no successful ${test.target} job in its producing attempt`,
      );
  }
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-consumer-proof-'));
  try {
    const response = await download(
      `https://api.github.com/repos/${repository}/actions/artifacts/${artifactId}/zip`,
      options,
    );
    const bytes = await boundedResponseBytes(response, 8 * 1024 * 1024, 'consumer proof artifact');
    if (
      artifact.digest &&
      artifact.digest !== `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    )
      throw new Error('consumer-proof artifact digest differs from GitHub');
    const archive = path.join(scratch, 'proof.zip');
    writeFileSync(archive, bytes);
    const entries = readPortableArchiveEntries(archive);
    const entry = entries.get('publication-consumer-proof.json');
    if (
      entries.size !== 1 ||
      !entry ||
      consumerDigest(JSON.parse(Buffer.from(entry.data()).toString('utf8'))) !==
        consumerDigest(proof)
    )
      throw new Error('local consumer proof differs from its trusted immutable artifact');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const admission = { lockDigest: lock.lockDigest, proofDigest: consumerDigest(proof), artifactId };
  if (cache) {
    mkdirSync(path.dirname(cache), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(cache, JSON.stringify({ key, admission }), { flag: 'wx', mode: 0o400 });
    } catch (cause) {
      if (
        cause.code !== 'EEXIST' ||
        consumerDigest(readJson(cache)) !== consumerDigest({ key, admission })
      )
        throw cause;
    }
  }
  admitted.set(key, admission);
  return admission;
}

if (import.meta.main) {
  const [operation, ...args] = process.argv.slice(2);
  if (operation === 'aggregate') {
    const [planFile, resultsDirectory, output] = args;
    const { readdirSync } = await import('node:fs');
    const plan = readJson(planFile);
    const results = readdirSync(resultsDirectory)
      .filter((name) => name.endsWith('.json'))
      .map((name) => readJson(path.join(resultsDirectory, name)));
    const proof = aggregateConsumerResults(plan, results, {
      controllerSHA: process.env.GITHUB_SHA,
      runId: Number(process.env.GITHUB_RUN_ID),
      runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    });
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(proof, null, 2)}\n`);
  } else if (operation === 'admit' || operation === 'admit-npm') {
    const lock = loadPublicationLock(
      process.env.PUBLICATION_LOCK_PATH ?? process.env.OLIPHAUNT_PUBLICATION_LOCK,
    );
    const admission = await requirePublicationConsumerProof(lock);
    if (operation === 'admit-npm') {
      const descriptor = readJson(args[0]);
      const carrier = lockedCarrierFile(lock, 'npm', descriptor.packageName, descriptor.tarball);
      const { frozenNpmIntegrity } = await import('./frozen-npm-publish.mts');
      if (
        descriptor.expectedIntegrity !== frozenNpmIntegrity(carrier.file) ||
        !Number.isSafeInteger(descriptor.deadlineEpochSeconds) ||
        descriptor.deadlineEpochSeconds * 1000 <= Date.now()
      )
        throw new Error('npm admission integrity or publication deadline is no longer valid');
      if (
        descriptor.lockDigest !== lock.lockDigest ||
        descriptor.proofDigest !== admission.proofDigest ||
        descriptor.version !== carrier.carrier.version ||
        descriptor.registry !== 'https://registry.npmjs.org' ||
        !Number.isSafeInteger(descriptor.timeout) ||
        descriptor.timeout < 1000
      )
        throw new Error('npm admission does not bind the proved lock, carrier and tarball');
    }
  } else
    throw new Error(
      'usage: publication-consumer-proof.mts <aggregate PLAN RESULTS OUTPUT|admit|admit-npm DESCRIPTOR>',
    );
}
