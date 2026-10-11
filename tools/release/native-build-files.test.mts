import { expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { archiveDirectory } from '../packaging/archive-directory.mts';
import { readPortableArchiveEntries } from '../packaging/portable-archive.mts';
import {
  captureNativeBuildEvidence,
  writeNativeBuildEvidence,
} from './capture-native-build-evidence.mts';
import { fixture } from './completed-native-publication.fixture.mts';
import { readNativeBuildFinalFiles } from './native-build-files.mts';
import {
  captureNativeOutputMembers,
  captureNativePublicationOutputs,
} from './native-publication-staging.mts';
import { ROOT } from './release-graph.mts';

const constraints = (f) => ({
  source: f.origin.evidence.source,
  github: f.origin.evidence.github,
  bazelVersion: f.input.bazelVersion,
});

test('actual packed public files survive transport with exact members and held dependencies', async () => {
  await fixture(async (f) => {
    const directory = path.join(f.directory, 'packet');
    const file = writeNativeBuildEvidence(f.capture, directory);
    const evidence = JSON.parse(readFileSync(file, 'utf8'));
    const packet = readNativeBuildFinalFiles(directory, evidence, constraints(f));
    expect(packet.scope).toBe('construction');
    expect(packet.files).toHaveLength(3);
    expect(packet.unsupported).toEqual([]);
    for (const [index, transferred] of packet.artifactRoots.entries()) {
      const original = path.join(evidence.cohorts[0].executionRoot, packet.files[index].path);
      expect(readFileSync(transferred)).toEqual(readFileSync(original));
      const members = (file) =>
        [...readPortableArchiveEntries(file).values()].map((member) => ({
          name: member.name,
          type: member.type,
          mode: member.mode,
          bytes: member.isFile ? member.data() : undefined,
        }));
      expect(members(transferred)).toEqual(members(original));
      // Actions ZIP normalizes loose transport modes, never packed inner modes.
      chmodSync(transferred, 0o644);
    }
    const npm = packet.artifactRoots.find((file) => file.endsWith('alpha.tgz'));
    const manifest = readPortableArchiveEntries(npm).get('package/package.json');
    expect(JSON.parse(manifest.data().toString()).dependencies).toEqual({
      '@fixture/held-runtime': '=0.3.2',
    });
    expect(readNativeBuildFinalFiles(directory, evidence, constraints(f)).files).toEqual(
      packet.files,
    );
    const staged = captureNativePublicationOutputs(
      evidence.cohorts.map((cohort, index) => ({
        ...cohort,
        executionRoot: path.join(directory, 'files', String(index)),
        roots: cohort.roots.filter(({ package: pkg }) => pkg.ecosystem !== 'internal'),
      })),
      {
        sourceCommit: evidence.source.commit,
        stageDirectory: path
          .relative(ROOT, path.join(f.directory, 'stage'))
          .split(path.sep)
          .join('/'),
      },
    ).stage();
    expect(staged.some((file) => path.basename(path.dirname(file)) === 'release-assets')).toBe(
      true,
    );
    const registry = staged
      .filter((file) => file.endsWith('.tgz'))
      .map((file) =>
        JSON.parse(readPortableArchiveEntries(file).get('package/package.json').data().toString()),
      )
      .sort((left, right) => left.name.localeCompare(right.name));
    expect(registry.map(({ name, version }) => ({ name, version }))).toEqual([
      { name: '@fixture/alpha', version: '1.0.0' },
      { name: '@fixture/beta', version: '2.0.0' },
    ]);
    expect(registry[0].dependencies['@fixture/held-runtime']).toBe('=0.3.2');
  });
});

test('split Cargo public trees preserve exact part ordering, identities and controls without producer sources', async () => {
  await fixture(async (f) => {
    const evidence = structuredClone(f.origin.evidence);
    const cohort = evidence.cohorts[0];
    const root = cohort.roots[0];
    const previous = root.package.outputs[0].path;
    const output = 'bazel-out/k8-opt/bin/alpha/crates';
    const physical = path.join(cohort.executionRoot, output);
    mkdirSync(physical);
    const packages = [];
    for (const part of ['000', '001']) {
      const name = `fixture-runtime-linux-x64-gnu-artifacts-part${part}`;
      const source = path.join(f.directory, name);
      mkdirSync(path.join(source, `${name}-1.0.0`), { recursive: true });
      writeFileSync(
        path.join(source, `${name}-1.0.0/Cargo.toml`),
        `[package]\nname = "${name}"\nversion = "1.0.0"\n`,
      );
      writeFileSync(
        path.join(source, `${name}-1.0.0/artifacts.part`),
        `genuine part bytes ${part}`,
      );
      const archive = path.join(physical, `${name}-1.0.0.crate`);
      await archiveDirectory(source, `${archive}.tar.gz`);
      renameSync(`${archive}.tar.gz`, archive);
      packages.push({ name, file: path.basename(archive) });
    }
    writeFileSync(path.join(physical, 'packages.json'), `${JSON.stringify(packages)}\n`);
    writeFileSync(path.join(physical, 'Cargo.toml'), '[workspace]\n');
    const graph: any = cohort.aquery;
    const fragments = new Map(graph.pathFragments.map((row) => [row.id, row]));
    const resolved = (id) => {
      const row: any = fragments.get(id);
      return row.parentId === undefined ? row.label : `${resolved(row.parentId)}/${row.label}`;
    };
    const artifact = graph.artifacts.find((row) => resolved(row.pathFragmentId) === previous);
    const parts = output.split('/');
    graph.pathFragments.push(
      ...parts.map((label, index) => ({
        id: `parts-${index}`,
        label,
        ...(index ? { parentId: `parts-${index - 1}` } : {}),
      })),
    );
    artifact.pathFragmentId = `parts-${parts.length - 1}`;
    root.package.ecosystem = 'cargo';
    root.package.name = 'fixture-runtime-linux-x64-gnu';
    root.package.outputs[0].path = output;
    const members = captureNativeOutputMembers(cohort.executionRoot, output).members;
    for (const event of cohort.buildEvents as any[]) {
      const files = event.namedSetOfFiles?.files;
      if (!files?.some((file) => file.name === previous)) continue;
      event.namedSetOfFiles.files = files.flatMap((file) =>
        file.name === previous
          ? members
              .filter((member) => member.type === 'file')
              .map((member: any) => ({
                name: `${output}/${member.path}`,
                digest: member.sha256,
                length: String(member.size),
              }))
          : [file],
      );
    }
    const captured = captureNativeBuildEvidence({
      ...constraints(f),
      cohorts: [
        {
          ...cohort,
          cquery: {
            results: cohort.roots.map(({ label }) => ({
              target: { rule: { name: label } },
              configurationId: 1,
            })),
            configurations: [{ id: 1, checksum: cohort.rootConfigurations[0].configuration }],
          },
        },
      ],
    });
    const directory = path.join(f.directory, 'parts-packet');
    const file = writeNativeBuildEvidence(captured, directory);
    const packet = readNativeBuildFinalFiles(
      directory,
      JSON.parse(readFileSync(file, 'utf8')),
      constraints(f),
    );
    const files = packet.artifactRoots.filter((file) => file.includes('/alpha/crates/'));
    expect(files.map((file) => path.basename(file))).toEqual([
      'Cargo.toml',
      ...packages.map(({ file }) => file),
      'packages.json',
    ]);
    const manifest = files.find((file) => file.endsWith('packages.json'));
    expect(JSON.parse(readFileSync(manifest, 'utf8'))).toEqual(packages);
    for (const file of files)
      expect(readFileSync(file)).toEqual(readFileSync(path.join(physical, path.basename(file))));
    expect(packet.artifactRoots.some((file) => file.includes('-source/'))).toBe(false);
  });
});

for (const kind of [
  'tampered',
  'missing',
  'extra',
  'symlink-file',
  'symlink-parent',
  'empty-extra-directory',
])
  test(`rejects ${kind} final bytes independently of an unchanged evidence JSON`, async () => {
    await fixture(async (f) => {
      const directory = path.join(f.directory, 'packet');
      const file = writeNativeBuildEvidence(f.capture, directory);
      const evidence = JSON.parse(readFileSync(file, 'utf8'));
      const packet = readNativeBuildFinalFiles(directory, evidence, constraints(f));
      const target = packet.artifactRoots[0];
      if (kind === 'tampered') writeFileSync(target, 'substituted final archive');
      else if (kind === 'missing') rmSync(target);
      else if (kind === 'extra')
        writeFileSync(path.join(path.dirname(target), 'extra.crate'), 'extra');
      else if (kind === 'empty-extra-directory') mkdirSync(path.join(directory, 'files/empty'));
      else if (kind === 'symlink-file') {
        rmSync(target);
        symlinkSync(path.join(evidence.cohorts[0].executionRoot, packet.files[0].path), target);
      } else {
        rmSync(path.join(directory, 'files/0'), { recursive: true });
        symlinkSync(evidence.cohorts[0].executionRoot, path.join(directory, 'files/0'), 'dir');
      }
      expect(() => readNativeBuildFinalFiles(directory, evidence, constraints(f))).toThrow();
      expect(() => packet.assertUnchanged()).toThrow();
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(evidence);
    });
  });

test('transport cannot substitute source, attempt, root configuration or output path', async () => {
  await fixture(async (f) => {
    const directory = path.join(f.directory, 'packet');
    const file = writeNativeBuildEvidence(f.capture, directory);
    const evidence = JSON.parse(readFileSync(file, 'utf8'));
    const expected = constraints(f);
    for (const mutate of [
      (value) => {
        value.source.commit = 'f'.repeat(40);
      },
      (value) => {
        value.github.runAttempt += 1;
      },
      (value) => {
        value.cohorts[0].rootConfigurations[0].configuration = 'f'.repeat(64);
      },
      (value) => {
        value.cohorts[0].roots[0].package.outputs[0].path = 'bazel-out/../../escape.tgz';
      },
    ]) {
      const changed = structuredClone(evidence);
      mutate(changed);
      expect(() => readNativeBuildFinalFiles(directory, changed, expected)).toThrow();
    }
  });
});

test('internal outputs and source publication inputs remain explicitly outside final-file transport', async () => {
  await fixture(async (f) => {
    const evidence = f.origin.evidence;
    evidence.cohorts[0].roots[0].package.ecosystem = 'internal';
    evidence.cohorts[0].roots[0].package.role = 'construction';
    evidence.cohorts[0].roots[1].package.role = 'release-input';
    const directory = path.join(f.directory, 'packet');
    const file = writeNativeBuildEvidence(f.capture, directory);
    const packet = readNativeBuildFinalFiles(
      directory,
      JSON.parse(readFileSync(file, 'utf8')),
      constraints(f),
    );
    expect(packet.files).toHaveLength(1);
    expect(packet.unsupported).toEqual([
      {
        cohort: 0,
        label: evidence.cohorts[0].roots[1].label,
        reason: 'source publication input transport',
      },
    ]);
    expect(
      packet.files.some(
        ({ path: file }) => file === evidence.cohorts[0].roots[0].package.outputs[0].path,
      ),
    ).toBe(false);
    expect(
      packet.files.some(
        ({ path: file }) => file === evidence.cohorts[0].roots[1].package.outputs[0].path,
      ),
    ).toBe(false);
    expect(packet).not.toHaveProperty('releaseDecision');
  });
});
