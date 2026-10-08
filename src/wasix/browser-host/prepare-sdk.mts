import { copyFile, cp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const host = import.meta.dirname;
const sdk = resolve(process.argv[2]);
const engine = resolve(process.argv[3]);
const crates = {
  'virtual-fs': 'virtual-fs',
  'virtual-mio': 'virtual-io',
  'virtual-net': 'virtual-net',
  wasmer: 'api',
  'wasmer-c-api-imports': 'c-api-imports',
  'wasmer-config': 'config',
  'wasmer-package': 'package',
  'wasmer-types': 'types',
  'wasmer-wasix': 'wasix',
  'wasmer-wasix-types': 'wasi-types',
};
// Only the browser binding is built. The SDK's Rust/uniffi/N-API products and
// their dependency graphs are not part of Oliphaunt's browser host.
await writeFile(
  resolve(sdk, 'Cargo.toml'),
  '[workspace]\nmembers = ["js/bindgen"]\nresolver = "2"\n\n[patch.crates-io]\n' +
    Object.entries(crates)
      .map(
        ([name, path]) => `${name} = { path = ${JSON.stringify(resolve(engine, 'lib', path))} }\n`,
      )
      .join(''),
);
await cp(resolve(host, 'adapter'), resolve(sdk, 'js/bindgen/src/oliphaunt'), { recursive: true });
await copyFile(
  resolve(host, 'protocol-contract.generated.rs'),
  resolve(sdk, 'js/bindgen/src/oliphaunt/protocol_contract.rs'),
);
await copyFile(resolve(host, 'rust-toolchain.toml'), resolve(sdk, 'rust-toolchain.toml'));
await copyFile(resolve(host, 'index.mts'), resolve(sdk, 'js/index.mts'));
// The lock is kept with our adapter because it has a narrower graph than the
// upstream SDK workspace. Cargo's --locked owns dependency consistency.
const lock = resolve(host, 'Cargo.lock');
if (await Bun.file(lock).exists()) await copyFile(lock, resolve(sdk, 'Cargo.lock'));
