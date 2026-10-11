import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { archiveDirectory } from '../packaging/archive-directory.mts';
import { captureNativeBuildEvidence } from './capture-native-build-evidence.mts';
import {
  captureCompletedNativeProductBaselines,
  recordCompletedNativeProductBaselines,
} from './completed-native-product-baseline.mts';
import { nativeBuildMetadata } from './native-build-qualification.mts';
import { captureNativeOutputMembers } from './native-publication-staging.mts';
import { consumerDigest } from './publication-consumer-proof.mts';
import { PUBLICATION_LOCK_SCHEMA } from './publication-lock.mts';
import { verifyLockedRegistryIntegrity } from './registry-integrity.mts';
import { ROOT } from './release-graph.mts';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const source = { commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
const configuration = 'c'.repeat(64);

async function fixture(run) {
  // These products/transport responses are synthetic. Real packed files and
  // the actual collector, BEP validator and registry verifier exercise the seam.
  mkdirSync(path.join(ROOT, 'target'), { recursive: true });
  const directory = mkdtempSync(path.join(ROOT, 'target/completed-native-fixture-'));
  const executionRoot = path.join(directory, 'execroot');
  const products = ['alpha', 'beta'].map((id, index) => ({
    id,
    version: `${index + 1}.0.0`,
    publishTargets: ['github-release', 'npm'],
  }));
  const roots = [],
    carrierRows = [],
    artifactRows = [],
    publicationFiles = [];
  const paths = [],
    targets = [],
    actions = [],
    depSetOfFiles = [];
  const addFile = (file: string, content?: string) => {
    let index = paths.indexOf(file);
    if (index >= 0) return index + 1;
    paths.push(file);
    index = paths.length;
    if (content !== undefined) {
      mkdirSync(path.dirname(path.join(executionRoot, file)), { recursive: true });
      writeFileSync(path.join(executionRoot, file), content);
    }
    return index;
  };
  const action = (label: string, outputs: number[], inputs: number[], cfg = 1) => {
    const id = targets.length + 1;
    targets.push({ id, label });
    depSetOfFiles.push({ id, directArtifactIds: inputs });
    actions.push({
      targetId: id,
      configurationId: cfg,
      mnemonic: 'FixturePackage',
      actionKey: `declaration-${id}`,
      inputDepSetIds: [id],
      outputIds: outputs,
      primaryOutputId: outputs[0],
    });
  };
  const tool = addFile('external/compiler/compiler', 'immutable compiler');
  for (const product of products) {
    const sourceInput = addFile(
      `src/${product.id}/index.ts`,
      `export const product = '${product.id}';\n`,
    );
    const generated = addFile(`bazel-out/k8-opt/bin/${product.id}/config.h`, '#define VALUE 1\n');
    action(`//fixture/${product.id}:config`, [generated], [sourceInput, tool], 2);
    const packed = path.join(directory, `${product.id}-source/package`);
    mkdirSync(packed, { recursive: true });
    writeFileSync(
      path.join(packed, 'package.json'),
      JSON.stringify({
        name: `@fixture/${product.id}`,
        version: product.version,
        dependencies: { '@fixture/held-runtime': '=0.3.2' },
      }),
    );
    writeFileSync(path.join(packed, 'index.ts'), `export const product = '${product.id}';\n`);
    const output = `bazel-out/k8-opt/bin/${product.id}/${product.id}.tgz`;
    await archiveDirectory(path.dirname(packed), `${path.join(executionRoot, output)}.tar.gz`);
    renameSync(`${path.join(executionRoot, output)}.tar.gz`, path.join(executionRoot, output));
    const outputId = addFile(output);
    action(`//fixture/${product.id}:archive`, [outputId], [sourceInput, tool, generated]);
    roots.push({
      label: `//fixture/${product.id}:npm`,
      package: {
        product: product.id,
        version: product.version,
        ecosystem: 'npm',
        name: `@fixture/${product.id}`,
        configuration: 'portable',
        role: 'facade',
        outputs: [{ path: output, owner: `//fixture/${product.id}:archive` }],
      },
    });
    const bytes = readFileSync(path.join(executionRoot, output));
    const frozenPath = path
      .relative(ROOT, path.join(executionRoot, output))
      .split(path.sep)
      .join('/');
    const artifact = { path: frozenPath, sha256: hash(bytes), size: bytes.length };
    publicationFiles.push(artifact);
    carrierRows.push({
      id: `npm:@fixture/${product.id}`,
      product: product.id,
      version: product.version,
      ecosystem: 'npm',
      name: `@fixture/${product.id}`,
      role: 'facade',
      target: null,
      declared: true,
      dependencies: [],
      packageDependencies: [
        { ecosystem: 'npm', name: '@fixture/held-runtime', requirement: '=0.3.2' },
      ],
      artifacts: [artifact],
      publishOrder: carrierRows.length,
    });
    if (product.id !== 'beta') continue;
    const payload = `bazel-out/k8-opt/bin/beta/public_payload`;
    addFile(payload);
    mkdirSync(path.join(executionRoot, payload));
    writeFileSync(
      path.join(executionRoot, payload, 'public-interface.bin'),
      'compiled advertised version 2.0.0',
    );
    action('//fixture/beta:payload', [paths.length], [sourceInput, tool, generated]);
    roots.push({
      label: '//fixture/beta:internal',
      package: {
        product: product.id,
        version: product.version,
        ecosystem: 'internal',
        name: 'beta-payload',
        configuration: 'linux-x64-gnu',
        role: 'construction',
        outputs: [{ path: payload, owner: '//fixture/beta:payload' }],
      },
    });
    const archive = 'bazel-out/k8-opt/bin/beta/release-assets/beta-runtime.tar.gz';
    await archiveDirectory(path.join(executionRoot, payload), path.join(executionRoot, archive));
    const archiveId = addFile(archive);
    action('//fixture/beta:github', [archiveId], [paths.indexOf(payload) + 1]);
    roots.push({
      label: '//fixture/beta:public',
      package: {
        product: product.id,
        version: product.version,
        ecosystem: 'github',
        name: 'beta-runtime.tar.gz',
        configuration: 'linux-x64-gnu',
        role: 'github-release-asset',
        outputs: [{ path: archive, owner: '//fixture/beta:github' }],
      },
    });
    const githubBytes = readFileSync(path.join(executionRoot, archive));
    const githubArtifact = {
      product: product.id,
      id: 'github-release:beta-runtime.tar.gz',
      role: 'github-release-asset',
      kind: 'native-runtime',
      target: 'linux-x64-gnu',
      identity: null,
      name: 'beta-runtime.tar.gz',
      path: path.relative(ROOT, path.join(executionRoot, archive)).split(path.sep).join('/'),
      sha256: hash(githubBytes),
      size: githubBytes.length,
    };
    artifactRows.push(githubArtifact);
    publicationFiles.push({
      path: githubArtifact.path,
      sha256: githubArtifact.sha256,
      size: githubArtifact.size,
    });
  }
  const github = {
    repository: 'f0rr0/oliphaunt',
    workflow: 'Native Bazel qualification',
    workflowPath: '.github/workflows/bazel.yml',
    runId: 77,
    runAttempt: 1,
    job: 'Linux runtime (x86_64)',
  };
  const requiredTests = products.map(({ id }) => ({
    label: `//fixture/${id}:installed_test`,
    configuration,
  }));
  const events = [
    { id: { started: {} }, started: { uuid: 'fixture-build', buildToolVersion: '8.8.1' } },
    { id: { workspace: {} }, workspaceInfo: { localExecRoot: executionRoot } },
    { id: { configuration: { id: configuration } }, configuration: { mnemonic: 'k8-opt' } },
    { id: { buildMetadata: {} }, buildMetadata: { metadata: nativeBuildMetadata(source, github) } },
  ];
  for (const [index, root] of roots.entries()) {
    const output = root.package.outputs[0].path;
    const members = captureNativeOutputMembers(executionRoot, output).members;
    events.push({
      id: { namedSet: { id: `output-${index}` } },
      namedSetOfFiles: {
        files: members
          .filter((member) => member.type === 'file')
          .map((member) => ({
            name: member.path ? `${output}/${member.path}` : output,
            digest: member.sha256,
            length: String(member.size),
          })),
      },
    });
    events.push({
      id: { targetCompleted: { label: root.label, configuration: { id: configuration } } },
      completed: {
        success: true,
        outputGroup: [{ name: 'default', fileSets: [{ id: `output-${index}` }] }],
      },
    });
  }
  for (const test of requiredTests)
    events.push(
      {
        id: { targetCompleted: { label: test.label, configuration: { id: configuration } } },
        completed: { success: true },
      },
      {
        id: { testResult: { label: test.label, configuration: { id: configuration }, run: 1 } },
        testResult: { status: 'PASSED', cachedLocally: true },
      },
      {
        id: { testSummary: { label: test.label, configuration: { id: configuration } } },
        testSummary: { overallStatus: 'PASSED', totalRunCount: 1 },
      },
    );
  events.push(
    { id: { buildFinished: {} }, finished: { exitCode: { name: 'SUCCESS' } } },
    { id: { buildMetrics: {} }, buildMetrics: {}, lastMessage: true },
  );
  const aquery = {
    pathFragments: paths.flatMap((file, index) =>
      file.split('/').map((label, part) => ({
        id: `${index}-${part}`,
        label,
        ...(part ? { parentId: `${index}-${part - 1}` } : {}),
      })),
    ),
    artifacts: paths.map((file, index) => ({
      id: index + 1,
      pathFragmentId: `${index}-${file.split('/').length - 1}`,
    })),
    targets,
    depSetOfFiles,
    actions,
    configuration: [
      { id: 1, checksum: configuration },
      { id: 2, checksum: 'e'.repeat(64), isTool: true },
    ],
  };
  const capture = captureNativeBuildEvidence({
    source,
    github,
    bazelVersion: '8.8.1',
    cohorts: [
      {
        executionRoot,
        roots,
        aquery,
        buildEvents: events,
        cquery: {
          results: roots.map((root) => ({
            target: { rule: { name: root.label } },
            configurationId: 11,
          })),
          configurations: [{ id: 11, checksum: configuration }],
        },
      },
    ],
  });
  const lock = {
    schema: PUBLICATION_LOCK_SCHEMA,
    catalogSchema: 'oliphaunt-publication-catalog-v1',
    catalogDigest: '1'.repeat(64),
    packageEnvelopeDigest: '2'.repeat(64),
    source,
    products,
    carriers: carrierRows,
    productArtifacts: artifactRows,
  };
  const rehash = (value) => {
    const { lockDigest: _, ...rest } = value;
    value.lockDigest = consumerDigest(rest);
  };
  rehash(lock);
  const origin = {
    github,
    artifact: {
      id: 101,
      name: 'native-build-evidence-x86_64',
      digest: `sha256:${'3'.repeat(64)}`,
      size: 123,
    },
    evidenceDigest: `sha256:${hash(Buffer.from(JSON.stringify(capture.evidence)))}`,
    evidence: capture.evidence,
  };
  const releases = products.map((product, index) => ({
    product: product.id,
    version: product.version,
    tag: `${product.id}-v${product.version}`,
    releaseId: index + 20,
    releaseName: `${product.id} v${product.version}`,
    targetCommitish: source.commit,
    draft: false,
    prerelease: false,
    assets: artifactRows
      .filter((artifact) => artifact.product === product.id)
      .map((artifact, asset) => ({
        assetId: asset + 30,
        name: artifact.name,
        sha256: artifact.sha256,
        size: artifact.size,
      })),
  }));
  const requests = [];
  const input = {
    publicationLock: lock,
    publicationFiles,
    repository: github.repository,
    bazelVersion: '8.8.1',
    builds: [
      {
        evidenceRoot: path.join(directory, 'evidence'),
        expected: {
          source,
          github,
          event: 'push' as const,
          ref: 'refs/heads/main',
          artifactName: origin.artifact.name,
        },
        requiredTests,
      },
    ],
  };
  const transports = {
    authenticate: async (_root, expected) => {
      expect(expected.source).toEqual(source);
      requests.push('auth');
      return origin;
    },
    assertCompleted: async (requested) => {
      requests.push(requested.product);
      return { ...requested, publicationTree: source.tree, releaseSha: 'f'.repeat(40) };
    },
    verifyRegistry: (locked) =>
      verifyLockedRegistryIntegrity(locked, {
        fetchImpl: async (url) => {
          const carrier = carrierRows.find((carrier) =>
            String(url).includes(encodeURIComponent(carrier.name)),
          );
          const bytes = readFileSync(path.join(ROOT, carrier.artifacts[0].path));
          return Response.json({
            dist: { integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` },
          });
        },
      }),
    readGithubReleases: async () => releases,
  };
  try {
    await run({ input, transports, origin, releases, directory, requests, rehash });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('completed projection binds genuine packed bytes, cache-backed configured tests and held contracts per product', async () => {
  await fixture(async ({ input, transports, requests }) => {
    const record = await captureCompletedNativeProductBaselines(input, transports);
    expect(requests).toEqual(['alpha', 'beta', 'auth']);
    expect(record.coverage.completeFrozenInventory).toBe(true);
    expect(record.coverage.completeMigrationInventory).toBe('unverified');
    expect(record.products.map((product) => product.preEnvelopeCapture)).toEqual([
      'absent',
      'observed',
    ]);
    expect(record.products.every((product) => product.baselineAdmission === 'unknown')).toBe(true);
    expect(record.releaseDecision).toBe('unverified');
    expect(record.products[0].carriers[0].packageDependencies[0].requirement).toBe('=0.3.2');
    expect(
      record.products[0].construction[0].inputs.some((input) => input.path.includes('/beta/')),
    ).toBe(false);
    expect(
      record.products[1].construction[0].roots.find((root) => root.package.ecosystem === 'internal')
        .outputs[0].members[1].sha256,
    ).toMatch(/^[a-f0-9]{64}$/u);
    expect(record.builds[0].requiredTests).toHaveLength(2);
    expect(record.builds[0].testQualification).toBe('passed');
    expect(record.publication.registryReceipts).toHaveLength(2);
    expect(record.unverified).toContain(
      'immutable input lifetime from the producing build through content capture',
    );
  });
});

test('pending or mismatched canonical completion cannot write an observation file', async () => {
  await fixture(async ({ input, transports, directory }) => {
    const output = path.join(directory, 'completed.json');
    for (const assertCompleted of [
      async () => {
        throw new Error('publication is not complete');
      },
      async (requested) => ({
        ...requested,
        publicationTree: '9'.repeat(40),
        releaseSha: 'f'.repeat(40),
      }),
    ]) {
      await expect(
        recordCompletedNativeProductBaselines(output, input, { ...transports, assertCompleted }),
      ).rejects.toThrow();
      expect(existsSync(output)).toBe(false);
    }
  });
});

test('stale source/run, failed mandatory test and incomplete configured inventory fail closed', async () => {
  await fixture(async ({ input, transports, origin }) => {
    const missingPlan = structuredClone(input);
    delete missingPlan.builds[0].requiredTests;
    await expect(captureCompletedNativeProductBaselines(missingPlan, transports)).rejects.toThrow(
      /nonempty configured test plan/,
    );
    const wrongSource = structuredClone(input);
    wrongSource.builds[0].expected.source = { ...source, commit: '9'.repeat(40) };
    await expect(captureCompletedNativeProductBaselines(wrongSource, transports)).rejects.toThrow(
      /source/,
    );
    for (const change of [
      (evidence) => {
        evidence.github.runAttempt = 2;
      },
      (evidence) => {
        evidence.cohorts[0].buildEvents.find((event) => event.testResult).testResult.status =
          'FAILED';
      },
      (evidence) => {
        evidence.cohorts[0].roots = evidence.cohorts[0].roots.filter(
          (root) => root.package.product !== 'alpha',
        );
        evidence.cohorts[0].rootConfigurations = evidence.cohorts[0].rootConfigurations.filter(
          (root) => !root.label.includes('/alpha:'),
        );
        evidence.cohorts[0].outputs = evidence.cohorts[0].outputs.filter(
          (output) => !output.path.includes('/alpha/'),
        );
        evidence.cohorts[0].inputs = evidence.cohorts[0].inputs.filter(
          (input) => !input.path.includes('/alpha/'),
        );
      },
    ]) {
      const modified = structuredClone(origin);
      change(modified.evidence);
      await expect(
        captureCompletedNativeProductBaselines(input, {
          ...transports,
          authenticate: async () => modified,
        }),
      ).rejects.toThrow();
    }
  });
});

test('frozen final artifact substitution and remote registry/asset substitution are rejected', async () => {
  await fixture(async ({ input, transports, releases, rehash }) => {
    const substituted = structuredClone(input);
    substituted.publicationLock.carriers[0].artifacts[0] = {
      ...substituted.publicationLock.carriers[0].artifacts[0],
      sha256: '9'.repeat(64),
    };
    rehash(substituted.publicationLock);
    await expect(captureCompletedNativeProductBaselines(substituted, transports)).rejects.toThrow(
      /frozen file envelope/,
    );
    await expect(
      captureCompletedNativeProductBaselines(input, {
        ...transports,
        verifyRegistry: async () => [],
      }),
    ).rejects.toThrow(/incomplete/);
    const wrongAsset = structuredClone(releases);
    wrongAsset[1].assets[0].sha256 = '9'.repeat(64);
    await expect(
      captureCompletedNativeProductBaselines(input, {
        ...transports,
        readGithubReleases: async () => wrongAsset,
      }),
    ).rejects.toThrow(/differs/);
    const draft = structuredClone(releases);
    draft[0].draft = true;
    await expect(
      captureCompletedNativeProductBaselines(input, {
        ...transports,
        readGithubReleases: async () => draft,
      }),
    ).rejects.toThrow(/stable public/);
  });
});

test('immutable completion persistence is idempotent and preserves existing files and safe ancestors', async () => {
  await fixture(async ({ input, transports, directory }) => {
    const output = path.join(directory, 'completed/observations.json');
    const record = await recordCompletedNativeProductBaselines(output, input, transports);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(record);
    await recordCompletedNativeProductBaselines(output, input, transports);
    const before = readFileSync(output);
    const differing = structuredClone(input);
    differing.builds[0].requiredTests = differing.builds[0].requiredTests.slice(0, 1);
    await expect(
      recordCompletedNativeProductBaselines(output, differing, transports),
    ).rejects.toThrow(/non-identical/);
    expect(readFileSync(output)).toEqual(before);
    symlinkSync(path.join(directory, 'completed'), path.join(directory, 'alias'), 'dir');
    await expect(
      recordCompletedNativeProductBaselines(
        path.join(directory, 'alias/other.json'),
        input,
        transports,
      ),
    ).rejects.toThrow(/symlink/);
  });
});

test('CLI rejects historical ref validation in a newer checkout before reading the current catalog', async () => {
  await fixture(async ({ directory }) => {
    const workspace = path.join(directory, 'history');
    mkdirSync(path.join(workspace, 'tools/release'), { recursive: true });
    const wrapper = path.join(workspace, 'tools/release/with-source.sh');
    copyFileSync(path.resolve(import.meta.dir, 'with-source.sh'), wrapper);
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('add', 'tools/release/with-source.sh');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'old publication source',
    );
    const publication = git('rev-parse', 'HEAD');
    writeFileSync(path.join(workspace, 'new-source.txt'), 'unrelated newer source');
    git('add', 'new-source.txt');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'new source',
    );
    let failure;
    try {
      execFileSync(
        'bash',
        [
          wrapper,
          publication,
          process.execPath,
          path.resolve(import.meta.dir, 'completed-native-product-baseline.mts'),
          '--head-ref',
          publication,
          '--lock',
          path.join(workspace, 'does-not-exist.json'),
        ],
        { encoding: 'utf8', stdio: 'pipe', timeout: 90_000 },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure?.status).toBe(1);
    expect(String(failure?.stderr)).toContain('exact publication checkout');
    expect(String(failure?.stderr)).not.toContain('cannot read publication lock');
  });
}, 120_000);
