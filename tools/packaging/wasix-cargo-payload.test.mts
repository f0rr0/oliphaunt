import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  filesystemTreeRows,
  logicalTreeSha256,
} from '../../src/database-resources/contracts/native-manifest.mts';
import { createDeterministicTar } from './cargo-source-package.mts';
import { extractPortableArchiveTree, releaseZstdCompressSync } from './portable-archive.mts';
import { packageAotSpec, packageSpec } from './wasix-cargo-payload.mts';
import { preparePackagedCargoTestClosure } from './cargo-package-test-closure.mts';
import { WASIX_AOT_ENGINE } from '../../src/wasix/runtime/tools/wasix-aot-manifest.mts';

const root = path.resolve(import.meta.dir, '../..');
const scratch = process.argv[2];
if (!scratch) throw new Error('Run the paired Shell test');
const triple = 'x86_64-unknown-linux-gnu';
const cases = [
  [
    'icu',
    'src/database-resources/icu/cargo',
    'icu-data',
    'payload',
    'icu-data',
    'OLIPHAUNT_ICU_DATA_DIR',
    'ICU_DATA_TREE_SHA256.unwrap().as_bytes()',
  ],
  [
    'runtime',
    'src/wasix/runtime/crates/assets',
    'wasix-runtime',
    'payload',
    'target/oliphaunt-wasix/assets',
    'OLIPHAUNT_WASIX_GENERATED_ASSETS_DIR',
    'runtime_archive().unwrap()',
  ],
  [
    'tools',
    'src/wasix/postgres-tools/crates/tools',
    'wasix-tools',
    'payload',
    'target/postgres-tools/wasix/assets',
    'OLIPHAUNT_WASIX_TOOLS_ASSETS_DIR',
    'pg_dump_wasm().unwrap()',
  ],
  [
    'runtime-aot',
    `src/wasix/runtime/crates/aot/${triple}`,
    'wasix-aot',
    'artifacts',
    `target/oliphaunt-wasix/aot/${triple}`,
    'OLIPHAUNT_WASM_GENERATED_AOT_DIR',
    'artifact_bytes("runtime:oliphaunt").unwrap()',
  ],
  [
    'tools-aot',
    `src/wasix/postgres-tools/crates/aot/${triple}`,
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
  const external = path.join(base, ancestorAssets);
  let payloadRoot = external;
  let expected = 'selected-payload';
  if (id === 'icu') {
    mkdirSync(payloadRoot, { recursive: true });
    writeFileSync(path.join(payloadRoot, 'icudt76l.dat'), expected);
    expected = logicalTreeSha256(filesystemTreeRows(payloadRoot));
    const archive = releaseZstdCompressSync(
      createDeterministicTar(payloadRoot, 'share/icu', { fixedFileMode: 0o644 }),
    );
    payloadRoot = path.join(base, 'icu-payload');
    mkdirSync(payloadRoot);
    writeFileSync(path.join(payloadRoot, 'icu-data.tar.zst'), archive);
  } else {
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
              engine: WASIX_AOT_ENGINE,
              artifacts: [
                {
                  name: id === 'tools-aot' ? 'tool:pg_dump' : 'runtime:oliphaunt',
                  path:
                    id === 'tools-aot'
                      ? 'pg_dump-llvm-opta.bin.zst'
                      : 'oliphaunt-llvm-opta.bin.zst',
                },
              ],
            }
          : { extensions: [] },
      ),
    );
  }
  mkdirSync(path.join(base, '.git'));
  for (const marker of [
    'Cargo.toml',
    'src/wasix/sdks/rust/Cargo.toml',
    'src/wasix/runtime/crates/assets/Cargo.toml',
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
      target: kind.endsWith('aot') ? triple : 'portable',
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
    `fn main() { assert_eq!(${manifest.package.name.replaceAll('-', '_')}::${expression}, b${JSON.stringify(expected)}); }\n`,
  );
  cpSync(path.join(root, 'Cargo.lock'), path.join(crate, 'Cargo.lock'));
  rows.push([crate, payloadDirName, variable, external].join('\t'));
}
writeFileSync(path.join(scratch, 'cases.tsv'), `${rows.join('\n')}\n`);

