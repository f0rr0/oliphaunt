import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { browserSources } from './metadata.mts';

export const NATIVE_BROWSER_HOST_SCHEMA = 'oliphaunt-browser-host-native-v1';
export const HOST_FILES = [
  'index.mjs',
  'worker.mjs',
  'wasmer_js_bg.wasm',
  'index.d.mts',
  'LICENSE',
] as const;
type Table = Record<string, any>;
type SourceContract = { sources: Table[]; sourceInputs: Record<string, string> };
const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function nativeBrowserSourceContract(metadata: SourceContract): SourceContract {
  return {
    sources: metadata.sources.map(({ archive_sha256, ...source }) => source),
    sourceInputs: metadata.sourceInputs,
  };
}

export async function readNativeBrowserSourceContract(
  repositoryRoot: string,
): Promise<SourceContract> {
  const manifest = 'src/wasix/browser-host/source.toml';
  const text = await readFile(join(repositoryRoot, manifest), 'utf8');
  const source = browserSources(Bun.TOML.parse(text));
  const sourceInputs: Record<string, string> = { [manifest]: sha256(text) };
  for (const patch of source.patches) {
    const file = `src/wasix/browser-host/patches/${patch.name}`;
    sourceInputs[file] = sha256(await readFile(join(repositoryRoot, file)));
  }
  return { sources: source.sources, sourceInputs };
}

export function nativeBrowserHostProvenance(
  metadata: Table,
  files: Record<string, Uint8Array>,
  generatedDeclarations: Uint8Array,
  std: Table,
  nodeVersion: string,
) {
  const source = nativeBrowserSourceContract(metadata as SourceContract);
  const result = {
    schema: NATIVE_BROWSER_HOST_SCHEMA,
    source,
    compilers: {
      ...metadata.compilerSources,
      node: { version: nodeVersion.trim() },
      npm: metadata.acquisition,
    },
    rust: { ...metadata.rust, std },
    guestConcurrency: 'denied-for-oliphaunt-single-backend',
    optimization: {
      cargoProfile: 'release',
      rustOptLevel: metadata.rust.profile['opt-level'],
      lto: metadata.rust.profile.lto,
      wasmOpt: metadata.wasmOpt,
    },
    abi: {
      curatedSha256: sha256(files['index.d.mts']),
      generatedSha256: sha256(generatedDeclarations),
      compatibility: 'generated-assignable-to-curated',
    },
    files: Object.fromEntries(
      HOST_FILES.map((name) => [
        name,
        { sha256: sha256(files[name]), size: files[name].byteLength },
      ]),
    ),
  };
  assertNativeBrowserHostProvenance(result, { source, files });
  return result;
}

