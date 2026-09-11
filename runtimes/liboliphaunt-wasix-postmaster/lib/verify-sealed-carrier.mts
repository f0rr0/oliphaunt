#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { type Stats, lstatSync, readdirSync } from 'node:fs';
import { join, basename, posix, resolve } from 'node:path';
import {
  member,
  safeRelative,
  stableRead,
  AGGREGATE_RELATIVE,
} from './linear-memory-transaction.mts';
import { profileId, profile } from './linear-memory-profile.mts';
import {
  type Inventory,
  exactKeys,
  requireSha,
  parseJson,
  readRegular,
  linearMemorySourceHashes,
  validateExportChain,
} from './sealed-export-chain.mts';
import {
  sideModulePolicy,
  requiredModules,
  installedClosureIdentityFromRecords,
} from './guest-build-provenance.mts';
import { verifyReceipt } from '../wasmer/bin/verify-postmaster-concurrency-contract.mts';
const names = (value: string) => value.trim().split(/\s+/);
const TOP_LEVEL_MANIFEST_KEYS = names(
  `format-version schema source-lane source-fingerprint core-profile guest-build-recipe-sha256 postgres-version target-triple host-abi engine compiler-config cpu-policy cpu-features wasmer-version wasmer-wasix-version wasmer-source-commit wasmer-patch-sha256 wasmer-cargo-lock-sha256 artifact-abi-version runtime-abi-id producer-recipe-sha256 executor-engine executor-sha256 executor-size linear-memory-profile wasm-features entrypoint artifacts`,
);
const ARTIFACT_KEYS = names(
  `name kind path module-path sha256 raw-sha256 raw-size module-sha256 module-size linear-memory compressed exec-aliases`,
);
const RECEIPT_KEYS = names(
  `schema build_recipe_sha256 wasmer_source_commit wasmer_napi_commit wasmer_test_files_commit wasmer_spec_commit wasmer_patch_sha256 wasmer_prepared_signature_sha256 wasmer_cargo_lock_sha256 wasmer_binary_sha256 wasmer_features wasmer_headless_binary_sha256 wasmer_headless_features runtime_abi_id artifact_abi_version wasix_libc_source_commit wasix_libc_patch_sha256 wasix_libc_prepared_signature_sha256 sysroot_carrier_manifest_sha256 sysroot_variant sysroot_variant_manifest_sha256 host_platform host_abi rustc_host rustc_version llvm_version`,
);
const POSTMASTER_EXECUTOR_RECEIPT_KEYS = names(
  `schema build_recipe_sha256 wasmer_build_receipt_sha256 wasmer_source_commit wasmer_patch_sha256 wasmer_prepared_signature_sha256 wasmer_cargo_lock_sha256 runtime_abi_id artifact_abi_version executor_package executor_binary executor_features executor_role runtime_policy_id cli_contract executor_binary_sha256 start_proof_binary start_proof_features start_proof_policy start_proof_binary_sha256 memory_profile_binary memory_profile_features linear_memory_profile_id memory_profile_binary_sha256 postmaster_compiler_binary postmaster_compiler_features compiler_cpu_policy compiler_cpu_features postmaster_compiler_binary_sha256 host_platform host_abi rustc_host rustc_version`,
);
const GUEST_BUILD_RECEIPT_KEYS = names(
  `schema core_profile guest_source_signature_sha256 docker_image_id installed_closure_sha256 child_backend effective_cflags effective_ldflags effective_wasm_opt effective_wasm_opt_flags effective_wasm_opt_suppress_default atomic_fence_total atomic_fence_set_latch atomic_fence_reset_latch atomic_fence_wait_event_set_wait latch_state_contract final_wasm_concurrency_receipt_sha256 linear_memory_profile_id linear_memory_install_receipt_sha256 postgres_tag postgres_version sysroot_variant`,
);
const concurrencyPath = 'share/postgresql/wasix-postmaster.final-wasm-concurrency.receipt';
const rootFiles = [
  'guest-build.receipt',
  'manifest.json',
  'postmaster-executor.receipt',
  'wasmer-build.receipt',
];
const expectedArtifacts = [
  { name: 'runtime:initdb', kind: 'executable', path: 'bin/initdb', aliases: ['/bin/initdb'] },
  {
    name: 'runtime:postgres',
    kind: 'executable',
    path: 'bin/postgres',
    aliases: ['/bin/postgres'],
  },
  ...sideModulePolicy.map(({ relative }) => ({
    name: `runtime:${basename(relative)}`,
    kind: 'side-module',
    path: relative,
    aliases: [],
  })),
];
const equal = (actual: unknown, expected: unknown, label: string) =>
  assert.deepEqual(actual, expected, `${label} differs`);