const splitRows = [];
for (const [owner, kind, artifact] of [
  ['runtime', 'wasix-aot', 'runtime:oliphaunt'],
  ['postgres-tools', 'wasix-tools-aot', 'tool:pg_dump'],
]) {
  const target = 'x86_64-pc-windows-msvc';
  const templateDir = path.join(root, `src/wasix/${owner}/crates/aot/${target}`);
  const { name, version } = Bun.TOML.parse(
    readFileSync(path.join(templateDir, 'Cargo.toml'), 'utf8'),
  ).package;
  const base = path.join(scratch, `split-${owner}`);
  const payloadRoot = path.join(base, 'payload');
  mkdirSync(payloadRoot, { recursive: true });
  const bytes = randomBytes(11 * 1024 * 1024);
  const file = owner === 'runtime' ? 'oliphaunt-v8.bin.zst' : 'pg_dump-v8.bin.zst';
  writeFileSync(path.join(payloadRoot, file), bytes);
  writeFileSync(
    path.join(payloadRoot, 'manifest.json'),
    JSON.stringify({
      engine: 'v8',
      artifacts: [{ name: artifact, path: file }],
    }),
  );
  const spec = { name, kind, target, templateDir, payloadRoot, payloadDirName: 'artifacts' };
  const options = {
    version,
    sourceRoot: path.join(base, 'source'),
    outputDir: path.join(base, 'packages'),
    cargoTargetDir: path.join(base, 'package-target'),
  };
  mkdirSync(options.outputDir);
  assert.throws(
    () => packageSpec(spec, { ...options, sourceRoot: path.join(base, 'unsplit') }),
    /10 MiB/u,
  );
  const packages = packageAotSpec(spec, options);
  assert.equal(packages.length, 3);
  assert(packages.every(({ size }) => size < 10 * 1024 * 1024));
  assert.deepEqual(
    packages.map(({ name }) => name),
    [`${name}-part-001`, `${name}-part-002`, name],
  );
  const parent = packages.at(-1);
  const buildDependencies = Bun.TOML.parse(readFileSync(parent.manifestPath, 'utf8'))[
    'build-dependencies'
  ];
  for (const part of packages.slice(0, -1))
    assert.equal(buildDependencies[part.name], `=${version}`);
  const manifest = preparePackagedCargoTestClosure({
    cratePath: parent.cratePath,
    dependencyCrates: packages.slice(0, -1).map(({ cratePath }) => cratePath),
    scratch: path.join(base, 'consumer'),
  });
  const crate = path.dirname(manifest);
  mkdirSync(path.join(crate, 'examples'));
  writeFileSync(manifest, readFileSync(manifest, 'utf8') + '\n[dev-dependencies]\nsha2 = "0.10"\n');
  writeFileSync(
    path.join(crate, 'examples/probe.rs'),
    `use sha2::{Digest, Sha256};
fn main() {
    let bytes = ${name.replaceAll('-', '_')}::artifact_bytes(${JSON.stringify(artifact)}).unwrap();
    assert_eq!(format!("{:x}", Sha256::digest(bytes)), ${JSON.stringify(createHash('sha256').update(bytes).digest('hex'))});
    assert!(${name.replaceAll('-', '_')}::HAS_EMBEDDED_AOT);
    assert_eq!(${name.replaceAll('-', '_')}::ENGINE, "v8");
}
`,
  );
  const part = path.join(
    base,
    'consumer/dependencies',
    `${packages[0].name}-${version}`,
    'payload.part',
  );
  splitRows.push([crate, part].join('\t'));
}
writeFileSync(path.join(scratch, 'split-cases.tsv'), `${splitRows.join('\n')}\n`);
