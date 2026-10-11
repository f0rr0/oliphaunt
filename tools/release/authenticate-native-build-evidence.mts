/** Authenticate construction evidence through the existing Actions artifact transport. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';
import {
  assertNativeBuildGithub,
  type NativeBuildGithub,
  type NativeBuildSource,
} from './native-build-qualification.mts';

const execute = promisify(execFile);

/** Caller expectations are constraints; only the downloader's GitHub API reads supply origin metadata. */
export async function authenticateNativeBuildEvidence(
  evidenceRoot: string,
  expected: {
    source: NativeBuildSource;
    github: NativeBuildGithub;
    event: 'push' | 'pull_request' | 'workflow_dispatch';
    ref: string;
    artifactName: string;
  },
) {
  assertNativeBuildGithub(expected.github);
  if (![expected.source.commit, expected.source.tree].every((sha) => /^[0-9a-f]{40}$/u.test(sha)))
    throw new Error('native origin requires exact source commit and tree');
  if (
    expected.github.workflow !== 'Native Bazel qualification' ||
    expected.github.workflowPath !== '.github/workflows/bazel.yml'
  )
    throw new Error('native origin requires the canonical Native Bazel qualification workflow');
  if (
    !['push', 'pull_request', 'workflow_dispatch'].includes(expected.event) ||
    !(
      expected.event === 'pull_request'
        ? /^refs\/pull\/[1-9][0-9]*\/merge$/u
        : /^refs\/heads\/[^\s\u0000-\u001f\u007f]+$/u
    ).test(expected.ref)
  )
    throw new Error('native origin requires an eligible exact workflow event and ref');
  if (!/^[A-Za-z0-9_.-]+$/u.test(expected.artifactName))
    throw new Error('native origin artifact name is invalid');
  const file = path.join(path.resolve(evidenceRoot), 'native-build-evidence.json');
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error('native origin evidence must be a regular file');
  const bytes = readFileSync(file);
  const scratch = mkdtempSync(path.join(tmpdir(), 'oliphaunt-native-origin-'));
  try {
    // This cache is created by this controller, never restored from evidence or inherited from a caller.
    const snapshots = path.join(scratch, 'snapshots');
    const downloaded = path.join(scratch, 'downloaded');
    const repositoryRoot = path.resolve(import.meta.dir, '../..');
    await execute(
      'bash',
      [
        path.join(repositoryRoot, '.github/scripts/download-build-artifacts.sh'),
        expected.github.workflow,
        expected.source.commit,
        downloaded,
        '--run-id',
        String(expected.github.runId),
        '--job',
        expected.github.job,
        '--job-success-only',
        '--workflow-path',
        expected.github.workflowPath,
        '--event',
        expected.event,
        '--ref',
        expected.ref,
        '--run-attempt',
        String(expected.github.runAttempt),
        '--source-tree',
        expected.source.tree,
        '--artifact',
        expected.artifactName,
      ],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          GH_REPO: expected.github.repository,
          OLIPHAUNT_GITHUB_RUN_SNAPSHOT_DIR: snapshots,
        },
        maxBuffer: 1024 * 1024,
      },
    );
    if (!bytes.equals(readFileSync(path.join(downloaded, 'native-build-evidence.json'))))
      throw new Error(
        'native build evidence bytes differ from the authenticated immutable artifact',
      );
    const snapshot = JSON.parse(
      readFileSync(path.join(snapshots, `run-${expected.github.runId}.json`), 'utf8'),
    );
    const artifact = snapshot.artifacts.find(
      (row) => row.name === expected.artifactName && row.expired === false,
    );
    const job = snapshot.jobs.find((row) => row.name === expected.github.job);
    return {
      github: {
        repository: snapshot.repo,
        workflow: snapshot.workflowName,
        workflowPath: snapshot.workflowPath,
        runId: Number(snapshot.runId),
        runAttempt: snapshot.runAttempt,
        job: job.name,
      } as NativeBuildGithub,
      artifact: {
        id: artifact.id,
        name: artifact.name,
        digest: artifact.digest,
        size: artifact.size_in_bytes,
      },
      evidenceDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      // Parsing transports the authenticated bytes; the content validator still owns qualification.
      evidence: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      options: Object.fromEntries(
        [
          'source-commit',
          'source-tree',
          'github-json',
          'event',
          'ref',
          'artifact-name',
          'evidence-root',
        ].map((name) => [name, { type: 'string' as const }]),
      ),
      allowPositionals: false,
    });
    const required = (key: string) => {
      const value = values[key];
      if (typeof value !== 'string' || !value)
        throw new Error(`native origin authentication requires --${key}`);
      return value;
    };
    const { evidence: _, ...origin } = await authenticateNativeBuildEvidence(
      required('evidence-root'),
      {
        source: { commit: required('source-commit'), tree: required('source-tree') },
        github: JSON.parse(readFileSync(required('github-json'), 'utf8')),
        event: required('event') as 'push' | 'pull_request' | 'workflow_dispatch',
        ref: required('ref'),
        artifactName: required('artifact-name'),
      },
    );
    process.stdout.write(`${JSON.stringify(origin)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
