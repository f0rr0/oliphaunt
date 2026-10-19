import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fixture as swiftInputs } from '../../build_defs/languages/swift/source-package.fixture.mts';
import { packageSwiftSource } from '../../build_defs/languages/swift/source-package.mts';
import { createDeterministicZip } from '../packaging/archive-directory.mts';
import { extractPortableArchiveTree } from '../packaging/portable-archive.mts';
import {
  captureNativeBuildEvidence,
  writeNativeBuildEvidence,
} from './capture-native-build-evidence.mts';
import { fixture } from './completed-native-publication.fixture.mts';
import { readNativeBuildFinalFiles } from './native-build-files.mts';
import { nativeBuildMetadata } from './native-build-qualification.mts';
import {
  nativeSwiftSourceTagRoots,
  validateNativeSwiftSourceTagFiles,
} from './native-build-source-tag.mts';
import {
  captureNativeInputMembers,
  captureNativeOutputMembers,
} from './native-publication-staging.mts';
import { expectedProductArtifactRows } from './publication-lock.mts';
import { ROOT } from './release-graph.mts';

/** Real package writer and capture boundary; fixture BEP is never claimed to authenticate a build. */
async function sourceFixture(f, rawExecutable = false) {
  const inputs = path.join(f.directory, 'swift-inputs');
  mkdirSync(inputs);
  const spec = await swiftInputs(inputs);
  const executionRoot = f.origin.evidence.cohorts[0].executionRoot;
  const prefix = 'bazel-out/darwin_arm64-opt/bin/src/native/sdks/swift';
  const source = `${prefix}/source_package`;
  await packageSwiftSource(path.join(executionRoot, source), spec);
  const assets = `${prefix}/release-assets`;
  mkdirSync(path.join(executionRoot, assets));
  const bindings = path.basename(spec.bindingsArchive);
  copyFileSync(spec.bindingsArchive, path.join(executionRoot, assets, bindings));
  const checksum = `oliphaunt-swift-${spec.version}-release-assets.sha256`;
  writeFileSync(
    path.join(executionRoot, assets, checksum),
    `${createHash('sha256').update(readFileSync(spec.bindingsArchive)).digest('hex')}  ./${bindings}\n`,
  );
  const executable = `${source}/release-tree/src/sdks/swift/Templates/launch.sh`;
  if (rawExecutable) {
    // Physical executable evidence remains exact; this source publisher still declares Git100644.
    writeFileSync(path.join(executionRoot, executable), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const archive = path.join(executionRoot, source, 'Oliphaunt-source.zip');
    const portable = path.join(f.directory, 'package');
    extractPortableArchiveTree(archive, portable, 'package');
    writeFileSync(path.join(portable, 'Templates/launch.sh'), '#!/bin/sh\nexit 0\n', {
      mode: 0o644,
    });
    writeFileSync(archive, await createDeterministicZip(portable, { keepParent: true }));
  }
  const rows = expectedProductArtifactRows([
    { id: 'oliphaunt-swift', kind: 'sdk', version: spec.version },
  ]);
  const roots = rows.map((row, index) => {
    const output =
      row.role === 'github-release-asset'
        ? `${assets}/${row.name}`
        : row.name === 'release-tree' || row.name === 'oliphaunt-react-native-ios-carriers.json'
          ? `${source}/release-tree`
          : `${source}/${row.name.endsWith('.mjs') || row.name === 'extension-owner-catalog.json' ? 'extension-generator/' : ''}${row.name}`;
    return {
      label: `//src/native/sdks/swift:shipping_${index}`,
      package: {
        product: row.product,
        version: row.version,
        ecosystem: 'github',
        name: row.name,
        configuration: row.target,
        role: row.role,
        outputs: [{ path: output, owner: '//src/native/sdks/swift:source_package' }],
      },
    };
  });
  const outputs = [
    ...new Set(roots.flatMap(({ package: pkg }) => pkg.outputs.map(({ path }) => path))),
  ];
  const configuration = 'd'.repeat(64);
  const aquery = {
    pathFragments: outputs.flatMap((file, index) =>
      file.split('/').map((label, part) => ({
        id: `${index}-${part}`,
        label,
        ...(part ? { parentId: `${index}-${part - 1}` } : {}),
      })),
    ),
    artifacts: outputs.map((file, index) => ({
      id: index + 1,
      pathFragmentId: `${index}-${file.split('/').length - 1}`,
    })),
    targets: [{ id: 1, label: '//src/native/sdks/swift:source_package' }],
    configuration: [{ id: 1, checksum: configuration }],
    depSetOfFiles: [],
    actions: [
      {
        targetId: 1,
        configurationId: 1,
        actionKey: 'fixture-source-envelope',
        mnemonic: 'SourceEnvelope',
        inputDepSetIds: [],
        outputIds: outputs.map((_, index) => index + 1),
        primaryOutputId: 1,
      },
    ],
  };
  const sourceIdentity = f.origin.evidence.source;
  const github = f.origin.evidence.github;
  const buildEvents = [
    {
      id: { started: {} },
      started: { uuid: 'fixture-source-envelope', buildToolVersion: '8.8.1' },
    },
    { id: { workspace: {} }, workspaceInfo: { localExecRoot: executionRoot } },
    {
      id: { configuration: { id: configuration } },
      configuration: { mnemonic: 'darwin_arm64-opt' },
    },
    ...roots.flatMap((root, index) => {
      const output = root.package.outputs[0].path;
      const members = captureNativeOutputMembers(executionRoot, output).members;
      return [
        {
          id: { namedSet: { id: String(index) } },
          namedSetOfFiles: {
            files: members
              .filter((member) => member.type === 'file')
              .map((member: any) => ({
                name: member.path ? `${output}/${member.path}` : output,
                digest: member.sha256,
                length: String(member.size),
              })),
          },
        },
        {
          id: { targetCompleted: { label: root.label, configuration: { id: configuration } } },
          completed: {
            success: true,
            outputGroup: [{ name: 'default', fileSets: [{ id: String(index) }] }],
          },
        },
      ];
    }),
    {
      id: { buildMetadata: {} },
      buildMetadata: { metadata: nativeBuildMetadata(sourceIdentity, github) },
    },
    { id: { buildFinished: {} }, finished: { exitCode: { name: 'SUCCESS' } } },
    { id: { buildMetrics: {} }, buildMetrics: {}, lastMessage: true },
  ];
  const cquery = {
    results: roots.map(({ label }) => ({ target: { rule: { name: label } }, configurationId: 17 })),
    configurations: [{ id: 17, checksum: configuration }],
  };
  const capture = () => {
    const observedEvents = structuredClone(buildEvents);
    for (const [index, root] of roots.entries()) {
      const output = root.package.outputs[0].path;
      observedEvents.find(({ id }) => id.namedSet?.id === String(index)).namedSetOfFiles.files =
        captureNativeOutputMembers(executionRoot, output)
          .members.filter((member) => member.type === 'file')
          .map((member: any) => ({
            name: member.path ? `${output}/${member.path}` : output,
            digest: member.sha256,
            length: String(member.size),
          }));
    }
    return captureNativeBuildEvidence({
      source: sourceIdentity,
      github,
      bazelVersion: '8.8.1',
      cohorts: [{ executionRoot, roots, cquery, aquery, buildEvents: observedEvents }],
    });
  };
  return {
    spec,
    capture,
    executionRoot,
    source,
    executable,
    expected: { source: sourceIdentity, github, bazelVersion: '8.8.1' },
  };
}

test('complete Swift source tag transfers once with exact raw modes and canonical publication modes', async () => {
  await fixture(async (f) => {
    const s = await sourceFixture(f, true);
    const captured = s.capture();
    const directory = path.join(f.directory, 'source-packet');
    const evidence = JSON.parse(
      readFileSync(writeNativeBuildEvidence(captured, directory), 'utf8'),
    );
    const packet = readNativeBuildFinalFiles(directory, evidence, s.expected);
    expect(packet.scope).toBe('construction');
    expect(packet.unsupported).toEqual([]);
    const tree = evidence.cohorts[0].outputs.find(
      ({ path }) => path === `${s.source}/release-tree`,
    );
    const treeFiles = tree.members.filter(({ type }) => type === 'file');
    expect(
      packet.files.filter(({ path: name }) => name.startsWith(`${s.source}/release-tree/`)),
    ).toHaveLength(treeFiles.length);
    for (const file of packet.artifactRoots) chmodSync(file, 0o644);
    const normalized = readNativeBuildFinalFiles(directory, evidence, s.expected);
    const stageDirectory = path
      .relative(ROOT, path.join(f.directory, 'source-stage'))
      .split(path.sep)
      .join('/');
    const staged = normalized.stage({ stageDirectory });
    expect(normalized.stage({ stageDirectory })).toEqual(staged);
    // A later mutation of the caller's JSON cannot relabel the captured staging identity.
    evidence.source.commit = 'f'.repeat(40);
    evidence.github.runAttempt += 1;
    evidence.cohorts[0].rootConfigurations[0].configuration = 'f'.repeat(64);
    expect(normalized.stage({ stageDirectory })).toEqual(staged);
    const stagedTree = staged.find((name) => path.basename(name) === 'release-tree');
    const observed = captureNativeOutputMembers(
      path.join(directory, 'files/0'),
      `${s.source}/release-tree`,
    ).members;
    expect(observed.find(({ path }) => path.endsWith('launch.sh')).mode).toBe(0o644);
    const stagingRoot = path.resolve(ROOT, stageDirectory);
    const relativeTree = path.relative(stagingRoot, stagedTree).split(path.sep).join('/');
    expect(tree.members.find(({ path }) => path.endsWith('launch.sh')).mode).toBe(0o755);
    expect(captureNativeInputMembers(stagingRoot, relativeTree).members).toEqual(
      tree.members.map((member) => ({ ...member, mode: member.type === 'file' ? 0o644 : 0o755 })),
    );
    for (const member of treeFiles) {
      expect(readFileSync(path.join(stagedTree, member.path))).toEqual(
        readFileSync(path.join(s.executionRoot, tree.path, member.path)),
      );
    }
    expect(readFileSync(path.join(stagedTree, 'Package.swift'))).toEqual(
      readFileSync(staged.find((name) => path.basename(name) === 'Package.swift.release')),
    );
    expect(
      readFileSync(path.join(stagedTree, 'src/sdks/swift/LIBOLIPHAUNT_VERSION'), 'utf8').trim(),
    ).toBe(s.spec.nativeVersion);
    expect(packet).not.toHaveProperty('releaseDecision');
    const assetsOnly = normalized.stage({
      excludeRoles: ['release-input'],
      stageDirectory: `${stageDirectory}-assets`,
    });
    expect(assetsOnly).toHaveLength(2);
    expect(assetsOnly.some((file) => path.basename(file) === 'release-tree')).toBe(false);
  });
});

for (const fault of ['removed', 'extra', 'changed', 'mode'])
  test(`source ZIP qualification rejects a genuinely captured ${fault} source-tag representation`, async () => {
    await fixture(async (f) => {
      const s = await sourceFixture(f);
      const source = path.join(
        s.executionRoot,
        s.source,
        'release-tree/src/sdks/swift/Sources/Oliphaunt/Oliphaunt.swift',
      );
      if (fault === 'removed') rmSync(source);
      if (fault === 'changed') writeFileSync(source, '// changed source tag only\n');
      if (fault === 'extra')
        writeFileSync(path.join(path.dirname(source), 'extra.swift'), '// extra source tag only\n');
      if (fault === 'mode') {
        const archive = path.join(s.executionRoot, s.source, 'Oliphaunt-source.zip');
        const packaged = path.join(f.directory, 'executable-source-zip', 'package');
        extractPortableArchiveTree(archive, packaged, 'package');
        chmodSync(path.join(packaged, 'Sources/Oliphaunt/Oliphaunt.swift'), 0o755);
        writeFileSync(archive, await createDeterministicZip(packaged, { keepParent: true }));
      }
      const captured = s.capture();
      expect(() =>
        validateNativeSwiftSourceTagFiles(captured.evidence, (_, output) =>
          path.join(s.executionRoot, output),
        ),
      ).toThrow('shared delivered members differ');
      const directory = path.join(f.directory, 'source-packet');
      expect(() => writeNativeBuildEvidence(captured, directory)).toThrow(
        'shared delivered members differ',
      );
      expect(existsSync(path.join(directory, 'native-build-evidence.json'))).toBe(false);
    });
  });

for (const kind of [
  'missing-manifest',
  'missing-canonical-root',
  'owner-version',
  'held-version',
  'manifest-supplier',
  'duplicate-root',
  'configuration',
  'tree-carrier-substitution',
  'traversal',
])
  test(`rejects source-tag ${kind} before packet completion`, async () => {
    await fixture(async (f) => {
      const s = await sourceFixture(f);
      const captured = s.capture();
      const evidence = structuredClone(captured.evidence);
      const cohort = evidence.cohorts[0];
      if (kind === 'duplicate-root') cohort.roots.push(structuredClone(cohort.roots[0]));
      else if (kind === 'missing-canonical-root')
        cohort.roots = cohort.roots.filter(
          ({ package: pkg }) => pkg.name !== 'Package.swift.release',
        );
      else if (kind === 'configuration') cohort.roots[0].package.configuration = 'windows-x64';
      else if (kind === 'tree-carrier-substitution')
        cohort.roots.find(
          ({ package: pkg }) => pkg.name === 'oliphaunt-react-native-ios-carriers.json',
        ).package.outputs[0].path = cohort.roots[0].package.outputs[0].path;
      else if (kind === 'traversal')
        cohort.outputs
          .find(({ path }) => path.endsWith('/release-tree'))
          .members.push({
            path: '../outside',
            type: 'file',
            mode: 0o644,
            size: 1,
            sha256: 'a'.repeat(64),
          });
      else {
        const relative =
          kind === 'missing-manifest' || kind === 'manifest-supplier'
            ? 'Package.swift'
            : `src/sdks/swift/${kind === 'owner-version' ? 'VERSION' : 'LIBOLIPHAUNT_VERSION'}`;
        const target = path.join(s.executionRoot, s.source, 'release-tree', relative);
        if (kind === 'missing-manifest') rmSync(target);
        else
          writeFileSync(
            target,
            kind === 'manifest-supplier'
              ? readFileSync(target, 'utf8').replaceAll(
                  'liboliphaunt-native-v0.3.3',
                  'liboliphaunt-native-v0.3.4',
                )
              : '9.9.9\n',
          );
      }
      if (
        [
          'duplicate-root',
          'missing-canonical-root',
          'configuration',
          'tree-carrier-substitution',
        ].includes(kind)
      )
        expect(() => nativeSwiftSourceTagRoots(cohort)).toThrow();
      else if (kind === 'traversal')
        expect(() =>
          readNativeBuildFinalFiles(path.join(f.directory, 'unused'), evidence, s.expected),
        ).toThrow('unsafe native build path');
      else
        expect(() =>
          validateNativeSwiftSourceTagFiles(evidence, (_, output) =>
            path.join(s.executionRoot, output),
          ),
        ).toThrow();
      const directory = path.join(f.directory, 'rejected-packet');
      expect(() => writeNativeBuildEvidence({ ...captured, evidence }, directory)).toThrow();
      expect(existsSync(path.join(directory, 'evidence.json'))).toBe(false);
    });
  });

test('source tree transport rejects post-capture bytes and unsafe mode restoration without changing downloaded files', async () => {
  await fixture(async (f) => {
    const s = await sourceFixture(f, true);
    const directory = path.join(f.directory, 'source-packet');
    const evidence = JSON.parse(
      readFileSync(writeNativeBuildEvidence(s.capture(), directory), 'utf8'),
    );
    const packet = readNativeBuildFinalFiles(directory, evidence, s.expected);
    const manifest = packet.artifactRoots.find((name) =>
      name.endsWith('/release-tree/Package.swift'),
    );
    const original = readFileSync(manifest);
    writeFileSync(manifest, `${original.toString()}// substituted\n`);
    expect(() => readNativeBuildFinalFiles(directory, evidence, s.expected)).toThrow(
      'native final transport bytes',
    );
    expect(() => packet.stage()).toThrow();
    writeFileSync(manifest, original);
    const changed = structuredClone(evidence);
    changed.cohorts[0].outputs
      .find(({ path }) => path.endsWith('/release-tree'))
      .members.find(({ path }) => path.endsWith('launch.sh')).mode = 0o777;
    expect(() => readNativeBuildFinalFiles(directory, changed, s.expected).stage()).toThrow(
      'unsafe captured mode',
    );
    expect(statSync(manifest).mode & 0o777).toBe(0o644);
  });
});

test('readonly declared Swift source trees retain raw evidence and stage canonical publisher modes', async () => {
  await fixture(async (f) => {
    // The actual source writer creates0644 files. Stock Bazel8.8.1 makes every
    // TreeArtifact member0555 after both cold execution and disk restoration.
    const s = await sourceFixture(f);
    const treePath = `${s.source}/release-tree`;
    const physical = captureNativeOutputMembers(s.executionRoot, treePath).members;
    try {
      for (const member of physical)
        chmodSync(path.join(s.executionRoot, treePath, member.path), 0o555);
      const captured = s.capture();
      const original = JSON.stringify(captured.evidence);
      const raw = captured.evidence.cohorts[0].outputs.find(({ path }) => path === treePath);
      expect(raw.members.every(({ mode }) => mode === 0o555)).toBe(true);
      const directory = path.join(f.directory, 'readonly-source-packet');
      const evidence = JSON.parse(
        readFileSync(writeNativeBuildEvidence(captured, directory), 'utf8'),
      );
      const packet = readNativeBuildFinalFiles(directory, evidence, s.expected);
      const stageDirectory = path
        .relative(ROOT, path.join(f.directory, 'readonly-source-stage'))
        .split(path.sep)
        .join('/');
      const staged = packet.stage({ stageDirectory });
      const tree = staged.find((file) => path.basename(file) === 'release-tree');
      const stagedMembers = captureNativeInputMembers(
        path.dirname(tree),
        path.basename(tree),
      ).members;
      expect(stagedMembers.map(({ mode, ...member }) => member)).toEqual(
        raw.members.map(({ mode, ...member }) => member),
      );
      expect(
        stagedMembers.every(({ type, mode }) => mode === (type === 'file' ? 0o644 : 0o755)),
      ).toBe(true);
      expect(JSON.stringify(captured.evidence)).toBe(original);
      expect(evidence.cohorts[0].outputs.find(({ path }) => path === treePath).members).toEqual(
        raw.members,
      );
      expect(captureNativeOutputMembers(s.executionRoot, treePath).members).toEqual(raw.members);
      captured.assertUnchanged();
      const version = path.join(s.executionRoot, treePath, 'src/sdks/swift/VERSION');
      chmodSync(version, 0o444);
      expect(() => captured.assertUnchanged()).toThrow('changed after capture');
      chmodSync(version, 0o555);
    } finally {
      // Restore only fixture-owned permissions so cleanup cannot mask the assertion.
      for (const member of physical)
        chmodSync(
          path.join(s.executionRoot, treePath, member.path),
          member.type === 'file' ? 0o644 : 0o755,
        );
    }
  });
});
