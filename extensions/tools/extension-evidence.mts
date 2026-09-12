import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  catalogPath,
  contribPath,
  jsonText,
  readJson,
  readToml,
} from './extension-projections.mts';

type Row = Record<string, any>;
export const evidenceMatrixPath = 'extensions/evidence/matrix.toml';
export const evidenceRunsPath = 'extensions/evidence/runs';
export const evidenceTablePath = 'extensions/generated/docs/extension-evidence.json';
const tier = 'wasix-full-lifecycle-v1';
const collector = 'extensions/tools/collect-wasix-evidence.sh';
const modes = ['direct', 'server', 'restart', 'backup-restore', 'materialization'];
const statuses = new Set(['passed', 'failed', 'blocked', 'not-run']);
const fullSha = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const string = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const list = (value: unknown): value is string[] => Array.isArray(value) && value.every(string);
const id = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z][a-z0-9_]*$/.test(value);
const files = (pattern: string) =>
  [...new Bun.Glob(pattern).scanSync({ cwd: '.', onlyFiles: true })].sort();

export function sourceDigestInputs(): string[] {
  const envelope = new Set(['CHANGELOG.md', 'VERSION', 'moon.yml', 'release.toml']);
  return [
    'third-party/postgres/source.toml',
    'extensions/catalog/extensions.source.json',
    'extensions/catalog/native-components.toml',
    contribPath,
    catalogPath,
    'extensions/generated/contrib-build.tsv',
    'extensions/generated/pgxs-build.tsv',
    ...files('third-party/{icu,openssl}/source.toml')
      .concat(files('runtimes/liboliphaunt-native/sources/*.toml'))
      .concat(files('extensions/external/**/source.toml'))
      .concat('database-resources/icu/source.toml')
      .sort(),
    ...files('extensions/external/**/*').filter(
      (file) =>
        !envelope.has(file.split('/').at(-1)!) &&
        !file.endsWith('/source.toml') &&
        !/\.test\.[cm]?ts$/.test(file),
    ),
    'test-fixtures/extensions/manifest.json',
    ...files('test-fixtures/extensions/*.sql'),
  ];
}

export function sourceDigest(
  paths = sourceDigestInputs(),
  overrides = new Map<string, string>(),
): string {
  const digest = createHash('sha256');
  for (const file of paths)
    digest
      .update(file)
      .update('\0')
      .update((overrides.get(file) ?? readFileSync(file, 'utf8')).replace(/\r\n?/g, '\n'))
      .update('\0');
  return `sha256:${digest.digest('hex')}`;
}

export function evidenceMatrix(catalog: Row): string {
  return (
    [
      'format-version = 1',
      'source-digest-inputs = [',
      ...sourceDigestInputs().map((file) => `  ${JSON.stringify(file)},`),
      ']',
      '',
      ...[...catalog.extensions]
        .sort((a, b) => (a['sql-name'] < b['sql-name'] ? -1 : 1))
        .flatMap((extension) => {
          assert(id(extension.id), 'invalid extension evidence id');
          return [
            '[[claims]]',
            `extension = "${extension.id}"`,
            'postgres-major = 18',
            'artifact-family = "wasix-runtime"',
            'platform-targets = ["portable"]',
            'runtime-modes = ["direct", "server", "restart", "backup-restore"]',
            `evidence-required = ["${tier}"]`,
            '',
          ];
        }),
    ]
      .join('\n')
      .trimEnd() + '\n'
  );
}

export function validateEvidenceRun(run: Row): void {
  assert.equal(run.schema, 'oliphaunt-extension-evidence-v1', 'unsupported evidence schema');
  assert(
    typeof run.sourceDigest === 'string' && /^sha256:[0-9a-f]{64}$/.test(run.sourceDigest),
    'invalid evidence digest',
  );
  assert(list(run.sourceDigestInputs), 'invalid evidence source inputs');
  for (const field of ['id', 'observedAt', 'collector', 'evidenceTier'])
    assert(string(run[field]), `missing evidence ${field}`);
  assert(['passed', 'failed', 'blocked'].includes(run.status), 'invalid evidence status');
  if (run.evidenceTier === tier) {
    assert(
      fullSha(run.sourceCommit) && fullSha(run.sourceTree),
      'full lifecycle evidence needs exact commit and tree',
    );
    for (const field of ['repository', 'workflow', 'job'])
      assert(string(run.github?.[field]), `missing GitHub ${field}`);
    for (const field of ['runId', 'runAttempt'])
      assert(
        Number.isSafeInteger(run.github?.[field]) && run.github[field] > 0,
        `invalid GitHub ${field}`,
      );
  }
  assert(Array.isArray(run.results) && run.results.length, 'missing evidence results');
  const seen = new Set<string>();
  for (const result of run.results) {
    assert(id(result.extension) && string(result.sqlName), 'invalid evidence extension');
    if (result.postgresMajor !== 18) continue;
    assert(
      string(result.artifactFamily) && string(result.platformTarget),
      'invalid evidence target',
    );
    assert(
      result.runtimeModeStatuses &&
        typeof result.runtimeModeStatuses === 'object' &&
        !Array.isArray(result.runtimeModeStatuses),
      'missing runtime statuses',
    );
    const entries = Object.entries(result.runtimeModeStatuses);
    assert(
      entries.length &&
        entries.every(([mode, status]) => string(mode) && statuses.has(status as string)),
      'invalid runtime statuses',
    );
    const key = JSON.stringify([result.extension, result.artifactFamily, result.platformTarget]);
    assert(!seen.has(key), `duplicate evidence result ${key}`);
    seen.add(key);
  }
}

