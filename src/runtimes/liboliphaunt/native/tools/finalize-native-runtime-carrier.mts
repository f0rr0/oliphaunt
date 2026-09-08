#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  bindNativeRuntimeResourceManifest,
  nativeRuntimeCarrierManifest,
  validateNativeRuntimeCarrier,
} from './native-runtime-carrier-contract.mts';

function fail(message) {
  throw new Error(`finalize-native-runtime-carrier.mts: ${message}`);
}

function treeBytes(root) {
  const metadata = lstatSync(root);
  if (metadata.isSymbolicLink()) fail(`carrier tree must not contain symlinks: ${root}`);
  if (metadata.isFile()) return metadata.size;
  if (!metadata.isDirectory()) fail(`carrier tree contains a special file: ${root}`);
  return readdirSync(root).reduce((total, name) => total + treeBytes(path.join(root, name)), 0);
}

function rewritePackageSizeReport(root) {
  const report = path.join(root, 'package-size.tsv');
  const rows = readFileSync(report, 'utf8').split(/\r?\n/u).filter(Boolean);
  if (rows.shift() !== 'kind\tid\textensions\tfiles\tbytes') {
    fail(`${report} has an unsupported header`);
  }
  const retained = rows.filter((row) => !row.startsWith('package\t'));
  const runtime = treeBytes(path.join(root, 'runtime/files'));
  const standard = treeBytes(path.join(root, 'cluster-seed/files'));
  const icu = treeBytes(path.join(root, 'cluster-seed-icu/files'));
  const staticRegistry = treeBytes(path.join(root, 'static-registry'));
  const total = runtime + standard + icu + staticRegistry;
  writeFileSync(
    report,
    [
      'kind\tid\textensions\tfiles\tbytes',
      `package\ttotal\t-\t-\t${total}`,
      `package\truntime\t-\t-\t${runtime}`,
      `package\tcluster-seed\t-\t-\t${standard}`,
      `package\tcluster-seed-icu\t-\t-\t${icu}`,
      `package\tstatic-registry\t-\t-\t${staticRegistry}`,
      ...retained,
      '',
    ].join('\n'),
  );
}

export function finalizeNativeRuntimeCarrier(root, target, icuData) {
  writeFileSync(path.join(root, 'manifest.properties'), nativeRuntimeCarrierManifest(target));
  const runtimeManifest = path.join(root, 'runtime/manifest.properties');
  if (existsSync(runtimeManifest)) {
    writeFileSync(
      runtimeManifest,
      bindNativeRuntimeResourceManifest(readFileSync(runtimeManifest), target),
    );
  } else {
    fail(`${runtimeManifest} is missing`);
  }
  if (existsSync(path.join(root, 'package-size.tsv'))) rewritePackageSizeReport(root);
  return validateNativeRuntimeCarrier(root, { icuData });
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined || values.has(key)) {
      fail('usage: --root DIR --target TARGET --icu-data DIR');
    }
    values.set(key, value);
  }
  const allowed = new Set(['--root', '--target', '--icu-data']);
  if (
    [...values.keys()].some((key) => !allowed.has(key)) ||
    !values.has('--root') ||
    !values.has('--target') ||
    !values.has('--icu-data')
  ) {
    fail('usage: --root DIR --target TARGET --icu-data DIR');
  }
  return {
    root: path.resolve(values.get('--root')),
    target: values.get('--target'),
    icuData: path.resolve(values.get('--icu-data')),
  };
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = finalizeNativeRuntimeCarrier(args.root, args.target, args.icuData);
    console.log(`clusterSeedTarget=${result.target}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
