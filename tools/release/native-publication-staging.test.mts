import { expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tarHeader } from '../packaging/archive-directory.mts';
import {
  captureNativePublicationOutputs,
  isNativeFinalTransportRoot,
} from './native-publication-staging.mts';
import { ROOT } from './release-graph.mts';

function fixture(run) {
  const executionRoot = mkdtempSync(path.join(os.tmpdir(), 'native-output-stage-'));
  const target = path.join(ROOT, 'target');
  mkdirSync(target, { recursive: true });
  const workspace = mkdtempSync(path.join(target, 'native-output-stage-test-'));
  const output = 'bazel-out/fixture/bin/package';
  const directory = path.join(executionRoot, output);
  mkdirSync(path.join(directory, 'empty'), { recursive: true });
  writeFileSync(path.join(directory, 'package.pom'), 'POM');
  writeFileSync(path.join(directory, 'package.jar'), 'JAR');
  chmodSync(path.join(directory, 'package.jar'), 0o755);
  const cohort = {
    executionRoot,
    roots: [
      {
        label: '//fixture:shipping',
        package: {
          product: 'fixture',
          version: '1.0.0',
          ecosystem: 'maven',
          name: 'dev:fixture',
          role: 'facade',
          configuration: 'portable',
          outputs: [{ path: output, owner: '//fixture:producer' }],
        },
      },
    ],
    aquery: {},
  };
  const stageDirectory = path
    .relative(ROOT, path.join(workspace, 'staged'))
    .split(path.sep)
    .join('/');
  const capture = (cohorts = [cohort], destination = stageDirectory) =>
    captureNativePublicationOutputs(cohorts, {
      sourceCommit: '1'.repeat(40),
      stageDirectory: destination,
    });
  try {
    run({ capture, cohort, directory, executionRoot, workspace, stageDirectory });
  } finally {
    rmSync(executionRoot, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
}

test('stages exact declared tree bytes, empty directories and modes under target with companion layout', () => {
  fixture(({ capture, directory }) => {
    const staged = capture().stage();
    expect(staged).toHaveLength(1);
    expect(path.relative(ROOT, staged[0])).toMatch(/^target\//u);
    expect(staged[0]).toEndWith('/package');
    expect(readFileSync(path.join(staged[0], 'package.pom'), 'utf8')).toBe('POM');
    expect(readFileSync(path.join(staged[0], 'package.jar'), 'utf8')).toBe('JAR');
    expect(lstatSync(path.join(staged[0], 'empty')).isDirectory()).toBe(true);
    expect(lstatSync(path.join(staged[0], 'package.jar')).mode & 0o777).toBe(0o755);
    expect(capture().stage()).toEqual(staged);
    rmSync(directory, { recursive: true });
    expect(readFileSync(path.join(staged[0], 'package.jar'), 'utf8')).toBe('JAR');
  });
});

test('constructor transport selects only a source-owned internal generated File declaration', () => {
  fixture(({ capture, cohort, directory }) => {
    const root = cohort.roots[0];
    Object.assign(root.package, {
      ecosystem: 'internal',
      role: 'constructor-input',
      name: 'postgres-wasix-wasm',
      outputs: [
        { path: `${root.package.outputs[0].path}/package.jar`, owner: '//fixture:producer' },
      ],
    });
    expect(isNativeFinalTransportRoot(root)).toBe(true);
    expect(readFileSync(capture().stage()[0], 'utf8')).toBe('JAR');
    for (const mutate of [
      (value) => (value.package.role = 'construction'),
      (value) => (value.package.name = '../postgres-wasix-wasm'),
      (value) => (value.label = '@other//fixture:shipping'),
      (value) => (value.package.outputs[0].path = 'source/postgres.wasm'),
      (value) =>
        value.package.outputs.push({ path: `${directory}/other`, owner: '//fixture:producer' }),
    ]) {
      const changed = structuredClone(root);
      mutate(changed);
      expect(isNativeFinalTransportRoot(changed)).toBe(false);
    }
    root.package.outputs[0].path = 'bazel-out/fixture/bin/package';
    expect(capture).toThrow('constructor input must be one original regular File');
  });
});

test('rejects bytes, modes, removed files and added directory members changed after capture', () => {
  for (const mutate of [
    (directory) => writeFileSync(path.join(directory, 'package.jar'), 'BAD'),
    (directory) => chmodSync(path.join(directory, 'package.jar'), 0o644),
    (directory) => rmSync(path.join(directory, 'package.jar')),
    (directory) => writeFileSync(path.join(directory, 'extra'), 'extra'),
  ])
    fixture(({ capture, directory, workspace }) => {
      const captured = capture();
      mutate(directory);
      expect(() => captured.stage()).toThrow('changed after capture');
      expect(existsSync(path.join(workspace, 'staged'))).toBe(false);
    });
});

test('rejects source symlinks, output parent aliases and unsafe or symlinked target parents', () => {
  fixture(({ capture, cohort, directory, workspace }) => {
    const file = path.join(directory, 'package.jar');
    rmSync(file);
    symlinkSync(path.join(directory, 'package.pom'), file);
    expect(capture).toThrow('regular file or directory');
    rmSync(file);
    writeFileSync(file, 'JAR');
    const captured = capture();
    const moved = `${directory}-moved`;
    mkdirSync(moved);
    writeFileSync(path.join(moved, 'package.jar'), 'JAR');
    writeFileSync(path.join(moved, 'package.pom'), 'POM');
    rmSync(directory, { recursive: true });
    symlinkSync(moved, directory);
    expect(() => captured.stage()).toThrow('not a physical file or directory');
    cohort.roots[0].package.outputs[0].path = `${cohort.roots[0].package.outputs[0].path}/package.jar`;
    expect(capture).toThrow('symlink or non-directory ancestor');
    expect(() => capture([cohort], 'target/../outside')).toThrow('unsafe native staging path');
    expect(() => capture([cohort], '/tmp/outside')).toThrow('unsafe native staging path');
    rmSync(directory);
    mkdirSync(directory);
    writeFileSync(path.join(directory, 'package.jar'), 'JAR');
    const external = path.join(workspace, 'external');
    mkdirSync(external);
    symlinkSync(external, path.join(workspace, 'link'));
    const aliased = path
      .relative(ROOT, path.join(workspace, 'link', 'staged'))
      .split(path.sep)
      .join('/');
    expect(() => capture([cohort], aliased).stage()).toThrow('symlink or non-directory ancestor');
    expect(existsSync(path.join(external, 'staged'))).toBe(false);
  });
});

test('overlapping tree and file declarations deduplicate and cohort order preserves staged paths', () => {
  fixture(({ capture, cohort, stageDirectory }) => {
    cohort.roots[0].package.outputs.push({
      path: 'bazel-out/fixture/bin/package/package.jar',
      owner: '//fixture:producer',
    });
    const second = {
      ...cohort,
      roots: [
        {
          ...cohort.roots[0],
          package: {
            ...cohort.roots[0].package,
            name: 'dev:second',
          },
        },
      ],
    };
    const first = capture([cohort, second]).stage();
    expect(capture([second, cohort], stageDirectory).stage()).toEqual(first);
    expect(first).toHaveLength(4);
    expect(first.filter((output) => output.endsWith('/package.jar'))).toHaveLength(2);
  });
});

test('existing staged mutations fail closed without replacing the accepted directory', () => {
  fixture(({ capture }) => {
    const staged = capture().stage();
    writeFileSync(path.join(staged[0], 'package.jar'), 'BAD');
    expect(() => capture().stage()).toThrow('existing native stage differs');
    expect(readFileSync(path.join(staged[0], 'package.jar'), 'utf8')).toBe('BAD');
  });
});

test('real Gradle marker, Maven companions and Swift tree retain producer layout in capsule ustar', () => {
  fixture(({ cohort, executionRoot }) => {
    const files = [
      'bazel-out/k8-fastbuild/bin/src/native/sdks/kotlin/oliphaunt-android-gradle-plugin/marker_maven/maven/dev/oliphaunt/android/dev.oliphaunt.android.gradle.plugin/0.3.3/dev.oliphaunt.android.gradle.plugin-0.3.3.pom',
      'bazel-out/k8-fastbuild/bin/src/native/sdks/kotlin/android_maven/maven/dev/oliphaunt/oliphaunt-android/0.3.3/oliphaunt-android-0.3.3-javadoc.jar',
      'bazel-out/k8-fastbuild/bin/src/native/sdks/kotlin/android_maven/maven/dev/oliphaunt/oliphaunt-android/0.3.3/oliphaunt-android-0.3.3.pom',
      'bazel-out/darwin_arm64-fastbuild/bin/src/native/sdks/swift/source_package/Package.swift.release',
      'bazel-out/darwin_arm64-fastbuild/bin/src/native/sdks/swift/source_package/extension-generator/extension-owner-catalog.json',
      'bazel-out/darwin_arm64-fastbuild/bin/src/native/sdks/swift/source_package/release-tree/src/sdks/swift/Sources/OliphauntExtensionSupport/OliphauntExtensionSupport.swift',
      'bazel-out/darwin_arm64-fastbuild/bin/src/native/sdks/swift/source_package/release-tree/src/sdks/swift/Carriers/ios-carriers.json',
    ];
    for (const relative of files) {
      const file = path.join(executionRoot, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, 'fixture');
    }
    const swiftTree =
      'bazel-out/darwin_arm64-fastbuild/bin/src/native/sdks/swift/source_package/release-tree';
    const declarations = [files[0], files[1], files[2], files[3], files[4], swiftTree];
    cohort.roots = declarations.map((relative, index) => ({
      ...cohort.roots[0],
      label: `//fixture:shipping_${index}`,
      package: {
        ...cohort.roots[0].package,
        name: `fixture-${index}`,
        outputs: [
          {
            path: relative,
            owner:
              index === 0
                ? '//fixture:marker_maven'
                : index < 3
                  ? '//fixture:android_maven'
                  : '//fixture:source_package',
          },
        ],
      },
    }));
    const staged = captureNativePublicationOutputs([cohort], {
      sourceCommit: '1'.repeat(40),
    }).stage();
    const stageRoot = path.join(
      ROOT,
      ...path.relative(ROOT, staged[0]).split(path.sep).slice(0, 3),
    );
    try {
      expect(
        path.dirname(staged.find((file) => file.endsWith('/oliphaunt-android-0.3.3-javadoc.jar'))!),
      ).toBe(path.dirname(staged.find((file) => file.endsWith('/oliphaunt-android-0.3.3.pom'))!));
      const manifest = staged.find((file) => file.endsWith('/Package.swift.release'))!;
      const tree = staged.find((file) => file.endsWith('/release-tree'))!;
      expect(path.dirname(manifest)).toBe(path.dirname(tree));
      expect(
        readFileSync(path.join(tree, 'src/sdks/swift/Carriers/ios-carriers.json'), 'utf8'),
      ).toBe('fixture');
      expect(
        staged.find((file) => file.endsWith('/extension-generator/extension-owner-catalog.json')),
      ).toStartWith(`${path.dirname(tree)}/`);
      const leaves = staged
        .filter((file) => lstatSync(file).isFile())
        .concat(
          files
            .slice(-2)
            .map((file) =>
              path.join(tree, file.slice(file.indexOf('/release-tree/') + '/release-tree/'.length)),
            ),
        );
      expect(
        leaves.some((file) => file.endsWith('/dev.oliphaunt.android.gradle.plugin-0.3.3.pom')),
      ).toBe(true);
      for (const file of leaves) {
        const relative = path.relative(ROOT, file).split(path.sep).join('/');
        const header = tarHeader({ name: relative }, 7, 0o644);
        const name = header.subarray(0, 100).toString().split('\0')[0];
        const prefix = header.subarray(345, 500).toString().split('\0')[0];
        expect(`${prefix}/${name}`).toBe(relative);
      }
    } finally {
      rmSync(stageRoot, { recursive: true, force: true });
    }
  });
});

test('same producer configurations and same-name carrier parts remain distinct with full source binding', () => {
  fixture(({ cohort, executionRoot, capture }) => {
    const originals = [
      ['bazel-out/k8-opt/bin/deep/producer/part.crate', 'x64'],
      ['bazel-out/arm64-opt/bin/deep/producer/part.crate', 'arm64'],
      ['bazel-out/k8-opt/bin/other/producer/part.crate', 'other'],
    ];
    cohort.roots = originals.map(([relative, bytes], index) => {
      const file = path.join(executionRoot, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, bytes);
      return {
        ...cohort.roots[0],
        package: {
          ...cohort.roots[0].package,
          name: `part-${index}`,
          outputs: [
            { path: relative, owner: index < 2 ? '//fixture:producer' : '//other:producer' },
          ],
        },
      };
    });
    const staged = capture().stage();
    expect(staged).toHaveLength(3);
    expect(new Set(staged.map((file) => path.dirname(file))).size).toBe(3);
    expect(staged.map((file) => readFileSync(file, 'utf8')).sort()).toEqual([
      'arm64',
      'other',
      'x64',
    ]);
    const captured = capture();
    cohort.roots[0].package.outputs[0].path = originals[1][0];
    expect(() => capture().stage()).toThrow();
    expect(captured.stage()).toEqual(staged);
    delete cohort.roots[0].package.outputs[0].owner;
    expect(capture).toThrow('declared output producer');
  });
});
