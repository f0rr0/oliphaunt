import assert from 'node:assert/strict';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { manifest as writeManifest } from '../../../src/wasix/postmaster/lib/build-sealed-carrier.mts';
import {
  installedClosureIdentityFromRecords,
  requiredModules,
} from '../../../src/wasix/postmaster/lib/guest-build-provenance.mts';
import {
  AGGREGATE_RELATIVE,
  safeRelative,
} from '../../../src/wasix/postmaster/lib/receipt-files.mts';
import {
  carrierTree,
  hashRegular,
  sourceFingerprint,
  verify,
} from '../../../src/wasix/postmaster/lib/verify-sealed-carrier.mts';
import { verifyReceipt } from '../../../src/wasix/postmaster/wasmer/bin/verify-postmaster-concurrency-contract.mts';
import { parseStrictJson } from '../../../tools/packaging/strict-json.mts';
import { declaredGuestInputs, validateImportedGuestReceipt } from './guest-inputs.mts';
import {
  canonicalJson,
  digest,
  nativeGuestReceipt,
  nativeWasmerReceipt,
  runtimeAbiFacts,
} from './native-receipts.mts';

const identity = (path: string) => {
  // Exact action inputs may be Bazel sandbox file projections. Output members
  // are checked independently by the strict no-follow carrier inventory.
  assert(statSync(path).isFile(), `Declared carrier input is not regular: ${path}`);
  const bytes = readFileSync(path);
  return { sha256: digest(bytes), size: bytes.length };
};
const json = (path: string) => parseStrictJson(readFileSync(path, 'utf8'));
const encode = (value: unknown) => `${canonicalJson(value)}\n`;

export function aotPlan(receipts: any[], artifacts: string[], abi: any) {
  const selected = new Map<string, string>();
  for (const artifact of artifacts) {
    assert(!selected.has(basename(artifact)), 'Duplicate AOT output basename');
    selected.set(basename(artifact), artifact);
  }
  const rows = new Map<string, { receipt: any; artifact: string }>();
  for (const { file, value } of receipts) {
    assert.equal(value.schema, 'oliphaunt.wasix-postmaster.aot.native.v1');
    assert.equal(value.runtime_abi_id, abi.runtime_abi_id);
    assert.equal(value.artifact_abi_version, abi.artifact_abi_version);
    assert.equal(value.target, abi.rust.target);
    assert.equal(value.engine, 'llvm-opta');
    assert.equal(value.cpu_policy, 'generic-baseline');
    assert.deepEqual(value.cpu_features, []);
    assert.deepEqual(value.flags, [
      '--llvm',
      '--llvm-opt-level',
      'aggressive',
      '--compiler-threads',
      '1',
      '--enable-exceptions',
      '--enable-threads',
    ]);
    assert(
      requiredModules.includes(value.module_path) && !rows.has(value.module_path),
      'Unknown/duplicate AOT module',
    );
    const name = basename(file).replace(/\.json$/, '.bin');
    const artifact = selected.get(name);
    assert(artifact, `Missing matching declared AOT artifact: ${name}`);
    selected.delete(name);
    rows.set(value.module_path, { receipt: value, artifact });
  }
  assert.deepEqual(
    [...rows.keys()].sort(),
    [...requiredModules].sort(),
    'AOT module closure differs',
  );
  assert.equal(selected.size, 0, 'Extra declared AOT artifact');
  return requiredModules.map((path) => {
    const row = rows.get(path);
    assert(row, `Missing AOT module: ${path}`);
    return { path, ...row };
  });
}

