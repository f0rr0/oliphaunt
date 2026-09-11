#!/usr/bin/env bun
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promoteDirectory, removeTemporaryPath } from '../../tools/packaging/atomic-directory.mts';
import { loadBootstrapLedger } from '../../tools/release/bootstrap-ledger.mts';
import { requestGithubPages } from '../../tools/release/github-read.mts';
import { assertPublicationChanges } from '../../tools/release/publication-controller.mts';
import { loadPublicationLock } from '../../tools/release/publication-lock.mts';
import { downloadBootstrapArtifact } from './download-bootstrap-ledger.mts';

const ARTIFACT = 'oliphaunt-bootstrap-ledger';

export function isCompletedMainRelease(run, repo) {
  return (
    Number.isSafeInteger(run?.id) &&
    run.id > 0 &&
    run.status === 'completed' &&
    run.conclusion === 'success' &&
    run.event === 'workflow_dispatch' &&
    run.head_branch === 'main' &&
    run.path === '.github/workflows/release.yml' &&
    run.repository?.full_name === repo &&
    run.head_repository?.full_name === repo &&
    /^[0-9a-f]{40}$/u.test(run.head_sha ?? '')
  );
}

export function matchesBootstrapLock(directory, lock) {
  const files = readdirSync(directory).sort();
  if (
    files.length === 0 ||
    files.some((file) => !/^checkpoint-[0-9]{6}-[0-9a-f]{64}[.]json$/u.test(file))
  ) {
    throw new Error('completed bootstrap artifact must contain only checkpoint files');
  }
  const first = JSON.parse(readFileSync(path.join(directory, files[0]), 'utf8'));
  // Discovery only. Matching evidence still undergoes full chain/envelope validation.
  return first.lockDigest === lock.lockDigest;
}

export async function discoverCompletedBootstrap(
  { repo, lock, stage },
  {
    list = requestGithubPages,
    download = async (run, artifact, stage) => {
      const jobs = await requestGithubPages(
        `repos/${repo}/actions/runs/${run.id}/jobs?filter=latest`,
        { itemsField: 'jobs' },
      );
      const gates = jobs.filter((job) => job.name === 'Bootstrap registry identities');
      if (gates.length !== 1 || gates[0].conclusion !== 'success')
        throw new Error(
          `completed bootstrap run ${run.id} requires exactly one successful bootstrap job`,
        );
      const downloaded = await downloadBootstrapArtifact(repo, artifact, stage);
      try {
        promoteDirectory(downloaded, stage);
      } finally {
        removeTemporaryPath(downloaded);
      }
    },
  } = {},
) {
  if (repo !== 'f0rr0/oliphaunt')
    throw new Error('completed bootstrap must come from the canonical repository');
  const runs = (
    await list(
      `repos/${repo}/actions/workflows/release.yml/runs?event=workflow_dispatch&status=success&branch=main`,
      {
        itemsField: 'workflow_runs',
        label: 'completed main Release runs',
      },
    )
  )
    .filter((run) => isCompletedMainRelease(run, repo))
    .sort((a, b) => b.id - a.id);
  for (const run of runs) {
    const artifacts = (
      await list(`repos/${repo}/actions/runs/${run.id}/artifacts`, {
        itemsField: 'artifacts',
        label: `completed bootstrap artifacts ${run.id}`,
      })
    ).filter((artifact) => artifact.name === ARTIFACT && artifact.expired === false);
    if (artifacts.length === 0) continue;
    if (artifacts.length !== 1)
      throw new Error(`run ${run.id} repeats the completed bootstrap artifact`);
    if (artifacts[0].workflow_run?.id !== undefined && artifacts[0].workflow_run.id !== run.id)
      throw new Error(`bootstrap artifact does not belong to run ${run.id}`);
    mkdirSync(stage, { recursive: true });
    let selected = false;
    try {
      await download(run, artifacts[0], stage);
      if (!matchesBootstrapLock(stage, lock)) continue;
      selected = true;
      return run;
    } finally {
      if (!selected) removeTemporaryPath(stage);
    }
  }
  throw new Error(
    `no completed main bootstrap matches approved lock ${lock.lockDigest}; existing bootstrap must not be restarted`,
  );
}

export function installCompletedBootstrap({
  run,
  stage,
  lock,
  destination,
  environment = process.env,
}) {
  assertPublicationChanges({ source: lock.source.commit, controller: run.head_sha, environment });
  loadBootstrapLedger(
    stage,
    lock,
    lock.products.map(({ id }) => id),
    { requireComplete: true },
  );
  promoteDirectory(stage, destination);
  return run.id;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, directory] = process.argv.slice(2);
    if (!['discover', 'install'].includes(command) || !directory)
      throw new Error('use download-completed-bootstrap.sh');
    const lock = loadPublicationLock(
      process.env.PUBLICATION_LOCK_PATH || 'target/release/publication-lock.json',
    );
    const destination = path.resolve(
      process.env.BOOTSTRAP_LEDGER_PATH || 'target/release/bootstrap-ledger',
    );
    const stage = path.join(directory, 'ledger');
    const context = path.join(directory, 'run.json');
    if (command === 'discover') {
      const run = await discoverCompletedBootstrap({ repo: process.env.GH_REPO, lock, stage });
      writeFileSync(context, JSON.stringify({ run, lockDigest: lock.lockDigest }));
      console.log(lock.source.commit);
      console.log(run.head_sha);
    } else {
      const { run, lockDigest } = JSON.parse(readFileSync(context, 'utf8'));
      if (lockDigest !== lock.lockDigest)
        throw new Error('completed bootstrap lock changed after discovery');
      const runId = installCompletedBootstrap({ run, stage, lock, destination });
      console.log(`verified completed bootstrap run ${runId} for approved lock ${lock.lockDigest}`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
