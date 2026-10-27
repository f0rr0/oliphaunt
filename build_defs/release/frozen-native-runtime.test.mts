import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { archiveDirectory } from '../../tools/packaging/archive-directory.mts';
import {
  windowsImportLibraryFixture,
  windowsPeFixture,
} from '../../tools/packaging/testdata/release-fixture-utils.mts';
import { extractFrozenNativeRuntime, frozenNativeRuntimeInputs } from './frozen-native-runtime.mts';

const directory = path.dirname(import.meta.path);
const request = () => ({
  releases: JSON.parse(readFileSync(path.join(directory, 'native-0.3.2-releases.json'), 'utf8')),
  completion: JSON.parse(
    readFileSync(path.join(directory, 'native-0.3.2-completed-publication.json'), 'utf8'),
  ),
  descriptor: Bun.TOML.parse(
    readFileSync(path.join(directory, '../../src/native/sdks/rust/release.toml'), 'utf8'),
  ),
  compatibilityText: readFileSync(
    path.join(directory, '../../src/native/sdks/rust/Cargo.toml'),
    'utf8',
  ),
  compatibilityPath: 'src/native/sdks/rust/Cargo.toml',
  selectedTargets: ['linux-x64-gnu'],
});

const kotlinRequest = () => {
  const read = (member) => readFileSync(path.join(directory, member), 'utf8');
  const compatibilityPath =
    'src/native/sdks/kotlin/oliphaunt-android-gradle-plugin/src/main/resources/dev/oliphaunt/android/liboliphaunt.version';
  return {
    releases: JSON.parse(read('native-0.3.3-releases.json')),
    completion: JSON.parse(read('native-0.3.3-completed-publication.json')),
    descriptor: Bun.TOML.parse(read('../../src/native/sdks/kotlin/release.toml')),
    compatibilityText: read(`../../${compatibilityPath}`),
    compatibilityPath,
    selectedTargets: ['linux-x64-gnu'],
  };
};

