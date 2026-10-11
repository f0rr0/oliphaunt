import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { archiveDirectory } from '../../tools/packaging/archive-directory.mts';
import { frozenNativeNpmInput, verifyFrozenNativeNpm } from './frozen-native-npm.mts';

const root = path.resolve(import.meta.dir, '../..');
const request = () => {
  const json = (file) => JSON.parse(readFileSync(path.join(import.meta.dir, file), 'utf8'));
  const text = (file) => readFileSync(path.join(root, file), 'utf8');
  return {
    metadata: json('native-0.3.2-npm-linux-x64-gnu.json'),
    attestations: json('native-0.3.2-npm-linux-x64-gnu-attestations.json'),
    releases: json('native-0.3.2-releases.json'),
    completion: json('native-0.3.2-completed-publication.json'),
    descriptor: Bun.TOML.parse(text('src/native/sdks/ts/release.toml')),
    compatibilityText: text('src/native/sdks/ts/package.json'),
    compatibilityPath: 'src/native/sdks/ts/package.json',
    target: 'linux-x64-gnu',
    ownerDescriptor: Bun.TOML.parse(text('src/native/runtime/release.toml')),
  };
};

test('held npm uses the conventional SDK pin, registry integrity and exact completed source', () => {
  const input = frozenNativeNpmInput(request());
  expect(input.version).toBe('0.3.2');
  expect(input.name).toBe('@oliphaunt/liboliphaunt-linux-x64-gnu');
  expect(input.publicationSha).toBe('31b5803d80ce3884a1fc2d3e9ab869dd733b461c');
  expect(input.integrity).toBe(request().metadata.dist.integrity);
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