export function constructCarrier(spec: any, output: string, leaves: string[]) {
  assert.equal(new Set(leaves).size, leaves.length, 'Duplicate declared TreeArtifact child');
  const used = new Set<string>();
  const put = (relative: string, bytes: Uint8Array | string, executable = false) => {
    safeRelative(relative);
    const destination = join(output, relative);
    assert(
      !lstatSync(destination, { throwIfNoEntry: false }),
      `Carrier output collision: ${relative}`,
    );
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes, { flag: 'wx', mode: executable ? 0o755 : 0o644 });
  };
  const tree = (root: string) => {
    const records = leaves
      .filter((path) => path.startsWith(`${root}/`))
      .map((path) => {
        used.add(path);
        const relative = path.slice(root.length + 1);
        safeRelative(relative);
        return { relative, path, ...identity(path) };
      })
      .sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
    assert(records.length, `Empty declared TreeArtifact: ${root}`);
    return records;
  };
  for (const row of tree(spec.sealed))
    put(row.relative, readFileSync(row.path), row.relative.startsWith('bin/'));
  const sysroot = spec.guestReceipt
    ? undefined
    : tree(spec.sysroot).map(({ relative, sha256, size }) => ({
        relative,
        sha256,
        size,
      }));
  for (const resource of spec.resources) {
    if (resource.tree)
      for (const row of tree(resource.source))
        put(`${resource.destination}/${row.relative}`, readFileSync(row.path));
    else put(resource.destination, readFileSync(resource.source));
  }
  assert.equal(used.size, leaves.length, 'TreeArtifact child outside declared carrier inputs');
  put('bin/wasmer-headless', readFileSync(spec.executor), true);
  const executorAbi = json(spec.executorAbi),
    compilerAbi = json(spec.compilerAbi);
  assert.deepEqual(
    executorAbi,
    compilerAbi,
    'Executor/compiler actual serialization contracts differ',
  );
  const facts = runtimeAbiFacts(compilerAbi);
  const wasmer = {
    schema: 'oliphaunt.wasix-postmaster.wasmer-build.native.v1',
    runtime_abi: compilerAbi,
    canonical_patch_sha256: identity(spec.wasmerPatch).sha256,
    compiler: identity(spec.compiler),
  };
  const wasmerFacts = nativeWasmerReceipt(wasmer);
  put('wasmer-build.receipt', encode(wasmer));
  put(
    'postmaster-executor.receipt',
    encode({
      schema: 'oliphaunt.wasix-postmaster.executor-build.native.v1',
      runtime_abi_id: executorAbi.runtime_abi_id,
      wasmer_build_receipt_sha256: digest(encode(wasmer)),
      binary: identity(spec.executor),
      package: executorAbi.package.name,
      features: executorAbi.roles.executor.features,
    }),
  );
  const expectedGuest = declaredGuestInputs(spec);
  const source = { postgresql: expectedGuest.source.postgresql };
  const concurrencyPath = 'share/postgresql/wasix-postmaster.final-wasm-concurrency.receipt';
  if (!spec.guestReceipt)
    put(
      concurrencyPath,
      readFileSync(join(output, 'share/postgresql/wasix-postmaster.concurrency.receipt')),
    );
  const observed = verifyReceipt(
    readFileSync(join(output, concurrencyPath), 'utf8'),
    readFileSync(join(output, 'bin/postgres')),
  );
  const closure = [
    ...new Set([
      ...requiredModules,
      ...[...carrierTree(output)]
        .filter(([path, info]) => info.isFile() && path.startsWith('share/postgresql/'))
        .map(([path]) => path),
    ]),
  ].sort();
  const guest = spec.guestReceipt
    ? validateImportedGuestReceipt(readFileSync(spec.guestReceipt), spec)
    : {
        schema: 'oliphaunt.wasix-postmaster.guest-build.native.v1',
        source: expectedGuest.source,
        configuration: expectedGuest.configuration,
        sysroot: {
          schema: wasmerFacts.sysroot_variant,
          source: expectedGuest.libcSource,
          patch_sha256: expectedGuest.libcPatch,
          closure_sha256: digest(canonicalJson(sysroot)),
        },
        compiler: identity(spec.clang),
        core_profile: 'release-o3',
        postgres_version: source.postgresql.version,
        installed_closure_sha256: installedClosureIdentityFromRecords(
          closure.map((relative) => ({ relative, ...hashRegular(join(output, relative)) })),
        ),
        atomic_fence_total: Number(observed.atomic_fence_total),
        final_wasm_concurrency_receipt_sha256: hashRegular(join(output, concurrencyPath)).sha256,
        linear_memory_install_receipt_sha256: hashRegular(join(output, AGGREGATE_RELATIVE)).sha256,
      };
  nativeGuestReceipt(guest);
  const guestBytes = spec.guestReceipt ? readFileSync(spec.guestReceipt) : encode(guest);
  put('guest-build.receipt', guestBytes);
  const memory = json(join(output, AGGREGATE_RELATIVE));
  const rows: string[] = [];
  for (const { path, artifact, receipt } of aotPlan(
    spec.aotReceipts.map((file: string) => ({ file, value: json(file) })),
    spec.aot,
    compilerAbi,
  )) {
    const module = hashRegular(join(output, path));
    assert.deepEqual(module, receipt.module, `AOT source differs: ${path}`);
    assert.deepEqual(identity(artifact), receipt.artifact, `AOT bytes differ: ${path}`);
    assert.deepEqual(receipt.compiler, wasmer.compiler, `AOT compiler differs: ${path}`);
    const record = memory.modules.find((row: any) => row.path === path);
    assert(record && record['module-sha256'] === module.sha256, 'Missing memory-sealed module');
    const aotPath = `aot/${module.sha256.toUpperCase()}.bin`;
    put(aotPath, readFileSync(artifact));
    const alias = path.startsWith('bin/') ? `/${path}` : '';
    rows.push(
      [
        `runtime:${basename(path)}`,
        alias ? 'executable' : 'side-module',
        aotPath,
        path,
        receipt.artifact.sha256,
        receipt.artifact.size,
        module.sha256,
        module.size,
        alias,
      ].join('\t'),
    );
  }
  const rowFile = join(output, '.artifact-rows.tsv');
  writeFileSync(rowFile, `${rows.join('\n')}\n`, { flag: 'wx' });
  writeManifest([
    rowFile,
    output,
    join(output, 'manifest.json'),
    sourceFingerprint(output),
    'release-o3',
    digest(guestBytes),
    facts.target,
    facts.hostAbi,
    'llvm-opta;non-volatile-memops;readonly-funcref-table;generic-baseline',
    wasmerFacts.wasmer_source_commit,
    wasmerFacts.wasmer_patch_sha256,
    wasmerFacts.wasmer_cargo_lock_sha256,
    compilerAbi.runtime_abi_id,
    digest(encode(wasmer)),
    identity(spec.executor).sha256,
    String(identity(spec.executor).size),
    source.postgresql.version,
    facts.wasmerVersion,
    facts.wasixVersion,
    String(compilerAbi.artifact_abi_version),
    AGGREGATE_RELATIVE,
    guest.linear_memory_install_receipt_sha256,
  ]);
  rmSync(rowFile);
  const entries = [...carrierTree(output)];
  const inventory = entries
    .filter(([, info]) => info.isFile())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path]) => {
      const identity = hashRegular(join(output, path));
      return `${identity.sha256}\t${identity.size}\t${path}`;
    });
  put(
    'payload.files',
    `schema=oliphaunt.wasix-postmaster.payload-files.v1\n${inventory.join('\n')}\n`,
  );
  for (const [path, info] of [...carrierTree(output)].reverse())
    chmodSync(
      path === '.' ? output : join(output, path),
      info.isDirectory() || info.mode & 0o111 ? 0o555 : 0o444,
    );
  verify(
    output,
    digest(encode(wasmer)),
    source.postgresql.version,
    facts.wasmerVersion,
    facts.wasixVersion,
    compilerAbi.artifact_abi_version,
    output,
  );
}

if (import.meta.main) {
  const [spec, output, treeArgument] = Bun.argv.slice(2);
  assert.equal(Bun.argv.length, 5, 'usage: carrier.mts SPEC OUTPUT --tree-files=PARAM');
  assert(treeArgument.startsWith('--tree-files='));
  constructCarrier(
    json(spec),
    resolve(output),
    readFileSync(treeArgument.slice('--tree-files='.length), 'utf8').split('\n').filter(Boolean),
  );
}