describe('captured completed native publication acquisition', () => {
  test('uses the authored pin and exact captured source, tag and asset bytes', () => {
    const [input] = frozenNativeRuntimeInputs(request());
    expect(input.version).toBe('0.3.2');
    expect(input.publicationSha).toBe('31b5803d80ce3884a1fc2d3e9ab869dd733b461c');
    expect(input.publicationTree).toBe('7355d3958334202a31d02aa3291b480fdd1f02f4');
    expect(input.sha256).toBe('cb7aecb19398198c4c3ae48b95b0c7ce3ee4c90e5e7e783608f29ae2b84d55aa');
    expect(input.size).toBe(14152293);
    expect(input.url).toBe(
      'https://github.com/f0rr0/oliphaunt/releases/download/liboliphaunt-native-v0.3.2/liboliphaunt-0.3.2-linux-x64-gnu.tar.gz',
    );
  });

  test('binds Kotlin to its own published 0.3.3 pin rather than the Rust held version', () => {
    const [input] = frozenNativeRuntimeInputs(kotlinRequest());
    expect(input.version).toBe('0.3.3');
    expect(input.publicationSha).toBe('cd68c6c9655f53c50a3a98d4db36cfc256d26a3c');
    expect(input.sha256).toBe('17daee827bcbd0a1777e60c23e713079e10a20cf321749d9b9700b6e87599071');
  });

  test('selects genuine desktop archives and the Windows held import library', () => {
    const inputs = frozenNativeRuntimeInputs({
      ...kotlinRequest(),
      selectedTargets: ['linux-x64-gnu', 'macos-arm64', 'windows-x64-msvc'],
    });
    expect(
      inputs.map((input) => [input.target, input.name, input.library, input.interfaceLibrary]),
    ).toEqual([
      [
        'linux-x64-gnu',
        'liboliphaunt-0.3.3-linux-x64-gnu.tar.gz',
        'lib/liboliphaunt.so',
        undefined,
      ],
      ['macos-arm64', 'liboliphaunt-0.3.3-macos-arm64.tar.gz', 'lib/liboliphaunt.dylib', undefined],
      [
        'windows-x64-msvc',
        'liboliphaunt-0.3.3-windows-x64-msvc.zip',
        'bin/oliphaunt.dll',
        'lib/oliphaunt.lib',
      ],
    ]);
    expect(inputs[2].sha256).toBe(
      '910415985a5e676156a72f2ea5eb778980b46682dd89a1bbc5f487520001a902',
    );
    expect(inputs[2].size).toBe(41445869);
    expect(new Set(inputs.map((input) => input.publicationSha)).size).toBe(1);
    const missing = kotlinRequest();
    missing.selectedTargets = ['windows-x64-msvc'];
    missing.releases[0].assets = missing.releases[0].assets.filter(
      (asset) => !asset.name.endsWith('.zip'),
    );
    expect(() => frozenNativeRuntimeInputs(missing)).toThrow(
      'missing liboliphaunt-0.3.3-windows-x64-msvc.zip',
    );
  });

  test('rejects source/pin drift and incomplete, duplicate or mutable publication facts', () => {
    const bad = (mutate) => {
      const value = request();
      mutate(value);
      expect(() => frozenNativeRuntimeInputs(value)).toThrow();
    };
    bad((value) => {
      value.compatibilityText = value.compatibilityText.replace(
        'native-version = "0.3.2"',
        'native-version = "0.3.3"',
      );
    });
    bad((value) => {
      value.compatibilityPath = 'ambient/Cargo.toml';
    });
    bad((value) => {
      value.completion.publicationTree = 'main';
    });
    bad((value) => {
      value.releases[0].targetCommitish = 'main';
    });
    bad((value) => {
      value.releases[0].draft = true;
    });
    bad((value) => {
      value.releases[0].assets.push(value.releases[0].assets[0]);
    });
    bad((value) => {
      value.releases[0].assets = [];
    });
    bad((value) => {
      value.releases[0].assets = value.releases[0].assets.filter(
        (asset) => !asset.name.endsWith('linux-x64-gnu.tar.gz'),
      );
    });
    bad((value) => {
      value.selectedTargets = ['linux-x64-gnu', 'linux-x64-gnu'];
    });
    bad((value) => {
      value.selectedTargets = ['unknown'];
    });
  });

  test('requires exact physical bytes and retained regular runtime/legal members', async () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'held-native-runtime-'));
    try {
      const fs = await import('node:fs/promises');
      const source = path.join(temp, 'source');
      const members = [
        'lib/liboliphaunt.so',
        'include/oliphaunt.h',
        'LICENSE',
        'THIRD_PARTY_NOTICES.md',
        'THIRD_PARTY_LICENSES/PostgreSQL-COPYRIGHT',
        'THIRD_PARTY_LICENSES/ICU-LICENSE',
      ];
      for (const member of members) {
        await fs.mkdir(path.dirname(path.join(source, member)), {
          recursive: true,
        });
        await fs.writeFile(path.join(source, member), `fixture ${member}\n`);
      }
      const archive = path.join(temp, 'fixture.tar.gz');
      await archiveDirectory(source, archive);
      const bytes = readFileSync(archive);
      const input = {
        ...frozenNativeRuntimeInputs(request())[0],
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
      const output = path.join(temp, 'output');
      extractFrozenNativeRuntime(input, archive, output);
      expect(readFileSync(path.join(output, 'include/oliphaunt.h'), 'utf8')).toBe(
        'fixture include/oliphaunt.h\n',
      );
      expect(() =>
        extractFrozenNativeRuntime({ ...input, size: input.size + 1 }, archive, output),
      ).toThrow('differs from captured publication');
      writeFileSync(path.join(source, 'include/oliphaunt.h'), 'changed');
      await fs.unlink(path.join(source, 'THIRD_PARTY_LICENSES/ICU-LICENSE'));
      await archiveDirectory(source, archive);
      const incomplete = readFileSync(archive);
      expect(() =>
        extractFrozenNativeRuntime(
          {
            ...input,
            size: incomplete.length,
            sha256: createHash('sha256').update(incomplete).digest('hex'),
          },
          archive,
          output,
        ),
      ).toThrow('missing regular member THIRD_PARTY_LICENSES/ICU-LICENSE');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  test('Windows physical import requires its interface library and retained native binary contract', async () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'held-windows-runtime-'));
    try {
      const fs = await import('node:fs/promises');
      const source = path.join(temp, 'source');
      for (const member of [
        'bin/oliphaunt.dll',
        'include/oliphaunt.h',
        'LICENSE',
        'THIRD_PARTY_NOTICES.md',
        'THIRD_PARTY_LICENSES/PostgreSQL-COPYRIGHT',
        'THIRD_PARTY_LICENSES/ICU-LICENSE',
      ]) {
        await fs.mkdir(path.dirname(path.join(source, member)), { recursive: true });
        await fs.writeFile(path.join(source, member), `fixture ${member}\n`);
      }
      const archive = path.join(temp, 'physical-fixture.tar.gz');
      const input = frozenNativeRuntimeInputs({
        ...kotlinRequest(),
        selectedTargets: ['windows-x64-msvc'],
      })[0];
      const extract = async () => {
        await archiveDirectory(source, archive);
        const bytes = readFileSync(archive);
        return () =>
          extractFrozenNativeRuntime(
            {
              ...input,
              size: bytes.length,
              sha256: createHash('sha256').update(bytes).digest('hex'),
            },
            archive,
            path.join(temp, 'output'),
          );
      };
      expect(await extract()).toThrow('missing regular member lib/oliphaunt.lib');
      await fs.mkdir(path.join(source, 'lib'));
      await fs.writeFile(path.join(source, 'lib/oliphaunt.lib'), 'not an import library');
      const crt = windowsPeFixture();
      const names = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'];
      for (const directory of ['bin', 'runtime/bin']) {
        await fs.mkdir(path.join(source, directory), { recursive: true });
        for (const name of names) await fs.writeFile(path.join(source, directory, name), crt);
        await fs.writeFile(
          path.join(source, directory, 'windows-vc-runtime.sha256'),
          names
            .map((name) => `${createHash('sha256').update(crt).digest('hex')}  ${name}\n`)
            .join(''),
        );
      }
      expect(await extract()).toThrow(/malformed|truncated/u);
      await fs.writeFile(path.join(source, 'bin/oliphaunt.dll'), windowsPeFixture());
      await fs.writeFile(path.join(source, 'lib/oliphaunt.lib'), windowsImportLibraryFixture());
      expect(await extract()).not.toThrow();
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
