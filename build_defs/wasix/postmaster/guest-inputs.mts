/** Bind an imported Linux guest to the exact current declared construction sources. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseStrictJson } from '../../../tools/packaging/strict-json.mts';
import { digest, nativeGuestReceipt, runtimeAbiFacts } from './native-receipts.mts';

export interface GuestInputs {
  source: string;
  series: string;
  patches: Record<string, string>;
  overlays: Record<string, string>;
  configuration: Record<string, string>;
  libcSource: string;
  libcPatch: string;
}

const identity = (file: string) => {
  assert(statSync(file).isFile(), `Declared guest input is not regular: ${file}`);
  const bytes = readFileSync(file);
  return { sha256: digest(bytes), size: bytes.length };
};

export function declaredGuestInputs(spec: GuestInputs) {
  const source = Bun.TOML.parse(readFileSync(spec.source, 'utf8')) as any;
  const patches = readFileSync(spec.series, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  assert.equal(new Set(patches).size, patches.length, 'Duplicate canonical PostgreSQL patch');
  assert.deepEqual(
    [...patches].sort(),
    Object.keys(spec.patches).sort(),
    'Declared PostgreSQL patches differ from canonical ordered series',
  );
  return {
    source: {
      postgresql: source.postgresql,
      overlays: Object.entries(spec.overlays)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([path, file]) => ({ path, ...identity(file) })),
      patches: patches.map((path) => ({ path, ...identity(spec.patches[path]) })),
    },
    configuration: Object.fromEntries(
      Object.entries(spec.configuration).map(([name, file]) => [name, identity(file)]),
    ),
    libcSource: parseStrictJson(readFileSync(spec.libcSource, 'utf8')),
    libcPatch: identity(spec.libcPatch).sha256,
  };
}

export function validateImportedGuestReceipt(bytes: Uint8Array | string, spec: GuestInputs) {
  const guest = parseStrictJson(Buffer.from(bytes).toString('utf8')) as any;
  nativeGuestReceipt(guest);
  const expected = declaredGuestInputs(spec);
  assert.deepEqual(guest.source, expected.source, 'Imported guest source/ordered patches differ');
  assert.deepEqual(
    guest.configuration,
    expected.configuration,
    'Imported guest configuration differs',
  );
  assert.deepEqual(guest.sysroot.source, expected.libcSource, 'Imported guest libc source differs');
  assert.equal(guest.sysroot.patch_sha256, expected.libcPatch, 'Imported guest libc patch differs');
  // Sysroot closure and guest compiler identities describe the original Linux
  // construction. They remain unchanged; no foreign compiler is relabeled here.
  return guest;
}

// Emit ordinary sibling Files from the already admitted final tree for per-module AOT caching.
export function writeAotModuleOutputs(
  tree: string,
  modules: string[],
  outputs: Record<string, string>,
) {
  assert.deepEqual(
    Object.keys(outputs).sort(),
    [...modules].sort(),
    'Declared AOT module outputs differ',
  );
  for (const [relative, file] of Object.entries(outputs)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, readFileSync(join(tree, relative)), { flag: 'wx', mode: 0o644 });
  }
}

export function validateGuestProducer(abi: any, canonicalTriple: string) {
  assert.equal(
    canonicalTriple,
    'x86_64-unknown-linux-gnu',
    'Guest producer must be canonical Linux x64',
  );
  assert.equal(runtimeAbiFacts(abi).target, canonicalTriple, 'Imported guest producer differs');
}