export function evidenceTable(
  catalog: Row,
  matrix: Row,
  runs: { path: string; run: Row }[],
  identity: { commit: string; tree: string },
  requireCurrent = false,
  overrides = new Map<string, string>(),
): Row {
  const inputs = sourceDigestInputs();
  assert.equal(matrix['format-version'], 1, 'unsupported evidence matrix');
  assert(list(matrix['source-digest-inputs']), 'missing evidence source inputs');
  assert.deepEqual(
    matrix['source-digest-inputs'].map((file: string) => file.replaceAll('\\', '/')),
    inputs,
    'stale evidence source inputs',
  );
  const catalogById = new Map<string, Row>(catalog.extensions.map((row: Row) => [row.id, row]));
  const claims: Row[] = matrix.claims;
  assert(Array.isArray(claims) && claims.length, 'missing evidence claims');
  const claimIds = claims.map((claim) => claim.extension);
  assert.equal(new Set(claimIds).size, claims.length, 'duplicate evidence claims');
  assert.deepEqual(
    [...claimIds].sort(),
    [...catalogById.keys()].sort(),
    'evidence claims must cover the extension catalog',
  );
  const digest = sourceDigest(inputs, overrides);
  assert(runs.length, 'missing immutable evidence runs');
  const accepted = new Map<string, Row>();
  const order = new Map<string, string>();
  for (const { path, run } of runs) {
    validateEvidenceRun(run);
    if (
      run.sourceDigest !== digest ||
      JSON.stringify(run.sourceDigestInputs.map((file: string) => file.replaceAll('\\', '/'))) !==
        JSON.stringify(inputs) ||
      run.status !== 'passed'
    )
      continue;
    if (
      run.evidenceTier === tier &&
      (run.sourceCommit !== identity.commit || run.sourceTree !== identity.tree)
    )
      continue;
    for (const result of run.results) {
      if (result.postgresMajor !== 18) continue;
      assert.equal(
        catalogById.get(result.extension)?.['sql-name'],
        result.sqlName,
        'current evidence SQL name differs from catalog',
      );
      const key = JSON.stringify([
        result.extension,
        run.evidenceTier,
        result.artifactFamily,
        result.platformTarget,
      ]);
      const nextOrder = [run.observedAt, run.id, path].join('\0');
      if (nextOrder <= (order.get(key) ?? '')) continue;
      order.set(key, nextOrder);
      accepted.set(key, {
        'run-id': run.id,
        'run-path': path,
        'evidence-tier': run.evidenceTier,
        'artifact-family': result.artifactFamily,
        'platform-target': result.platformTarget,
        'source-digest': digest,
        'source-commit': run.sourceCommit ?? null,
        'source-tree': run.sourceTree ?? null,
        github: run.github ?? null,
        'observed-at': run.observedAt,
        'runtime-mode-statuses': result.runtimeModeStatuses,
      });
    }
  }
  const rows = claims
    .map((claim) => {
      assert(id(claim.extension) && claim['postgres-major'] === 18, 'invalid evidence claim');
      for (const field of ['evidence-required', 'platform-targets', 'runtime-modes'])
        assert(list(claim[field]) && claim[field].length, `invalid claim ${field}`);
      assert(string(claim['artifact-family']), 'missing claim artifact family');
      const latest: Row[] = [],
        missing: Row[] = [];
      for (const required of claim['evidence-required'])
        for (const target of claim['platform-targets']) {
          const result = accepted.get(
            JSON.stringify([claim.extension, required, claim['artifact-family'], target]),
          );
          const missingModes = claim['runtime-modes'].filter(
            (mode: string) => result?.['runtime-mode-statuses'][mode] !== 'passed',
          );
          if (missingModes.length)
            missing.push({
              'evidence-tier': required,
              'artifact-family': claim['artifact-family'],
              'platform-target': target,
              'runtime-modes': missingModes,
            });
          else latest.push(result!);
        }
      assert(
        !requireCurrent || !missing.length,
        `extension ${claim.extension} lacks current CI evidence: ${JSON.stringify(missing)}`,
      );
      return {
        ...claim,
        'sql-name': catalogById.get(claim.extension)!['sql-name'],
        'latest-accepted-evidence': latest,
        'missing-current-evidence': missing,
      };
    })
    .sort((a, b) => (a['sql-name'] < b['sql-name'] ? -1 : 1));
  return {
    'format-version': 1,
    'qualification-authority': { kind: 'exact-sha-ci', collector },
    'generated-from': [
      { name: 'extension-catalog', path: catalogPath },
      { name: 'evidence-matrix', path: evidenceMatrixPath },
      { name: 'evidence-runs', path: evidenceRunsPath },
    ],
    'source-digest': digest,
    'source-digest-inputs': inputs,
    claims: rows,
  };
}

