import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { archiveDirectory } from '../../tools/packaging/archive-directory.mts';
import { windowsPeFixture } from '../../tools/packaging/testdata/release-fixture-utils.mts';
import { frozenNativeNpmInput, verifyFrozenNativeNpm } from './frozen-native-npm.mts';

const root = path.resolve(import.meta.dir, '../..');
const request = (target = 'linux-x64-gnu') => {
  const json = (file) => JSON.parse(readFileSync(path.join(import.meta.dir, file), 'utf8'));
  const text = (file) => readFileSync(path.join(root, file), 'utf8');
  return {
    metadata: json(`native-0.3.2-npm-${target}.json`),
    attestations: json(`native-0.3.2-npm-${target}-attestations.json`),
    releases: json('native-0.3.2-releases.json'),
    completion: json('native-0.3.2-completed-publication.json'),
    descriptor: Bun.TOML.parse(text('src/native/sdks/ts/release.toml')),
    compatibilityText: text('src/native/sdks/ts/package.json'),
    compatibilityPath: 'src/native/sdks/ts/package.json',
    target,
    ownerDescriptor: Bun.TOML.parse(text('src/native/runtime/release.toml')),
  };
};

test('held npm uses the conventional SDK pin, registry integrity and exact completed source', () => {
  for (const target of ['linux-x64-gnu', 'linux-arm64-gnu', 'macos-arm64', 'windows-x64-msvc']) {
    const captured = request(target);
    const input = frozenNativeNpmInput(captured);
    expect(input.version).toBe('0.3.2');
    expect(input.target).toBe(target);
    expect(input.name).toBe(captured.metadata.name);
    expect(input.publicationSha).toBe('31b5803d80ce3884a1fc2d3e9ab869dd733b461c');
    expect(input.integrity).toBe(captured.metadata.dist.integrity);
  }
});

test('held npm rejects pin, owner, registry, provenance and physical target substitutions', () => {
  const bad = (mutate) => {
    const value = request();
    mutate(value);
    expect(() => frozenNativeNpmInput(value)).toThrow();
  };
  bad((value) => {
    value.compatibilityText = value.compatibilityText.replace(
      '"liboliphauntVersion": "0.3.2"',
      '"liboliphauntVersion": "0.3.3"',
    );
  });
  bad((value) => {
    value.ownerDescriptor.registry_packages = [];
  });
  bad((value) => {
    value.metadata.version = '0.3.3';
  });
  bad((value) => {
    value.metadata.oliphaunt.target = 'linux-arm64-gnu';
  });
  bad((value) => {
    value.metadata.oliphaunt.libraryRelativePath = '../lib.so';
  });
  bad((value) => {
    value.metadata.name = '@oliphaunt/liboliphaunt-linux-arm64-gnu';
  });
  for (const [key, replacement] of [
    ['os', ['win32']],
    ['cpu', ['arm64']],
    ['libc', ['musl']],
    ['optional', false],
  ])
    bad((value) => {
      value.metadata[key] = replacement;
    });
  bad((value) => {
    value.metadata.dist.tarball = 'https://example.com/archive.tgz';
  });
  bad((value) => {
    value.metadata.dist.integrity = 'sha256-abc';
  });
  bad((value) => {
    value.attestations.attestations = [];
  });
  bad((value) => {
    value.attestations.attestations.push(value.attestations.attestations[0]);
  });
  bad((value) => {
    const row = value.attestations.attestations.find(
      (row) => row.predicateType === 'https://slsa.dev/provenance/v1',
    );
    const statement = JSON.parse(Buffer.from(row.bundle.dsseEnvelope.payload, 'base64').toString());
    statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = '0'.repeat(40);
    row.bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(statement)).toString('base64');
  });
  bad((value) => {
    const row = value.attestations.attestations[0];
    const statement = JSON.parse(Buffer.from(row.bundle.dsseEnvelope.payload, 'base64').toString());
    statement.subject[0].digest.sha512 = '0'.repeat(128);
    row.bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(statement)).toString('base64');
  });
});