export function assertNativeBrowserHostProvenance(
  provenance: Table,
  expected: { source?: SourceContract; files: Record<string, Uint8Array> },
) {
  assert.equal(
    provenance?.schema,
    NATIVE_BROWSER_HOST_SCHEMA,
    'Unsupported native browser host provenance',
  );
  assert.deepEqual(
    Object.keys(provenance).sort(),
    [
      'schema',
      'source',
      'compilers',
      'rust',
      'guestConcurrency',
      'optimization',
      'abi',
      'files',
    ].sort(),
  );
  if (expected.source)
    assert.deepEqual(
      provenance.source,
      expected.source,
      'Native browser host canonical sources differ',
    );
  assert(provenance.source?.sources?.length === 5);
  const sourceInputs = provenance.source.sourceInputs;
  assert(digest(sourceInputs['src/wasix/browser-host/source.toml']));
  assert(Object.values(sourceInputs).every(digest));
  const patchPaths = Object.keys(sourceInputs).filter(
    (name) => name !== 'src/wasix/browser-host/source.toml',
  );
  assert(patchPaths.every((name) => name.startsWith('src/wasix/browser-host/patches/')));
  const pins = Object.fromEntries(
    provenance.source.sources.map((row: Table) => [
      row.name,
      { ...row, name: row.name === 'wasmer-js' ? '@wasmer/sdk' : row.name },
    ]),
  );
  assert.deepEqual(
    browserSources({
      ...pins,
      patches: {
        series: patchPaths.map((name) => name.slice('src/wasix/browser-host/patches/'.length)),
      },
    }).sources,
    provenance.source.sources,
  );
  assert.equal(provenance.guestConcurrency, 'denied-for-oliphaunt-single-backend');
  assert.deepEqual(provenance.optimization, {
    cargoProfile: 'release',
    rustOptLevel: provenance.rust.profile['opt-level'],
    lto: provenance.rust.profile.lto,
    wasmOpt: provenance.optimization.wasmOpt,
  });
  assert.equal(provenance.optimization.rustOptLevel, 3);
  assert.equal(provenance.optimization.lto, true);
  assert.deepEqual(provenance.optimization.wasmOpt, [
    '--enable-threads',
    '--enable-bulk-memory',
    '-O3',
  ]);
  assert(/^nightly-\d{4}-\d{2}-\d{2}$/.test(provenance.rust.channel));
  assert.equal(provenance.rust.target, 'wasm32-unknown-unknown');
  assert.deepEqual(provenance.rust.buildStd, ['std', 'panic_abort']);
  assert.equal(provenance.rust.std?.schema, 'oliphaunt-browser-rust-std-native-v1');
  assert.equal(provenance.rust.std.channel, provenance.rust.channel);
  assert.equal(provenance.rust.std.target, provenance.rust.target);
  assert.deepEqual(provenance.rust.std.buildStd, provenance.rust.buildStd);
  assert(Array.isArray(provenance.rust.std.targetFeatures));
  for (const feature of ['atomics', 'bulk-memory'])
    assert(provenance.rust.std.targetFeatures.includes(feature));
  assert.deepEqual(provenance.rust.std.rust, {
    channel: provenance.rust.channel,
    edition: provenance.rust.edition,
    target: provenance.rust.target,
    flags: provenance.rust.flags,
    buildStd: provenance.rust.buildStd,
    profile: provenance.rust.profile,
  });
  assert(
    digest(provenance.rust.std.compiler?.sha256) && digest(provenance.rust.std.rustSrc?.sha256),
  );
  assert(/^[a-f0-9]{40}$/.test(provenance.rust.std.rustSrc.commit));
  assert(Array.isArray(provenance.rust.std.stdlib) && provenance.rust.std.stdlib.length > 0);
  for (const artifact of provenance.rust.std.stdlib)
    assert(
      artifact.path?.startsWith(`lib/rustlib/${provenance.rust.target}/lib/`) &&
        !artifact.path.split('/').some((part: string) => part === '..' || part === '.') &&
        digest(artifact.sha256),
    );
  for (const name of ['wasm-bindgen', 'wasm-opt'])
    assert(provenance.compilers[name]?.version && digest(provenance.compilers[name].sha256));
  assert(/^\d+\.\d+\.\d+$/.test(provenance.compilers.node.version));
  assert.deepEqual(provenance.compilers.npm.platform, { os: 'linux', cpu: 'x64' });
  const packages = provenance.compilers.npm.packages;
  for (const name of ['typescript', 'rollup', '@types/node'])
    assert.equal(packages[provenance.compilers.npm.roots[name]]?.package, name);
  for (const [id, row] of Object.entries(packages) as [string, Table][]) {
    assert(
      row.package &&
        row.version &&
        row.key.startsWith('node_modules/') &&
        /^sha512-[A-Za-z0-9+/]+=*$/.test(row.integrity),
    );
    assert.equal(
      row.url,
      `https://registry.npmjs.org/${row.package}/-/${row.package.split('/').at(-1)}-${row.version}.tgz`,
    );
    assert.equal(id, `p_${sha256(row.key).slice(0, 16)}`);
    assert(!row.key.split('/').some((part: string) => part === '..' || part === '.'));
    for (const [name, dependency] of Object.entries(row.dependencies) as [string, string][])
      assert.equal(packages[dependency]?.package, name);
  }
  assert.deepEqual(Object.keys(provenance.files).sort(), [...HOST_FILES].sort());
  for (const name of HOST_FILES) {
    assert(expected.files[name]?.byteLength > 0, `Missing native browser payload ${name}`);
    assert.deepEqual(
      provenance.files[name],
      { sha256: sha256(expected.files[name]), size: expected.files[name].byteLength },
      `Native browser payload ${name} differs`,
    );
  }
  assert.deepEqual(
    Buffer.from(expected.files['wasmer_js_bg.wasm'].subarray(0, 8)),
    Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
  );
  assert.equal(provenance.abi.compatibility, 'generated-assignable-to-curated');
  assert.equal(provenance.abi.curatedSha256, sha256(expected.files['index.d.mts']));
  assert(digest(provenance.abi.generatedSha256));
}