export function observedWasixModes(directory: string, sql: string): Record<string, string> {
  return Object.fromEntries(
    modes.map((mode) => {
      assert.equal(
        readFileSync(`${directory}/${sql}.${mode}`, 'utf8'),
        'passed\n',
        `missing successful observation for ${sql}/${mode}`,
      );
      return [mode, 'passed'];
    }),
  );
}

export function recordedEvidence(
  catalog: Row,
  runId: string,
  observedAt: string,
  identity: { commit: string; tree: string },
  cleanInputs: boolean,
): Row {
  assert(
    /^\d{4}-\d{2}-\d{2}T\d{6}Z-[a-z0-9-]+$/.test(runId),
    'run id must use YYYY-MM-DDTHHMMSSZ-lower-kebab-case',
  );
  assert(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(observedAt),
    'observed-at must use UTC YYYY-MM-DDTHH:MM:SSZ',
  );
  assert.equal(
    process.env.GITHUB_ACTIONS,
    'true',
    'full release evidence requires the GitHub Actions collector',
  );
  assert(fullSha(identity.commit) && fullSha(identity.tree), 'invalid checkout identity');
  assert.equal(process.env.CI_HEAD_SHA, identity.commit, 'CI_HEAD_SHA differs from checkout');
  assert(cleanInputs, 'refusing dirty exact-SHA evidence');
  const directory = process.env.OLIPHAUNT_EXTENSION_EVIDENCE_DIR;
  assert(directory, 'missing current run observations');
  const run = {
    schema: 'oliphaunt-extension-evidence-v1',
    id: runId,
    evidenceTier: tier,
    status: 'passed',
    sourceDigest: sourceDigest(),
    sourceDigestInputs: sourceDigestInputs(),
    sourceCommit: identity.commit,
    sourceTree: identity.tree,
    observedAt,
    collector,
    github: {
      repository: process.env.GITHUB_REPOSITORY,
      workflow: process.env.GITHUB_WORKFLOW,
      runId: Number(process.env.GITHUB_RUN_ID),
      runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      job: process.env.GITHUB_JOB,
    },
    notes:
      'Recorded only after the full WASIX catalog-extension direct, server, restart, materialization, and physical backup/restore suites succeeded.',
    results: [...catalog.extensions]
      .sort((a, b) => (a['sql-name'] < b['sql-name'] ? -1 : 1))
      .map((extension) => ({
        extension: extension.id,
        sqlName: extension['sql-name'],
        postgresMajor: 18,
        artifactFamily: 'wasix-runtime',
        platformTarget: 'portable',
        runtimeModeStatuses: observedWasixModes(directory, extension['sql-name']),
      })),
  };
  validateEvidenceRun(run);
  return run;
}

export function currentEvidenceTable(
  catalog: Row,
  identity: { commit: string; tree: string },
  requireCurrent = false,
  matrix = readToml(evidenceMatrixPath),
  overrides = new Map<string, string>(),
  extraRuns: { path: string; run: Row }[] = [],
): string {
  return jsonText(
    evidenceTable(
      catalog,
      matrix,
      [
        ...files(`${evidenceRunsPath}/*.json`).map((path) => ({ path, run: readJson(path) })),
        ...extraRuns,
      ],
      identity,
      requireCurrent,
      overrides,
    ),
  );
}