test('Windows held npm preserves captured provider inventories and requires actual PE closure and both receipts', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'held-native-npm-windows-'));
  try {
    const source = path.join(temp, 'package');
    const input = {
      ...frozenNativeNpmInput(request()),
      name: '@oliphaunt/liboliphaunt-win32-x64-msvc',
      target: 'windows-x64-msvc',
      library: 'bin/oliphaunt.dll',
    };
    const manifest = {
      ...request().metadata,
      name: input.name,
      os: ['win32'],
      cpu: ['x64'],
      oliphaunt: {
        target: input.target,
        libraryRelativePath: input.library,
        runtimeRelativePath: 'runtime',
      },
    };
    delete manifest.libc;
    const write = (file, bytes) => {
      mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
      writeFileSync(path.join(source, file), bytes);
    };
    write('package.json', JSON.stringify(manifest));
    for (const file of [
      'runtime/share/postgresql/postgres.bki',
      'LICENSE',
      'THIRD_PARTY_NOTICES.md',
      'THIRD_PARTY_LICENSES/PostgreSQL-COPYRIGHT',
      'THIRD_PARTY_LICENSES/ICU-LICENSE',
    ])
      write(file, `fixture ${file}`);
    write(input.library, windowsPeFixture({ imports: ['VCRUNTIME140.dll'] }));
    write('runtime/bin/initdb.exe', windowsPeFixture());
    const crt = windowsPeFixture({ imports: ['KERNEL32.dll'] });
    const names = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'];
    const receipt = names
      .map((name) => `${createHash('sha256').update(crt).digest('hex')}  ${name}\n`)
      .join('');
    for (const directory of ['bin', 'runtime/bin']) {
      for (const name of names) write(`${directory}/${name}`, crt);
      write(`${directory}/windows-vc-runtime.sha256`, receipt);
    }
    const archive = path.join(temp, 'fixture.tar.gz');
    const pack = async () => {
      await archiveDirectory(source, archive, { keepParent: true });
      const bytes = readFileSync(archive);
      return {
        ...input,
        integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
        shasum: createHash('sha1').update(bytes).digest('hex'),
      };
    };
    verifyFrozenNativeNpm(await pack(), archive);
    const fourNames = [...names, 'msvcp140_2.dll'].sort();
    const fourReceipt = fourNames
      .map((name) => `${createHash('sha256').update(crt).digest('hex')}  ${name}\n`)
      .join('');
    for (const directory of ['bin', 'runtime/bin']) {
      write(`${directory}/msvcp140_2.dll`, crt);
      write(`${directory}/windows-vc-runtime.sha256`, fourReceipt);
    }
    verifyFrozenNativeNpm(await pack(), archive);
    for (const directory of ['bin', 'runtime/bin']) {
      rmSync(path.join(source, directory, 'msvcp140_2.dll'));
      write(`${directory}/windows-vc-runtime.sha256`, receipt);
    }
    write(input.library, windowsPeFixture({ imports: ['MSVCP140_2.dll'] }));
    const missingImport = await pack();
    expect(() => verifyFrozenNativeNpm(missingImport, archive)).toThrow('exact DLL is not bundled');
    write(input.library, windowsPeFixture({ imports: ['VCRUNTIME140.dll'] }));
    rmSync(path.join(source, 'bin/windows-vc-runtime.sha256'));
    const missingReceipt = await pack();
    expect(() => verifyFrozenNativeNpm(missingReceipt, archive)).toThrow(
      'missing regular VC runtime receipt',
    );
    write('bin/windows-vc-runtime.sha256', receipt);
    rmSync(path.join(source, 'runtime/bin/windows-vc-runtime.sha256'));
    const missingRuntimeReceipt = await pack();
    expect(() => verifyFrozenNativeNpm(missingRuntimeReceipt, archive)).toThrow(
      'missing regular VC runtime digest receipt',
    );
    write('runtime/bin/windows-vc-runtime.sha256', receipt);
    rmSync(path.join(source, 'runtime/bin/initdb.exe'));
    write('runtime/bin/initdb', windowsPeFixture());
    const unixInitdb = await pack();
    expect(() => verifyFrozenNativeNpm(unixInitdb, archive)).toThrow('initdb.exe');
    rmSync(path.join(source, 'runtime/bin/initdb'));
    write('runtime/bin/initdb.exe', windowsPeFixture());
    write(input.library, windowsPeFixture({ machine: 0x14c }));
    const wrongMachine = await pack();
    expect(() => verifyFrozenNativeNpm(wrongMachine, archive)).toThrow('not x64');
    write(input.library, windowsPeFixture({ imports: ['VCRUNTIME140.dll'] }));
    write(
      'runtime/bin/windows-vc-runtime.sha256',
      receipt.replace(/^[a-f0-9]{64}/u, '0'.repeat(64)),
    );
    const badReceipt = await pack();
    expect(() => verifyFrozenNativeNpm(badReceipt, archive)).toThrow('does not match');
    write('runtime/bin/windows-vc-runtime.sha256', receipt);
    rmSync(path.join(source, 'runtime/bin/vcruntime140.dll'));
    const missingCrt = await pack();
    expect(() => verifyFrozenNativeNpm(missingCrt, archive)).toThrow('closure mismatch');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('physical held npm checks integrity, manifest identity and real runtime/legal members', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'held-native-npm-'));
  try {
    const input = frozenNativeNpmInput(request());
    const source = path.join(temp, 'package');
    const manifest = request().metadata;
    const members = [
      input.library,
      'runtime/bin/initdb',
      'runtime/share/postgresql/postgres.bki',
      'LICENSE',
      'THIRD_PARTY_NOTICES.md',
      'THIRD_PARTY_LICENSES/PostgreSQL-COPYRIGHT',
      'THIRD_PARTY_LICENSES/ICU-LICENSE',
    ];
    const write = (file, text) => {
      mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
      writeFileSync(path.join(source, file), text);
    };
    for (const member of members) write(member, `fixture ${member}`);
    write('package.json', JSON.stringify(manifest));
    const archive = path.join(temp, 'fixture.tar.gz');
    const pack = async () => {
      await archiveDirectory(source, archive, { keepParent: true });
      const bytes = readFileSync(archive);
      return {
        ...input,
        integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
        shasum: createHash('sha1').update(bytes).digest('hex'),
      };
    };
    const physical = await pack();
    verifyFrozenNativeNpm(physical, archive);
    expect(() => verifyFrozenNativeNpm(input, archive)).toThrow('integrity');
    manifest.version = '0.3.3';
    write('package.json', JSON.stringify(manifest));
    const changed = await pack();
    expect(() => verifyFrozenNativeNpm(changed, archive)).toThrow('manifest');
    manifest.version = input.version;
    write('package.json', JSON.stringify(manifest));
    rmSync(path.join(source, 'THIRD_PARTY_LICENSES/ICU-LICENSE'));
    const incomplete = await pack();
    expect(() => verifyFrozenNativeNpm(incomplete, archive)).toThrow('ICU-LICENSE');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
