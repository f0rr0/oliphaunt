/** Read the canonical public Linux archive; retain only its portable sealed guest. */
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  requiredModules,
  sideModulePolicy,
} from '../../../src/wasix/postmaster/lib/guest-build-provenance.mts';
import {
  carrierTree,
  hashRegular,
  verify,
} from '../../../src/wasix/postmaster/lib/verify-sealed-carrier.mts';
import { inspectPlatformBinaryBuffer } from '../../../tools/packaging/platform-binary-contract.mts';
import {
  extractPortableArchiveTree,
  readPortableArchiveEntries,
} from '../../../tools/packaging/portable-archive.mts';
import { parseStrictJson } from '../../../tools/packaging/strict-json.mts';
import {
  type GuestInputs,
  validateGuestProducer,
  validateImportedGuestReceipt,
} from './guest-inputs.mts';
import { nativeWasmerReceipt, runtimeAbiFacts } from './native-receipts.mts';

export interface ImportedGuest extends GuestInputs {
  archive: string;
  version: string;
  artifact: { product: string; kind: string; asset: string; target: string; triple: string };
}

export function importPostmasterGuest(spec: ImportedGuest, output: string, receipt: string) {
  assert.equal(spec.artifact.product, 'liboliphaunt-wasix-postmaster');
  assert.equal(spec.artifact.kind, 'wasix-postmaster-runtime');
  assert.equal(
    spec.artifact.target,
    'linux-x64-gnu',
    'Imported guest must come from the Linux producer',
  );
  assert(/^\d+\.\d+\.\d+$/.test(spec.version));
  const asset = spec.artifact.asset.replaceAll('{version}', spec.version);
  assert.equal(basename(spec.archive), asset, 'Imported archive differs from canonical identity');
  const parent = asset.replace(/\.tar\.zst$/u, '');
  assert.notEqual(parent, asset);
  // Resolve the declared repository/sandbox projection; the archive reader
  // continues to require the resulting owned transport File to be regular.
  const archive = realpathSync(resolve(spec.archive));
  const entries = readPortableArchiveEntries(archive);
  assert(entries.get(parent)?.isDirectory, 'Imported public archive parent is absent');
  const outerFiles = new Set([
    'LICENSE',
    'README.md',
    'THIRD_PARTY_NOTICES.md',
    'bin/oliphaunt-wasix-postmaster',
  ]);
  for (const [name, entry] of entries) {
    assert(name === parent || name.startsWith(`${parent}/`), 'Imported archive has a foreign root');
    const relative = name.slice(parent.length + 1);
    assert(
      (entry.isDirectory && ['', 'bin', 'carrier'].includes(relative)) ||
        relative.startsWith('carrier/') ||
        outerFiles.delete(relative),
      `Foreign public archive member: ${relative}`,
    );
    if (entry.isDirectory)
      assert.equal(entry.mode, 0o755, `Imported archive directory mode: ${name}`);
    else if (relative.startsWith('carrier/'))
      assert([0o644, 0o755].includes(entry.mode), `Imported carrier mode: ${name}`);
    else
      assert.equal(
        entry.mode,
        relative === 'bin/oliphaunt-wasix-postmaster' ? 0o755 : 0o644,
        `Imported archive mode differs: ${name}`,
      );
  }
  assert.equal(outerFiles.size, 0, 'Imported public archive metadata is missing');
  mkdirSync(dirname(resolve(output)), { recursive: true });
  const scratch = mkdtempSync(join(dirname(resolve(output)), '.postmaster-guest-'));
  try {
    extractPortableArchiveTree(archive, scratch);
    const carrier = join(scratch, parent, 'carrier');
    for (const [path, info] of [...carrierTree(carrier)].reverse())
      chmodSync(path === '.' ? carrier : join(carrier, path), info.mode & 0o555);
    const wasmer = parseStrictJson(
      readFileSync(join(carrier, 'wasmer-build.receipt'), 'utf8'),
    ) as any;
    nativeWasmerReceipt(wasmer);
    validateGuestProducer(wasmer.runtime_abi, spec.artifact.triple);
    const facts = runtimeAbiFacts(wasmer.runtime_abi);
    const bytes = readFileSync(join(carrier, 'guest-build.receipt'));
    const guest = validateImportedGuestReceipt(bytes, spec);
    verify(
      carrier,
      hashRegular(join(carrier, 'wasmer-build.receipt')).sha256,
      guest.postgres_version,
      facts.wasmerVersion,
      facts.wasixVersion,
      wasmer.runtime_abi.artifact_abi_version,
      carrier,
    );
    inspectPlatformBinaryBuffer(readFileSync(join(carrier, 'bin/wasmer-headless')), {
      target: spec.artifact.target,
      label: 'imported postmaster guest producer',
    });
    const modules = new Set([
      ...requiredModules,
      ...sideModulePolicy.flatMap((row) => row.aliases),
    ]);
    mkdirSync(output, { recursive: true });
    for (const [path, info] of carrierTree(carrier)) {
      if (
        !info.isFile() ||
        !(modules.has(path) || path.startsWith('share/postgresql/') || path.startsWith('memory/'))
      )
        continue;
      const destination = join(output, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, readFileSync(join(carrier, path)), {
        flag: 'wx',
        mode: path.startsWith('bin/') ? 0o755 : 0o644,
      });
    }
    writeFileSync(receipt, bytes, { flag: 'wx' });
  } finally {
    // Only our private extracted copy is made writable for deletion.
    const carrier = join(scratch, parent, 'carrier');
    if (existsSync(carrier))
      for (const [path, info] of carrierTree(carrier))
        if (info.isDirectory()) chmodSync(path === '.' ? carrier : join(carrier, path), 0o755);
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [spec, output, receipt] = Bun.argv.slice(2);
  assert(
    spec && output && receipt && Bun.argv.length === 5,
    'usage: import-guest.mts SPEC OUTPUT RECEIPT',
  );
  importPostmasterGuest(
    parseStrictJson(readFileSync(spec, 'utf8')) as ImportedGuest,
    output,
    receipt,
  );
}
