import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { extractPortableArchiveTree } from './portable-archive.mts';
import { packageSpec } from './wasix-cargo-payload.mts';

const root = path.resolve(import.meta.dir, '../..');
const scratch = process.argv[2];
if (!scratch) throw new Error('Run the paired Shell test');
const triple = 'x86_64-unknown-linux-gnu';
const cases = [
  [
    'runtime',
    'runtimes/liboliphaunt-wasix/crates/assets',
    'wasix-runtime',
    'payload',
    'target/oliphaunt-wasix/assets',
    'OLIPHAUNT_WASIX_GENERATED_ASSETS_DIR',
    'runtime_archive().unwrap()',
  ],
  [
    'tools',
    'postgres-tools/wasix/crates/tools',
    'wasix-tools',
    'payload',
    'target/postgres-tools/wasix/assets',
    'OLIPHAUNT_WASIX_TOOLS_ASSETS_DIR',
    'pg_dump_wasm().unwrap()',
  ],
  [
    'runtime-aot',
    `runtimes/liboliphaunt-wasix/crates/aot/${triple}`,
    'wasix-aot',
    'artifacts',
    `target/oliphaunt-wasix/aot/${triple}`,
    'OLIPHAUNT_WASM_GENERATED_AOT_DIR',
    'artifact_bytes("runtime:oliphaunt").unwrap()',
  ],
  [
    'tools-aot',
    `postgres-tools/wasix/crates/aot/${triple}`,
    'wasix-tools-aot',
    'artifacts',
    `target/postgres-tools/wasix/aot/${triple}`,
    'OLIPHAUNT_WASIX_TOOLS_AOT_DIR',
    'artifact_bytes("tool:pg_dump").unwrap()',
  ],
];
const rows: string[] = [];
for (const [id, template, kind, payloadDirName, ancestorAssets, variable, expression] of cases) {
  const base = path.join(scratch, id);
  const payloadRoot = path.join(base, ancestorAssets);
  mkdirSync(path.join(payloadRoot, 'bin'), { recursive: true });
  for (const file of [
    'oliphaunt.wasix.tar.zst',
    'bin/initdb.wasix.wasm',
    'bin/pg_dump.wasix.wasm',
    'bin/psql.wasix.wasm',
    'oliphaunt-llvm-opta.bin.zst',
    'pg_dump-llvm-opta.bin.zst',
  ]) {
    writeFileSync(path.join(payloadRoot, file), 'selected-payload');
  }
  const aot = kind.endsWith('aot');
  writeFileSync(
    path.join(payloadRoot, 'manifest.json'),
    JSON.stringify(
      aot
        ? {
            artifacts: [
              {
                name: id === 'tools-aot' ? 'tool:pg_dump' : 'runtime:oliphaunt',
                path:
                  id === 'tools-aot' ? 'pg_dump-llvm-opta.bin.zst' : 'oliphaunt-llvm-opta.bin.zst',
              },
            ],
          }
        : { extensions: [] },
    ),
  );
  mkdirSync(path.join(base, '.git'));
  for (const marker of [
    'Cargo.toml',
    'sdks/rust-wasix/Cargo.toml',
    'runtimes/liboliphaunt-wasix/crates/assets/Cargo.toml',
  ]) {
    mkdirSync(path.dirname(path.join(base, marker)), { recursive: true });
    writeFileSync(path.join(base, marker), '');
  }
  const manifest = Bun.TOML.parse(readFileSync(path.join(root, template, 'Cargo.toml'), 'utf8'));
  const outputDir = path.join(base, 'packages');
  mkdirSync(outputDir);
  const packed = packageSpec(
    {
      name: manifest.package.name,
      templateDir: path.join(root, template),
      kind,
      target: aot ? triple : 'portable',
      payloadRoot,
      payloadDirName,
    },
    {
      version: manifest.package.version,
      sourceRoot: path.join(base, 'sources'),
      outputDir,
      cargoTargetDir: path.join(base, 'pack-target'),
    },
  );
  const unpacked = path.join(base, 'extracted');
  extractPortableArchiveTree(packed.cratePath, unpacked);
  const crate = path.join(unpacked, `${manifest.package.name}-${manifest.package.version}`);
  mkdirSync(path.join(crate, 'examples'));
  writeFileSync(
    path.join(crate, 'examples/probe.rs'),
    `fn main() { assert_eq!(${manifest.package.name.replaceAll('-', '_')}::${expression}, b"selected-payload"); }\n`,
  );
  cpSync(path.join(root, 'Cargo.lock'), path.join(crate, 'Cargo.lock'));
  rows.push([crate, payloadDirName, variable, payloadRoot].join('\t'));
}
writeFileSync(path.join(scratch, 'cases.tsv'), `${rows.join('\n')}\n`);