const setEqual = (actual: Iterable<string>, expected: Iterable<string>, label: string) =>
  equal([...actual].sort(), [...expected].sort(), label);
const text = (bytes: Uint8Array) => {
  const value = new TextDecoder('utf8', { fatal: true }).decode(bytes);
  assert(
    !/[\r\0]/.test(value) && value.endsWith('\n'),
    'receipt must be canonical newline-terminated text',
  );
  return value;
};
function identity(inventory: Inventory, path: string) {
  safeRelative(path);
  const value = inventory.get(path);
  assert(value, `path is not inventoried: ${path}`);
  return value;
}
function objectValues(
  actual: { [key: string]: any },
  expected: { [key: string]: any },
  label: string,
) {
  for (const [key, value] of Object.entries(expected)) equal(actual[key], value, `${label} ${key}`);
}
function integer(value: unknown, minimum = 0): asserts value is number {
  assert(Number.isSafeInteger(value) && (value as number) >= minimum, 'invalid integer');
}
export function parseReceipt(
  root: string,
  inventory: Inventory | undefined,
  path: string,
  keys: string[],
  flags = false,
) {
  const lines = text(readRegular(root, path, inventory))
    .slice(0, -1)
    .split('\n');
  assert.equal(lines.length, keys.length, `${path} field count differs`);
  return Object.fromEntries(
    lines.map((line, index) => {
      const separator = line.indexOf('='),
        key = line.slice(0, separator),
        value = line.slice(separator + 1);
      assert(
        separator > 0 && key === keys[index] && value && (flags || !value.includes('=')),
        `${path} non-canonical field: ${keys[index]}`,
      );
      return [key, value];
    }),
  );
}
export function executorReceipt(
  root: string,
  inventory: Inventory,
  wasmer: { [key: string]: string },
) {
  const receipt = parseReceipt(
    root,
    inventory,
    'postmaster-executor.receipt',
    POSTMASTER_EXECUTOR_RECEIPT_KEYS,
  );
  for (const key of POSTMASTER_EXECUTOR_RECEIPT_KEYS.filter(
    (key) => key.endsWith('_sha256') || key === 'runtime_abi_id',
  ))
    requireSha(receipt[key]);
  const common =
    names(`build_recipe_sha256 wasmer_source_commit wasmer_patch_sha256 wasmer_prepared_signature_sha256
 wasmer_cargo_lock_sha256 runtime_abi_id artifact_abi_version host_platform host_abi rustc_host rustc_version`);
  for (const key of common) equal(receipt[key], wasmer[key], `executor/Wasmer receipt ${key}`);
  objectValues(
    receipt,
    {
      schema: 'oliphaunt.wasix-postmaster.postmaster-executor-build.v3',
      wasmer_build_receipt_sha256: identity(inventory, 'wasmer-build.receipt').sha256,
      executor_binary_sha256: identity(inventory, 'bin/wasmer-headless').sha256,
      executor_package: 'oliphaunt-wasix-postmaster-executor',
      executor_binary: 'oliphaunt-wasix-postmaster-executor',
      executor_features: 'product-executor',
      executor_role: 'postmaster-product',
      runtime_policy_id:
        'oliphaunt.wasix-postmaster.tokio.2-async.embedded-postmaster-v1-budget96.v2',
      cli_contract: 'sealed-postmaster-run-v1',
      start_proof_binary: 'oliphaunt-wasix-start-proof',
      start_proof_features: 'start-proof-tool',
      start_proof_policy: 'llvm-shared-memory-init-restricted-effects.v1',
      memory_profile_binary: 'oliphaunt-wasix-memory-profile',
      memory_profile_features: 'memory-profile-tool',
      linear_memory_profile_id: profileId,
      postmaster_compiler_binary: 'oliphaunt-wasix-postmaster-compiler',
      postmaster_compiler_features: 'product-compiler',
      compiler_cpu_policy: 'generic-baseline',
      compiler_cpu_features: 'none',
    },
    'executor receipt',
  );
  return receipt;
}
export function guestReceipt(root: string, inventory?: Inventory) {
  const receipt = parseReceipt(
    root,
    inventory,
    'guest-build.receipt',
    GUEST_BUILD_RECEIPT_KEYS,
    true,
  );
  for (const key of GUEST_BUILD_RECEIPT_KEYS.filter((key) => key.endsWith('_sha256')))
    requireSha(receipt[key]);
  assert(
    /^sha256:[0-9a-f]{64}$/.test(receipt.docker_image_id),
    'guest builder must be an immutable Docker image',
  );
  assert(['yes', 'no'].includes(receipt.effective_wasm_opt), 'invalid wasm-opt mode');
  assert(/^[1-9][0-9]*$/.test(receipt.atomic_fence_total), 'invalid fence total');
  objectValues(
    receipt,
    {
      schema: 'oliphaunt.wasix-postmaster.guest-build.v5',
      core_profile: 'release-o3',
      child_backend: 'exec',
      effective_wasm_opt_suppress_default: 'yes',
      atomic_fence_set_latch: '2',
      atomic_fence_reset_latch: '1',
      atomic_fence_wait_event_set_wait: '1',
      latch_state_contract: 'packed-atomic-v1',
      linear_memory_profile_id: profileId,
    },
    'guest receipt',
  );
  return receipt;
}
export function carrierTree(root: string) {
  const entries = new Map<string, Stats>();
  function walk(relative: string) {
    const path = relative === '.' ? root : member(root, relative),
      info = lstatSync(path);
    assert(info.isDirectory(), `carrier parent is not a real directory: ${path}`);
    entries.set(relative, info);
    const directories: string[] = [];
    for (const name of readdirSync(path).sort()) {
      const child = relative === '.' ? name : `${relative}/${name}`;
      safeRelative(child);
      const info = lstatSync(join(path, name));
      if (info.isDirectory()) directories.push(child);
      else {
        assert(info.isFile(), `carrier entry is not a regular file: ${child}`);
        entries.set(child, info);
      }
    }
    for (const child of directories) walk(child);
  }
  walk('.');
  return entries;
}
export function hashRegular(path: string) {
  const hash = createHash('sha256');
  const info = stableRead(path, (chunk) => {
    hash.update(chunk);
  });
  return { size: Number(info.size), sha256: hash.digest('hex') };
}
export function parsePayloadInventory(data: Buffer) {
  const lines = text(data).slice(0, -1).split('\n');
  equal(lines.shift(), 'schema=oliphaunt.wasix-postmaster.payload-files.v1', 'payload schema');
  const inventory: Inventory = new Map();
  let previous = '';
  for (const line of lines) {
    const [digest, sizeText, path, extra] = line.split('\t');
    assert(extra === undefined && path, 'payload row must have three fields');
    requireSha(digest);
    assert(/^(0|[1-9][0-9]*)$/.test(sizeText), 'invalid payload size');
    safeRelative(path);
    assert(path !== 'payload.files' && path > previous, 'payload paths must be sorted and unique');
    previous = path;
    const size = Number(sizeText);
    integer(size);
    inventory.set(path, { size, sha256: digest });
  }
  assert(inventory.size, 'empty inventory');
  return inventory;
}
export function verifyInventory(root: string) {
  const files = new Set<string>(),
    directories = new Set<string>();
  for (const [path, info] of carrierTree(root)) {
    const mode = info.mode & 0o7777;
    assert(
      info.isDirectory() ? mode === 0o555 : [0o444, 0o555].includes(mode),
      `carrier entry is not read-only: ${path}`,
    );
    if (path !== '.') (info.isDirectory() ? directories : files).add(path);
  }
  const inventory = parsePayloadInventory(readRegular(root, 'payload.files'));
  const expectedFiles = new Set([...inventory.keys(), 'payload.files']),
    expectedDirs = new Set<string>();
  for (const path of expectedFiles)
    for (let parent = posix.dirname(path); parent !== '.'; parent = posix.dirname(parent))
      expectedDirs.add(parent);
  setEqual(files, expectedFiles, 'inventory file closure');
  setEqual(directories, expectedDirs, 'inventory directory closure');
  for (const [path, expected] of inventory) {
    const hash = createHash('sha256');
    const info = stableRead(
      member(root, path),
      (chunk) => {
        hash.update(chunk);
      },
      expected.size,
    );
    equal(Number(info.size), expected.size, `payload size ${path}`);
    equal(hash.digest('hex'), expected.sha256, `payload digest ${path}`);
  }
  const paths = [...inventory.keys()];
  setEqual(
    paths.filter((path) => !path.includes('/')),
    rootFiles,
    'carrier root',
  );
  setEqual(
    paths.filter((path) => path.startsWith('bin/')),
    ['bin/initdb', 'bin/postgres', 'bin/wasmer-headless'],
    'carrier bin',
  );
  setEqual(
    paths.filter((path) => path.startsWith('lib/')),
    sideModulePolicy.flatMap(({ relative, aliases }) => [relative, ...aliases]),
    'carrier lib',
  );
  assert(
    paths.some((path) => path.startsWith('share/postgresql/')),
    'empty PostgreSQL share tree',
  );
  assert(
    paths.every(
      (path) =>
        rootFiles.includes(path) || /^(bin\/|lib\/|share\/postgresql\/|aot\/|memory\/)/.test(path),
    ),
    'file outside carrier closure',
  );
  for (const { relative, aliases } of sideModulePolicy)
    for (const alias of aliases)
      equal(identity(inventory, alias), identity(inventory, relative), `alias ${alias}`);
  return inventory;
}
export function sourceFingerprint(root: string, inventory?: Inventory) {
  const hash = createHash('sha256');
  for (const [path, info] of carrierTree(root)) {
    if (!info.isFile() || !/^(bin|lib|share)\//.test(path) || path === 'bin/wasmer-headless')
      continue;
    const { size, sha256 } = inventory
      ? identity(inventory, path)
      : hashRegular(member(root, path));
    for (const value of [path, String(size), sha256]) {
      const bytes = Buffer.from(value),
        length = Buffer.alloc(8);
      length.writeBigUInt64BE(BigInt(bytes.length));
      hash.update(length).update(bytes);
    }
  }
  return hash.digest('hex');
}
export function verify(
  root: string,
  producer: string,
  pgVersion: string,
  wasmerVersion: string,
  wasixVersion: string,
  abi: number,
  canonicalRoot: string,
) {
  equal(resolve(root), resolve(canonicalRoot), 'canonical carrier root');
  requireSha(producer);
  integer(abi);
  const inventory = verifyInventory(root);
  const json = (path: string) => parseJson(readRegular(root, path, inventory));
  const wasmer = parseReceipt(root, inventory, 'wasmer-build.receipt', RECEIPT_KEYS);
  const executor = executorReceipt(root, inventory, wasmer),
    guest = guestReceipt(root, inventory);
  equal(
    identity(inventory, concurrencyPath).sha256,
    guest.final_wasm_concurrency_receipt_sha256,
    'guest concurrency binding',
  );
  const concurrency = verifyReceipt(
    text(readRegular(root, concurrencyPath, inventory)),
    readRegular(root, 'bin/postgres', inventory),
  );
  equal(concurrency.atomic_fence_total, guest.atomic_fence_total, 'final fence total');
  const manifest = json('manifest.json');
  exactKeys(manifest, TOP_LEVEL_MANIFEST_KEYS, 'sealed manifest');
  const headless = identity(inventory, 'bin/wasmer-headless');
  integer(headless.size, 1);
  objectValues(
    manifest,
    {
      'format-version': 6,
      schema: 'oliphaunt.wasix-postmaster.sealed-aot.v5',
      'source-lane': 'wasix-postmaster',
      'core-profile': 'release-o3',
      'guest-build-recipe-sha256': identity(inventory, 'guest-build.receipt').sha256,
      'postgres-version': pgVersion,
      'target-triple': wasmer.rustc_host,
      'host-abi': wasmer.host_abi,
      engine: 'llvm-opta',
      'cpu-policy': 'generic-baseline',
      'cpu-features': [],
      'wasmer-version': wasmerVersion,
      'wasmer-wasix-version': wasixVersion,
      'wasmer-source-commit': wasmer.wasmer_source_commit,
      'wasmer-patch-sha256': wasmer.wasmer_patch_sha256,
      'wasmer-cargo-lock-sha256': wasmer.wasmer_cargo_lock_sha256,
      'artifact-abi-version': abi,
      'runtime-abi-id': wasmer.runtime_abi_id,
      'producer-recipe-sha256': producer,
      'executor-engine': 'engine-headless',
      'executor-sha256': headless.sha256,
      'executor-size': headless.size,
      'wasm-features': ['exceptions', 'threads'],
      entrypoint: 'runtime:postgres',
      'source-fingerprint': sourceFingerprint(root, inventory),
    },
    'sealed manifest',
  );
  assert(
    typeof manifest['compiler-config'] === 'string' && manifest['compiler-config'],
    'empty compiler config',
  );
  equal(wasmer.artifact_abi_version, String(abi), 'Wasmer ABI');
  equal(executor.executor_binary_sha256, headless.sha256, 'selected executor');
  objectValues(
    guest,
    { postgres_version: pgVersion, sysroot_variant: wasmer.sysroot_variant },
    'guest receipt',
  );
  const linear = identity(inventory, AGGREGATE_RELATIVE);
  integer(linear.size, 1);
  const profileKeys = names(
    'address-width supported-host-pointer-width maximum-pages maximum-bytes static-bound-pages static-offset-guard-bytes static-access-lowering',
  );
  equal(
    manifest['linear-memory-profile'],
    {
      id: profileId,
      ...Object.fromEntries(profileKeys.map((key) => [key, profile[key]])),
      'install-receipt-path': AGGREGATE_RELATIVE,
      'install-receipt-sha256': linear.sha256,
    },
    'manifest memory profile',
  );
  equal(guest.linear_memory_install_receipt_sha256, linear.sha256, 'guest memory binding');
  const sources = linearMemorySourceHashes(root, inventory);
  validateExportChain(root, join(import.meta.dirname, '..'), sources, inventory);
  const guestPaths = [
    ...new Set(
      [...requiredModules, ...inventory.keys()].filter(
        (path) => requiredModules.includes(path) || path.startsWith('share/postgresql/'),
      ),
    ),
  ].sort();
  equal(
    guest.installed_closure_sha256,
    installedClosureIdentityFromRecords(
      guestPaths.map((relative) => ({ relative, ...identity(inventory, relative) })),
    ),
    'guest installed closure',
  );
  assert(
    Array.isArray(manifest.artifacts) && manifest.artifacts.length === expectedArtifacts.length,
    'artifact closure differs',
  );
  const aotPaths = new Set<string>(),
    moduleHashes = new Set<string>();
  for (const [index, expected] of expectedArtifacts.entries()) {
    const artifact = manifest.artifacts[index];
    exactKeys(artifact, ARTIFACT_KEYS, 'artifact');
    const module = identity(inventory, expected.path);
    assert(!moduleHashes.has(module.sha256), 'duplicate module digest');
    moduleHashes.add(module.sha256);
    const path = `aot/${module.sha256.toUpperCase()}.bin`,
      aot = identity(inventory, path);
    aotPaths.add(path);
    assert(sources.has(expected.path), `memory receipt lacks ${expected.path}`);
    objectValues(
      artifact,
      {
        name: expected.name,
        kind: expected.kind,
        'module-path': expected.path,
        'exec-aliases': expected.aliases,
        compressed: false,
        'module-sha256': module.sha256,
        'module-size': module.size,
        path,
        sha256: aot.sha256,
        'raw-sha256': aot.sha256,
        'raw-size': aot.size,
        'linear-memory': {
          'profile-id': profileId,
          'install-receipt-sha256': linear.sha256,
          'source-module-sha256': sources.get(expected.path),
        },
      },
      `artifact ${expected.name}`,
    );
  }
  setEqual(
    [...inventory.keys()].filter((path) => path.startsWith('aot/')),
    aotPaths,
    'AOT closure',
  );
  assert(
    ![...inventory.keys()].some((path) => path.startsWith('memory/')),
    'unsupported preinitialized-memory payloads',
  );
}
if (import.meta.main) {
  try {
    const [command, root, ...args] = process.argv.slice(2);
    assert(root, 'carrier root is required');
    if (command === 'regular-identity' && !args.length) {
      const hash = createHash('sha256');
      const info = stableRead(root, (chunk) => {
        hash.update(chunk);
      });
      console.log([hash.digest('hex'), info.dev, info.ino].join('\t'));
    } else if (command === 'provenance' && !args.length) {
      const manifest = parseJson(readRegular(root, 'manifest.json'));
      assert(
        ['release-o3', 'safe-o2'].includes(manifest['core-profile']),
        'sealed carrier core profile differs',
      );
      requireSha(manifest['guest-build-recipe-sha256']);
      console.log([manifest['core-profile'], manifest['guest-build-recipe-sha256']].join('\t'));
    } else if (command === 'recipe-inputs' && !args.length) {
      assert(lstatSync(root).isDirectory(), 'carrier root must be a non-symlink directory');
      const manifest = parseJson(readRegular(root, 'manifest.json'));
      const values = ['compiler-config', 'target-triple', 'source-fingerprint'].map((key) => {
        const value = manifest[key];
        assert(typeof value === 'string' && value && !/[\r\n\0]/.test(value), `invalid ${key}`);
        return value;
      });
      requireSha(values[2]);
      console.log(values.join('\n'));
    } else if (command === 'executor-selection' && !args.length) {
      const inventory = verifyInventory(root),
        wasmer = parseReceipt(root, inventory, 'wasmer-build.receipt', RECEIPT_KEYS);
      executorReceipt(root, inventory, wasmer);
      const manifest = parseJson(readRegular(root, 'manifest.json', inventory)),
        executor = identity(inventory, 'bin/wasmer-headless');
      equal(manifest['executor-sha256'], executor.sha256, 'selected executor digest');
      equal(manifest['executor-size'], executor.size, 'selected executor size');
      console.log(
        [
          'postmaster-product',
          'postmaster-executor.receipt',
          identity(inventory, 'postmaster-executor.receipt').sha256,
          executor.sha256,
        ].join('\t'),
      );
    } else {
      assert(
        command === 'verify' && args.length === 6,
        'usage: verify-sealed-carrier.mts recipe-inputs ROOT | executor-selection ROOT | verify ROOT PRODUCER PG WASMER WASIX ABI CANONICAL_ROOT',
      );
      assert(/^(0|[1-9][0-9]*)$/.test(args[4]), 'invalid artifact ABI');
      verify(root, args[0], args[1], args[2], args[3], Number(args[4]), args[5]);
    }
  } catch (error) {
    console.error(
      `sealed carrier verification failed: ${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 2;
  }
}
