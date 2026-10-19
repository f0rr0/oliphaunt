import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderCargoToml } from '../../../../tools/packaging/cargo-manifest.mts';
import {
  resolvedAdapterRuntimeContract,
  workspaceCarrierManifest,
} from './workspace-runtime-contract.mts';

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'oliphaunt-adapter-contract-'));
  temporary.push(root);
  const files: Record<string, any> = {
    'Cargo.toml': {
      workspace: {
        dependencies: {
          'oliphaunt-wasix': { version: '1.2.3', path: 'src/wasix/sdks/rust' },
        },
      },
    },
    'Cargo.lock': {
      version: 4,
      package: [
        { name: 'oliphaunt-wasix', version: '1.2.3' },
        { name: 'liboliphaunt-wasix-portable', version: '2.3.4' },
      ],
    },
    'src/wasix/node-addon/Cargo.toml': {
      dependencies: {
        'oliphaunt-wasix': { workspace: true },
        'liboliphaunt-wasix-portable': { version: '=2.3.4', path: '../runtime/crates/assets' },
      },
    },
    'src/wasix/sdks/rust/Cargo.toml': {
      package: { name: 'oliphaunt-wasix', version: '1.2.3' },
      dependencies: {
        'liboliphaunt-wasix-portable': { version: '*', path: '../../runtime/crates/assets' },
      },
    },
    'src/wasix/runtime/crates/assets/Cargo.toml': {
      package: { name: 'liboliphaunt-wasix-portable', version: '2.3.4' },
    },
  };
  const write = () => {
    for (const [relative, manifest] of Object.entries(files)) {
      const destination = path.join(root, relative);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, renderCargoToml(manifest));
    }
  };
  write();
  return { root, files, write };
}

test('adapter runtime contract uses root lock and local SDK and portable declarations', () => {
  const { root } = fixture();
  expect(resolvedAdapterRuntimeContract(root)).toEqual({
    runtimeVersion: '2.3.4',
    rustBindingVersion: '1.2.3',
  });
  expect(workspaceCarrierManifest({}, {}, root).oliphaunt).toEqual({
    runtimeVersion: '2.3.4',
    rustBindingVersion: '1.2.3',
    qualificationOnly: true,
  });
});

test('adapter runtime contract rejects registry, path, and version substitutions', () => {
  const mutations: ((files: Record<string, any>) => void)[] = [
    (files) => {
      files['Cargo.lock'].package[0].source =
        'registry+https://github.com/rust-lang/crates.io-index';
    },
    (files) => {
      files['Cargo.lock'].package[1].version = '2.3.3';
    },
    (files) => {
      files['Cargo.toml'].workspace.dependencies['oliphaunt-wasix'].path = 'other-sdk';
    },
    (files) => {
      files['src/wasix/node-addon/Cargo.toml'].dependencies['liboliphaunt-wasix-portable'].version =
        '=2.3.3';
    },
    (files) => {
      files['src/wasix/sdks/rust/Cargo.toml'].dependencies['liboliphaunt-wasix-portable'].path =
        'other-runtime';
    },
  ];
  for (const mutate of mutations) {
    const { root, files, write } = fixture();
    mutate(files);
    write();
    expect(() => resolvedAdapterRuntimeContract(root)).toThrow(/declared path and version/);
  }
});
