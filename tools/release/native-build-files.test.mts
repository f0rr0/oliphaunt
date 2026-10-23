import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  captureSeedConstructionIntent,
  writeSeedConstructionReceipt,
} from '../../build_defs/resources/seed_construction.mts';
import { archiveDirectory } from '../packaging/archive-directory.mts';
import { readPortableArchiveEntries } from '../packaging/portable-archive.mts';
import { removeOwnedDirectory } from '../packaging/release-directory-safety.mts';
import {
  captureNativeBuildEvidence,
  writeNativeBuildEvidence,
} from './capture-native-build-evidence.mts';
import { fixture } from './completed-native-publication.fixture.mts';
import {
  readNativeBuildFinalFiles,
  readNativeBuildFinalFilesBatch,
} from './native-build-files.mts';
import {
  captureNativeInputMembers,
  captureNativeOutputMembers,
  captureNativePublicationOutputs,
  NATIVE_EXTENSION_RELEASE_INPUT_ROLES,
} from './native-publication-staging.mts';
import { ROOT } from './release-graph.mts';

const constraints = (f) => ({
  source: f.origin.evidence.source,
  github: f.origin.evidence.github,
  bazelVersion: f.input.bazelVersion,
});

test('file staging CLI binds source and producer before reconstructing captured public files', async () => {
  await fixture(
    async (f) => {
      const directory = path.join(f.directory, 'cli-packet');
      writeNativeBuildEvidence(f.capture, directory);
      const github = path.join(f.directory, 'github.json');
      writeFileSync(github, JSON.stringify(f.origin.evidence.github));
      const argv = [
        path.join(ROOT, 'tools/release/native-build-files.mts'),
        '--evidence-root',
        directory,
        '--source-commit',
        f.origin.evidence.source.commit,
        '--source-tree',
        f.origin.evidence.source.tree,
        '--github-json',
        github,
        '--output-directory',
        path.relative(ROOT, path.join(f.directory, 'cli-stage')).split(path.sep).join('/'),
      ];
      const invoke = (args: string[]) => spawnSync(process.execPath, args, { encoding: 'utf8' });
      const accepted = invoke(argv);
      expect(accepted.stderr).toBe('');
      expect(accepted.status).toBe(0);
      const staged = JSON.parse(accepted.stdout);
      expect(staged).toHaveLength(3);
      for (const file of staged) expect(readFileSync(file).length).toBeGreaterThan(0);
      const differentSource = [...argv];
      differentSource[differentSource.indexOf('--source-tree') + 1] = 'f'.repeat(40);
      const rejected = invoke(differentSource);
      expect(rejected.status).toBe(1);
      expect(rejected.stdout).toBe('');
      expect(rejected.stderr).toContain('source');
      expect(invoke([...argv, '--allow-dirty']).status).toBe(1);
    },
    { producerCapture: true },
  );
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

test('packet copies independently verify both physical transports against the same evidence', async () => {
  await fixture(async (f) => {
    const first = path.join(f.directory, 'first-packet');
    const file = writeNativeBuildEvidence(f.capture, first);
    const second = path.join(f.directory, 'second-packet');
    cpSync(first, second, { recursive: true });
    const evidence = JSON.parse(readFileSync(file, 'utf8'));
    const directories = [first, second];
    const packets = readNativeBuildFinalFilesBatch(directories, evidence, constraints(f));
    expect(packets).toHaveLength(2);
    expect(packets[0].files).toEqual(packets[1].files);
    for (const packet of packets) {
      expect(packet.qualification.source).toEqual(evidence.source);
      const target = packet.artifactRoots[0];
      const original = readFileSync(target);
      writeFileSync(target, 'corrupted transport copy');
      expect(() => readNativeBuildFinalFilesBatch(directories, evidence, constraints(f))).toThrow(
        'native final transport bytes',
      );
      writeFileSync(target, original);
    }
    writeFileSync(path.join(second, 'files', 'unexpected'), 'extra transport file');
    expect(() => readNativeBuildFinalFilesBatch(directories, evidence, constraints(f))).toThrow(
      'native final file transport inventory',
    );
  });
});

test('packet copies reject malformed evidence and a different expected source', async () => {
  await fixture(async (f) => {
    const first = path.join(f.directory, 'qualified-packet');
    const file = writeNativeBuildEvidence(f.capture, first);
    const second = path.join(f.directory, 'qualified-copy');
    cpSync(first, second, { recursive: true });
    const evidence = JSON.parse(readFileSync(file, 'utf8'));
    expect(() =>
      readNativeBuildFinalFilesBatch(
        [first, second],
        { ...evidence, schema: 'invalid' },
        constraints(f),
      ),
    ).toThrow('unsupported native build evidence');
    expect(() =>
      readNativeBuildFinalFilesBatch([first, second], evidence, {
        ...constraints(f),
        source: { ...evidence.source, tree: 'f'.repeat(40) },
      }),
    ).toThrow('native build source mismatch');
  });
});

test('selected File staging preserves source bytes while leaving other public products outside the release directory', async () => {
  await fixture(async (f) => {
    const directory = path.join(f.directory, 'selected-packet');
    const file = writeNativeBuildEvidence(f.capture, directory);
    const evidence = JSON.parse(readFileSync(file, 'utf8'));
    const packet = readNativeBuildFinalFiles(directory, evidence, constraints(f));
    const selected = packet.stage({
      products: ['alpha'],
      stageDirectory: path
        .relative(ROOT, path.join(f.directory, 'selected-alpha'))
        .split(path.sep)
        .join('/'),
    });
    const registry = selected
      .filter((file) => file.endsWith('.tgz'))
      .map((file) =>
        JSON.parse(readPortableArchiveEntries(file).get('package/package.json').data().toString()),
      );
    expect(registry.map(({ name }) => name)).toEqual(['@fixture/alpha']);
    expect(registry[0].dependencies).toEqual({ '@fixture/held-runtime': '=0.3.2' });
    const together = packet.stage({
      products: ['alpha', 'beta'],
      stageDirectory: path
        .relative(ROOT, path.join(f.directory, 'selected-both'))
        .split(path.sep)
        .join('/'),
    });
    expect(together.filter((file) => file.endsWith('.tgz'))).toHaveLength(2);
    expect(() => packet.stage({ products: ['unobserved'] })).toThrow(/observed product/);
    expect(() => packet.stage({ products: ['alpha', 'alpha'] })).toThrow(/unique observed/);
    packet.assertUnchanged();
  });
});

for (const windowsRoot of [
  undefined,
  'C:\\b\\execroot\\_main',
  '\\\\server\\share\\execroot\\_main',
])
  test(`split Cargo public trees preserve parts and modes from ${windowsRoot ?? 'POSIX'} producers`, async () => {
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
        const executable = path.join(source, `${name}-1.0.0/launch.sh`);
        writeFileSync(executable, '#!/bin/sh\nexit 0\n');
        chmodSync(executable, 0o755);
        const archive = path.join(physical, `${name}-1.0.0.crate`);
        await archiveDirectory(source, `${archive}.tar.gz`);
        renameSync(`${archive}.tar.gz`, archive);
        packages.push({ name, file: path.basename(archive) });
      }
      writeFileSync(path.join(physical, 'packages.json'), `${JSON.stringify(packages)}\n`);
      writeFileSync(path.join(physical, 'Cargo.toml'), '[workspace]\n');
      const empty = path.join(physical, 'read-only-empty');
      mkdirSync(empty);
      mkdirSync(path.join(physical, 'nested/empty'), { recursive: true });
      writeFileSync(path.join(physical, 'nested/control.json'), '{}\n');
      chmodSync(empty, 0o555);
      chmodSync(physical, 0o500);
      const treeMode = statSync(physical).mode & 0o777;
      const emptyMode = statSync(empty).mode & 0o777;
      const nestedMode = statSync(path.join(physical, 'nested/empty')).mode & 0o777;
      const controlMode = statSync(path.join(physical, 'nested/control.json')).mode & 0o777;
      const stagedDirectory = path.join(f.directory, 'read-only-stage');
      try {
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
        graph.pathFragments.push({
          id: 'parts-nested',
          label: 'nested',
          parentId: artifact.pathFragmentId,
        });
        graph.artifacts.push({ ...artifact, id: 'parts-nested', pathFragmentId: 'parts-nested' });
        graph.actions
          .find((action) => action.outputIds.includes(artifact.id))
          .outputIds.push('parts-nested');
        root.package.ecosystem = 'cargo';
        root.package.name = 'fixture-runtime-linux-x64-gnu';
        root.package.outputs[0].path = output;
        root.package.outputs.push({ ...root.package.outputs[0], path: `${output}/nested` });
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
        const transported = JSON.parse(readFileSync(file, 'utf8'));
        if (windowsRoot) {
          // Simulate Windows stat metadata around genuine transported opaque archives.
          transported.cohorts[0].executionRoot = windowsRoot;
          transported.cohorts[0].buildEvents.find(
            (event) => event.workspaceInfo,
          ).workspaceInfo.localExecRoot = windowsRoot;
          for (const output of transported.cohorts[0].outputs)
            for (const member of output.members) member.mode = 0o666;
          writeFileSync(file, JSON.stringify(transported));
        }
        const originalEvidence = readFileSync(file);
        const originalMetadata = structuredClone(transported);
        const transportMembers = captureNativeInputMembers(directory, 'files').members;
        const packet = readNativeBuildFinalFiles(directory, transported, constraints(f));
        const files = packet.artifactRoots.filter((file) => file.includes('/alpha/crates/'));
        expect(files.map((file) => path.basename(file))).toEqual([
          'Cargo.toml',
          ...packages.map(({ file }) => file),
          'control.json',
          'packages.json',
        ]);
        const manifest = files.find((file) => file.endsWith('packages.json'));
        expect(JSON.parse(readFileSync(manifest, 'utf8'))).toEqual(packages);
        for (const file of files)
          expect(readFileSync(file)).toEqual(
            readFileSync(path.join(physical, file.split('/alpha/crates/')[1])),
          );
        expect(packet.artifactRoots.some((file) => file.includes('-source/'))).toBe(false);
        const staged = packet.stage({
          stageDirectory: path.relative(ROOT, stagedDirectory).split(path.sep).join('/'),
        });
        const tree = staged.find((file) => path.basename(file) === 'crates');
        if (!tree) throw new Error('staged Cargo Tree is missing');
        expect(statSync(tree).mode & 0o777).toBe(windowsRoot ? 0o755 : treeMode);
        expect(statSync(path.join(tree, 'read-only-empty')).mode & 0o777).toBe(
          windowsRoot ? 0o755 : emptyMode,
        );
        expect(statSync(path.join(tree, 'nested/empty')).mode & 0o777).toBe(
          windowsRoot ? 0o755 : nestedMode,
        );
        expect(statSync(path.join(tree, 'nested/control.json')).mode & 0o777).toBe(
          windowsRoot ? 0o644 : controlMode,
        );
        for (const { name, file } of packages) {
          const staged = path.join(tree, file);
          expect(readFileSync(staged)).toEqual(readFileSync(path.join(physical, file)));
          expect(readPortableArchiveEntries(staged).get(`${name}-1.0.0/launch.sh`)?.mode).toBe(
            0o755,
          );
        }
        expect(readFileSync(file)).toEqual(originalEvidence);
        expect(transported).toEqual(originalMetadata);
        expect(captureNativeInputMembers(directory, 'files').members).toEqual(transportMembers);
        if (windowsRoot) {
          const conflicting = structuredClone(transported);
          conflicting.cohorts[0].outputs.find(
            ({ path }) => path === `${output}/nested`,
          ).members[0].mode = 0o444;
          expect(() =>
            readNativeBuildFinalFiles(directory, conflicting, constraints(f)).stage(),
          ).toThrow('native overlapping reconstructed members');
        } else {
          for (const executionRoot of [cohort.executionRoot, '//server/share/execroot']) {
            const unsafe = structuredClone(transported);
            unsafe.cohorts[0].executionRoot = executionRoot;
            unsafe.cohorts[0].buildEvents.find(
              (event) => event.workspaceInfo,
            ).workspaceInfo.localExecRoot = executionRoot;
            unsafe.cohorts[0].outputs.find(({ path }) => path === output).members[0].mode = 0o666;
            expect(() =>
              readNativeBuildFinalFiles(directory, unsafe, constraints(f)).stage(),
            ).toThrow('unsafe captured mode');
          }
          for (const mode of [0o666, 0o775]) {
            const unsafe = structuredClone(transported);
            unsafe.cohorts[0].outputs.find(({ path }) =>
              path.endsWith('/beta.tgz'),
            ).members[0].mode = mode;
            expect(() =>
              readNativeBuildFinalFiles(directory, unsafe, constraints(f)).stage(),
            ).toThrow('unsafe captured mode');
          }
        }
        expect(captureNativeOutputMembers(cohort.executionRoot, output).members).toEqual(members);
        packet.assertUnchanged();
        removeOwnedDirectory(stagedDirectory);
        expect(existsSync(stagedDirectory)).toBe(false);
        expect(statSync(physical).mode & 0o777).toBe(treeMode);
        expect(statSync(empty).mode & 0o777).toBe(emptyMode);
      } finally {
        if (existsSync(stagedDirectory)) removeOwnedDirectory(stagedDirectory);
        chmodSync(physical, 0o755);
        chmodSync(empty, 0o755);
      }
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

test('extension join documents survive final transport and owned staging without public identities', async () => {
  await fixture(async (f) => {
    const evidence = f.origin.evidence;
    const roots = evidence.cohorts[0].roots;
    const documents = [roots[0], roots[1], roots[3]];
    for (const [index, role] of NATIVE_EXTENSION_RELEASE_INPUT_ROLES.entries()) {
      documents[index].package.ecosystem = 'internal';
      documents[index].package.role = role;
    }
    const directory = path.join(f.directory, 'join-packet');
    const file = writeNativeBuildEvidence(f.capture, directory);
    const packet = readNativeBuildFinalFiles(
      directory,
      JSON.parse(readFileSync(file, 'utf8')),
      constraints(f),
    );
    expect(packet.files).toHaveLength(3);
    expect(packet.unsupported).toEqual([]);
    const staged = packet.stage({
      stageDirectory: path
        .relative(ROOT, path.join(f.directory, 'join-stage'))
        .split(path.sep)
        .join('/'),
    });
    expect(staged).toHaveLength(3);
    for (const root of documents) {
      const original = path.join(evidence.cohorts[0].executionRoot, root.package.outputs[0].path);
      const transferred = staged.find((file) => path.basename(file) === path.basename(original));
      expect(transferred).toBeDefined();
      expect(readFileSync(transferred)).toEqual(readFileSync(original));
    }
    expect(roots.every(({ package: pkg }) => pkg.ecosystem === 'internal')).toBe(true);
    expect(packet.stage({ excludeRoles: NATIVE_EXTENSION_RELEASE_INPUT_ROLES })).toEqual([]);
    expect(packet.files).toHaveLength(3);
    expect(packet).not.toHaveProperty('releaseDecision');
  });
});

test('declared regular release inputs survive exact final transport and staging', async () => {
  await fixture(async (f) => {
    const evidence = f.origin.evidence;
    const root = evidence.cohorts[0].roots[1];
    Object.assign(root.package, {
      ecosystem: 'github',
      name: 'beta.tgz',
      role: 'release-input',
    });
    const declared = root.package.outputs[0].path;
    const original = readFileSync(path.join(evidence.cohorts[0].executionRoot, declared));
    const directory = path.join(f.directory, 'release-input-packet');
    const file = writeNativeBuildEvidence(f.capture, directory);
    const captured = JSON.parse(readFileSync(file, 'utf8'));
    const packet = readNativeBuildFinalFiles(directory, captured, constraints(f));
    expect(packet.unsupported).toEqual([]);
    expect(packet.files.some(({ path }) => path === declared)).toBe(true);
    const transferred = packet.file(0, declared);
    expect(readFileSync(transferred)).toEqual(original);
    const staged = packet.stage({
      stageDirectory: path
        .relative(ROOT, path.join(f.directory, 'release-input-stage'))
        .split(path.sep)
        .join('/'),
    });
    const stagedInput = staged.find((file) => file.endsWith('/beta/beta.tgz'));
    expect(stagedInput).toBeDefined();
    expect(readFileSync(stagedInput)).toEqual(original);
    expect(packet).not.toHaveProperty('releaseDecision');
    writeFileSync(transferred, 'substituted release input');
    expect(() => packet.assertUnchanged()).toThrow();
    expect(() => readNativeBuildFinalFiles(directory, captured, constraints(f))).toThrow(/bytes/);
    expect(readFileSync(path.join(evidence.cohorts[0].executionRoot, declared))).toEqual(original);
  });
});

test('producer internals and unsupported source publication trees stay outside final-file transport', async () => {
  await fixture(async (f) => {
    const evidence = f.origin.evidence;
    evidence.cohorts[0].roots[0].package.ecosystem = 'internal';
    evidence.cohorts[0].roots[0].package.role = 'construction';
    evidence.cohorts[0].roots[1].package.ecosystem = 'swift';
    evidence.cohorts[0].roots[2].package.ecosystem = 'github';
    evidence.cohorts[0].roots[2].package.role = 'release-input';
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
      {
        cohort: 0,
        label: evidence.cohorts[0].roots[2].label,
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
    expect(
      packet.files.some(
        ({ path: file }) => file === evidence.cohorts[0].roots[2].package.outputs[0].path,
      ),
    ).toBe(false);
    expect(packet).not.toHaveProperty('releaseDecision');
  });
});

test('the exact private Apple basis transports real bytes and excludes unrelated internal roots', async () => {
  await fixture(async (f) => {
    const cohort = f.origin.evidence.cohorts[0];
    const root = cohort.roots[0];
    const previousLabel = root.label;
    const previousPath = root.package.outputs[0].path;
    const output = 'bazel-out/k8-opt/bin/src/native/runtime/apple_release_assets/ios.json';
    const contents = Buffer.from('{"schema":"controlled-Apple-basis-fixture"}\n');
    mkdirSync(path.dirname(path.join(cohort.executionRoot, output)), { recursive: true });
    writeFileSync(path.join(cohort.executionRoot, output), contents);
    root.label = '//src/native/runtime:apple_ios_manifest_shipping';
    Object.assign(root.package, {
      product: 'liboliphaunt-native',
      ecosystem: 'internal',
      name: 'ios.json',
      configuration: 'ios-xcframework',
      role: 'apple-base-ios-manifest-input',
    });
    root.package.outputs[0].path = output;
    cohort.rootConfigurations.find(({ label }) => label === previousLabel).label = root.label;
    cohort.outputs.find(({ path: name }) => name === previousPath).path = output;
    cohort.outputs.find(({ path: name }) => name === output).members = captureNativeOutputMembers(
      cohort.executionRoot,
      output,
    ).members;
    const graph = cohort.aquery as any;
    const previous = new Map(graph.pathFragments.map((part) => [String(part.id), part]));
    const resolve = (id: unknown): string => {
      const part = previous.get(String(id)) as any;
      return part.parentId ? `${resolve(part.parentId)}/${part.label}` : part.label;
    };
    const artifact = graph.artifacts.find(
      ({ pathFragmentId }) => resolve(pathFragmentId) === previousPath,
    );
    const parts = output.split('/');
    graph.pathFragments.push(
      ...parts.map((label, index) => ({
        id: `apple-${index}`,
        label,
        ...(index ? { parentId: `apple-${index - 1}` } : {}),
      })),
    );
    artifact.pathFragmentId = `apple-${parts.length - 1}`;
    for (const event of cohort.buildEvents as any[]) {
      if (event.id?.targetCompleted?.label === previousLabel)
        event.id.targetCompleted.label = root.label;
      for (const file of event.namedSetOfFiles?.files ?? [])
        if (file.name === previousPath)
          Object.assign(file, {
            name: output,
            length: String(contents.length),
            digest: cohort.outputs.find(({ path: name }) => name === output).members[0].sha256,
          });
    }
    const directory = path.join(f.directory, 'private-apple-packet');
    const evidenceFile = writeNativeBuildEvidence(f.capture, directory);
    const evidence = JSON.parse(readFileSync(evidenceFile, 'utf8'));
    const packet = readNativeBuildFinalFiles(directory, evidence, constraints(f));
    const transferred = packet.artifactRoots.find((file) =>
      file.endsWith('/apple_release_assets/ios.json'),
    );
    expect(readFileSync(transferred)).toEqual(contents);
    expect(packet).not.toHaveProperty('releaseDecision');
    writeFileSync(transferred, 'substituted private Apple basis');
    expect(() => readNativeBuildFinalFiles(directory, evidence, constraints(f))).toThrow(/bytes/);
  });
});

test('exact reached seed TAR and receipt survive internal transport without entering public artifact roots', async () => {
  await fixture(async (f) => {
    const cohort = f.origin.evidence.cohorts[0];
    const graph = cohort.aquery as any;
    const frozen = 'bazel-out/k8-opt/bin/seed.tar';
    const receipt = 'bazel-out/k8-opt/bin/seed.seed-construction.json';
    writeFileSync(
      path.join(cohort.executionRoot, frozen),
      'exact original constructor TAR fixture',
    );
    const pgdata = path.join(f.directory, 'fixture-pgdata');
    const contract = JSON.parse(
      readFileSync(path.join(ROOT, 'src/database-resources/contracts/contract.json'), 'utf8'),
    );
    for (const name of contract.pgdataDirectories)
      mkdirSync(path.join(pgdata, name), { recursive: true });
    writeFileSync(path.join(pgdata, 'PG_VERSION'), '18\n');
    const input = cohort.inputs.find((input) => !input.path.startsWith('bazel-out/'));
    if (!input) throw new Error('seed transport fixture needs a source File');
    const intent = captureSeedConstructionIntent(
      { family: 'native', target: 'linux-x64-gnu', profile: 'standard' },
      { command: 'fixture-initdb' },
      { constructor: path.join(cohort.executionRoot, input.path) },
    );
    writeSeedConstructionReceipt(
      path.join(cohort.executionRoot, receipt),
      intent,
      path.join(cohort.executionRoot, frozen),
      pgdata,
    );
    const ids = [frozen, receipt].map((file, offset) => {
      const id = graph.artifacts.length + 1;
      const parts = file.split('/');
      for (const [part, label] of parts.entries())
        graph.pathFragments.push({
          id: `seed-${offset}-${part}`,
          label,
          ...(part ? { parentId: `seed-${offset}-${part - 1}` } : {}),
        });
      graph.artifacts.push({ id, pathFragmentId: `seed-${offset}-${parts.length - 1}` });
      return id;
    });
    const targetId = graph.targets.length + 1;
    graph.targets.push({ id: targetId, label: '//fixture:seed_constructor' });
    const depSetId = graph.depSetOfFiles.length + 1;
    graph.depSetOfFiles.push({ id: depSetId, directArtifactIds: ids });
    graph.actions[0].inputDepSetIds.push(depSetId);
    graph.actions.push({
      targetId,
      configurationId: 1,
      mnemonic: 'PostgresClusterSeed',
      actionKey: 'actual-fixture-seed-constructor',
      outputIds: ids,
      primaryOutputId: ids[0],
    });
    const captured = captureNativeBuildEvidence({
      ...constraints(f),
      cohorts: [
        {
          ...cohort,
          roots: cohort.roots,
          cquery: {
            configurations: [{ id: 1, checksum: cohort.rootConfigurations[0].configuration }],
            results: cohort.roots.map((root) => ({
              target: { rule: { name: root.label } },
              configurationId: 1,
            })),
          },
        },
      ],
    });
    expect(captured.evidence.cohorts[0].seedConstructions).toHaveLength(1);
    const directory = path.join(f.directory, 'seed-packet');
    const file = writeNativeBuildEvidence(captured, directory);
    const packet = readNativeBuildFinalFiles(
      directory,
      JSON.parse(readFileSync(file, 'utf8')),
      constraints(f),
    );
    expect(packet.files).toHaveLength(5);
    expect(packet.artifactRoots).toHaveLength(3);
    for (const name of [frozen, receipt])
      expect(readFileSync(path.join(directory, 'files/0', name))).toEqual(
        readFileSync(path.join(cohort.executionRoot, name)),
      );
    expect(packet.stage()).toHaveLength(3);
    writeFileSync(path.join(directory, 'files/0', frozen), 'substitution');
    expect(() => packet.assertUnchanged()).toThrow();
  });
});

test('public final packet cannot promote caller-injected test inputs into publication artifacts', async () => {
  await fixture(async (f) => {
    const directory = path.join(f.directory, 'injected-test-packet');
    const evidenceFile = writeNativeBuildEvidence(f.capture, directory);
    const evidence = JSON.parse(readFileSync(evidenceFile, 'utf8'));
    const original = readNativeBuildFinalFiles(directory, evidence, constraints(f));
    expect(original.qualificationInputs).toEqual([]);
    expect(original.file(0, original.files[0].path)).toBe(original.artifactRoots[0]);
    evidence.cohorts[0].qualificationInputs = [
      {
        label: '//fixture:unowned_test',
        configuration: 'c'.repeat(64),
        specification: evidence.cohorts[0].outputs[0].path,
        inputs: evidence.cohorts[0].outputs,
      },
    ];
    expect(() => readNativeBuildFinalFiles(directory, evidence, constraints(f))).toThrow(
      /source-owned observer/,
    );
  });
});
