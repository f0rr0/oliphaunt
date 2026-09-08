#!/usr/bin/env node

import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  NATIVE_CLUSTER_SEED_TARGETS,
  bindNativeClusterSeedManifest,
  validateNativeClusterSeedDirectory,
} from '../../../../shared/cluster-seed-contract/native-manifest.mts';

const TOOL = 'stage-native-cluster-seed.mts';
function fail(message) {
  throw new Error(`${TOOL}: ${message}`);
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) {
      fail(
        'usage: stage-native-cluster-seed.mts --runtime DIR --destination DIR --target TARGET --profile standard|icu [--icu-data DIR]',
      );
    }
    if (values.has(key)) fail(`repeated argument ${key}`);
    values.set(key, value);
  }
  const allowed = new Set(['--runtime', '--destination', '--target', '--profile', '--icu-data']);
  for (const key of values.keys()) if (!allowed.has(key)) fail(`unknown argument ${key}`);
  const runtime = values.get('--runtime');
  const destination = values.get('--destination');
  const target = values.get('--target');
  const profile = values.get('--profile');
  const icuData = values.get('--icu-data');
  if (!runtime || !destination || !target || !['standard', 'icu'].includes(profile)) {
    fail('runtime, destination, target, and profile=standard|icu are required');
  }
  if (profile === 'icu' && !icuData) fail('profile=icu requires --icu-data DIR');
  if (profile === 'standard' && icuData) fail('profile=standard must not receive --icu-data');
  return Object.freeze({
    runtime: path.resolve(runtime),
    destination: path.resolve(destination),
    target,
    profile,
    icuData: icuData === undefined ? undefined : path.resolve(icuData),
  });
}

function requireDirectory(directory, label) {
  if (!existsSync(directory)) fail(`${label} does not exist: ${directory}`);
}

const [mode, ...argv] = process.argv.slice(2);
const source = mode === 'install' ? argv.shift() : undefined;
if (!['prepare', 'install'].includes(mode) || (mode === 'install' && !source)) {
  fail('usage: stage-native-cluster-seed.mts prepare|install [prepared-seed] <seed options>');
}
const args = parseArgs(argv);
requireDirectory(args.runtime, 'native runtime');
if (args.icuData !== undefined) requireDirectory(args.icuData, 'ICU data');
if (!NATIVE_CLUSTER_SEED_TARGETS.includes(args.target))
  fail('unsupported native cluster-seed target');
if (args.destination === path.parse(args.destination).root)
  fail('destination must not be a filesystem root');
if (mode === 'prepare') {
  for (const value of [
    args.runtime,
    args.destination,
    args.target,
    args.profile,
    args.icuData ?? '',
  ]) {
    if (value.includes('\0')) fail('cluster-seed paths must not contain NUL');
    process.stdout.write(value + '\0');
  }
} else {
  const manifestPath = path.join(source, 'manifest.properties');
  writeFileSync(
    manifestPath,
    bindNativeClusterSeedManifest(readFileSync(manifestPath), args.target, args.profile),
  );
  validateNativeClusterSeedDirectory(source, args.profile, {
    target: args.target,
    icuData: args.icuData,
  });
  rmSync(args.destination, { recursive: true, force: true });
  cpSync(source, args.destination, { recursive: true, errorOnExist: true });
  console.log(
    `clusterSeed=${args.destination}\ncatalogProfile=${args.profile}\ntarget=${args.target}`,
  );
}
