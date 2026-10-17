import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderCargoToml } from '../../tools/packaging/cargo-manifest.mts';
import { readPortableArchiveEntries } from '../../tools/packaging/portable-archive.mts';
import { archive } from '../query/package.mts';
import { type CargoSourceContract, verifyCargoSourceContract } from './source-contract.mts';
import { sourceEnvelope } from './source-package.mts';

async function fixture(root: string, version = '0.3.2'): Promise<CargoSourceContract> {
  mkdirSync(path.join(root, 'src'), { recursive: true });
  const entries: Record<string, string> = {};
  for (const [member, bytes] of Object.entries({
    'Cargo.toml': `[package]\nname="sdk"\nversion="${version}"\nedition="2024"\n[features]\ndefault=["desktop"]\ndesktop=["dep:query"]\n[dependencies]\nquery={path="../query",version="0.1.1",optional=true,default-features=false,features=["std"]}\n`,
    'src/lib.rs': 'pub fn source() -> u8 { 42 }\n',
    LICENSE: 'MIT\n',
    'THIRD_PARTY_NOTICES.md': 'Source SDK notice\n',
    'README.md': 'SDK\n',
  })) {
    entries[member] = path.join(root, member);
    writeFileSync(entries[member], bytes);
  }
  const workspace = path.join(root, 'workspace.toml');
  writeFileSync(workspace, '[workspace]\n');
  const metadata = {
    product: 'sdk',
    version,
    compatibility: { runtime: '0.3.2', broker: '0.3.1' },
    dependencyOwners: {},
    nativeArtifacts: [
      { sourceProduct: 'runtime', target: 'linux-x64-gnu', packageName: 'runtime-linux-x64-gnu' },
    ],
    brokerArtifacts: [
      { sourceProduct: 'broker', target: 'linux-x64-gnu', packageName: 'broker-linux-x64-gnu' },
    ],
  };
  const file = path.join(root, 'sdk.crate');
  writeFileSync(file, await sourceEnvelope(entries['Cargo.toml'], workspace, entries, metadata));
  return { archive: file, manifest: entries['Cargo.toml'], workspace, metadata, entries };
}

test('actual source archives preserve defaults and independent installed pins across SDK increments', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'oliphaunt-source-contract-'));
  try {
    for (const version of ['0.3.2', '0.3.3', '0.4.0']) {
      const input = await fixture(path.join(root, version), version);
      const contract = verifyCargoSourceContract(input);
      expect(contract.manifest.features.default).toEqual(['desktop']);
      expect(contract.manifest.dependencies.query).toEqual({
        version: '0.1.1',
        optional: true,
        'default-features': false,
        features: ['std'],
      });
      const deps =
        contract.manifest.target[
          'cfg(all(target_os = "linux", target_arch = "x86_64", target_env = "gnu"))'
        ].dependencies;
      expect(deps['runtime-linux-x64-gnu'].version).toBe('=0.3.2');
      expect(deps['broker-linux-x64-gnu'].version).toBe('=0.3.1');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('actual package reader rejects missing/extra source, stripped defaults and retargeted dependencies', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'oliphaunt-source-contract-faults-'));
  try {
    const input = await fixture(root);
    const files = Object.fromEntries(
      [...readPortableArchiveEntries(input.archive)]
        .filter(([, entry]) => entry.isFile)
        .map(([name, entry]) => [name, Buffer.from(entry.data())]),
    );
    const prefix = 'sdk-0.3.2/';
    const faults: [string, (entries: Record<string, Buffer>) => void, string][] = [
      [
        'manifest',
        (entries) => {
          delete entries[`${prefix}Cargo.toml`];
        },
        'omitted Cargo.toml',
      ],
      [
        'library',
        (entries) => {
          delete entries[`${prefix}src/lib.rs`];
        },
        'omitted src/lib.rs',
      ],
      [
        'extra',
        (entries) => {
          entries[`${prefix}src/ambient.rs`] = Buffer.from('ambient');
        },
        'undeclared member',
      ],
      [
        'changed-source',
        (entries) => {
          entries[`${prefix}src/lib.rs`] = Buffer.from('changed');
        },
        'library or target guard',
      ],
      [
        'defaults',
        (entries) => {
          const manifest = Bun.TOML.parse(entries[`${prefix}Cargo.toml`].toString());
          manifest.features.default = [];
          entries[`${prefix}Cargo.toml`] = Buffer.from(renderCargoToml(manifest));
        },
        'features changed',
      ],
      [
        'retarget',
        (entries) => {
          const manifest = Bun.TOML.parse(entries[`${prefix}Cargo.toml`].toString());
          manifest.target[
            'cfg(all(target_os = "linux", target_arch = "x86_64", target_env = "gnu"))'
          ].dependencies['runtime-linux-x64-gnu'].version = '=0.4.0';
          entries[`${prefix}Cargo.toml`] = Buffer.from(renderCargoToml(manifest));
        },
        'differs from',
      ],
    ];
    for (const [name, change, message] of faults) {
      const changed = { ...files };
      change(changed);
      const file = path.join(root, `${name}.crate`);
      writeFileSync(file, archive(changed));
      expect(() => verifyCargoSourceContract({ ...input, archive: file })).toThrow(message);
    }
    expect(readFileSync(input.archive).length).toBeGreaterThan(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
