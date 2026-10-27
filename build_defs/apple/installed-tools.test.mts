import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installedToolManifest } from './installed-tools.mts';

function fixture(platform: 'android' | 'ios') {
  const root = mkdtempSync(path.join(tmpdir(), 'installed-tools-'));
  const runner = path.join(root, 'sources/build_defs/installed-app.mts');
  mkdirSync(path.dirname(runner), { recursive: true });
  writeFileSync(runner, '// declared regular module\n');
  const files = [0, 1, 2].map((index) => {
    const file = path.join(root, `declared-${index}`);
    writeFileSync(file, 'declared tool/helper bytes');
    return file;
  });
  const descriptor = {
    schema: 'oliphaunt-installed-mobile-tools-v1',
    platform,
    toolSpec:
      platform === 'android'
        ? {
            helpers: [{ relative: 'src/helper.mts', index: 0 }],
            sdkFiles: [{ relative: 'platform-tools/adb', index: 1 }],
            java: 2,
          }
        : { helpers: [{ relative: 'src/helper.mts', index: 2 }], tools: { plutil: 0, xcrun: 1 } },
    runnerRunfile: 'sources/build_defs/installed-app.mts',
    fileCount: files.length,
  };
  const input = path.join(root, 'descriptor.json');
  const output = path.join(root, 'manifest.json');
  const rewrite = () => writeFileSync(input, JSON.stringify(descriptor));
  rewrite();
  const args = [
    input,
    process.execPath,
    files[0],
    ...(platform === 'android' ? [files[1]] : []),
    ...files,
    root,
    '--output',
    output,
  ];
  return {
    root,
    runner,
    files,
    descriptor,
    output,
    args,
    rewrite,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

for (const platform of ['android', 'ios'] as const) {
  test(`${platform} tools manifest keeps actual provider indices and regular declared runtime paths`, () => {
    const f = fixture(platform);
    try {
      const { output, manifest } = installedToolManifest(f.args);
      expect(output).toBe(f.output);
      expect(manifest.toolSpec).toEqual(f.descriptor.toolSpec);
      expect(manifest.files).toEqual(f.files);
      expect(manifest.runner).toBe(f.runner);
      expect(manifest.bun).toBe(manifest.node);
      expect(Object.keys(manifest).sort()).toEqual(
        [
          'schema',
          'platform',
          'toolSpec',
          'files',
          'bun',
          'node',
          'runner',
          ...(platform === 'android' ? ['emulatorMetadata', 'adb'] : ['receipt']),
        ].sort(),
      );
    } finally {
      f.cleanup();
    }
  });
}

test('tools manifest rejects extra arguments, unsafe runner paths and invalid provider indices', () => {
  const f = fixture('android');
  try {
    expect(() => installedToolManifest([...f.args, 'extra'])).toThrow();
    expect(() => installedToolManifest([...f.args.slice(0, -1), 'relative.json'])).toThrow(
      /absolute/,
    );
    for (const mutation of [
      (value) => {
        value.schema = 'unknown';
      },
      (value) => {
        value.platform = 'unknown';
      },
      (value) => {
        value.unexpected = true;
      },
      (value) => {
        value.runnerRunfile = '../unowned.mts';
      },
      (value) => {
        value.fileCount++;
      },
      (value) => {
        value.toolSpec.java = 3;
      },
      (value) => {
        value.toolSpec.helpers[0].relative = '../unowned.mts';
      },
      (value) => {
        value.toolSpec.helpers.push(value.toolSpec.helpers[0]);
      },
    ]) {
      const original = JSON.parse(JSON.stringify(f.descriptor));
      const altered = JSON.parse(JSON.stringify(f.descriptor));
      mutation(altered);
      writeFileSync(f.args[0], JSON.stringify(altered));
      expect(() => installedToolManifest(f.args)).toThrow();
      writeFileSync(f.args[0], JSON.stringify(original));
    }
    rmSync(f.files[0]);
    expect(() => installedToolManifest(f.args)).toThrow();
  } finally {
    f.cleanup();
  }
});

test('actual tools CLI writes an explicit new regular manifest and refuses destination substitution', () => {
  const f = fixture('ios');
  try {
    const command = [
      process.execPath,
      '--no-install',
      '--no-env-file',
      path.join(import.meta.dir, 'installed-tools.mts'),
      ...f.args,
    ];
    const run = () => Bun.spawnSync(command, { stdout: 'pipe', stderr: 'pipe' });
    const first = run();
    expect(first.exitCode).toBe(0);
    expect(first.stdout.toString()).toBe('');
    expect(JSON.parse(readFileSync(f.output, 'utf8')).runner).toBe(f.runner);
    const bytes = readFileSync(f.output);
    expect(run().exitCode).not.toBe(0);
    expect(readFileSync(f.output)).toEqual(bytes);
  } finally {
    f.cleanup();
  }
});
