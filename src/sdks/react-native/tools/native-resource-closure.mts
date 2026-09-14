import fs from 'node:fs/promises';
import path from 'node:path';

const PORTABLE_ID = /^[A-Za-z0-9._-]{1,128}$/u;

function validCacheKey(value) {
  return PORTABLE_ID.test(value) && value !== '.' && value !== '..';
}
const RUNTIME_SCHEMA = 'oliphaunt-runtime-resources-v1';
const TARGET = 'ios-datum64';
const RESOURCE_FIELDS = new Set([
  'schema',
  'layout',
  'artifactRole',
  'catalogProfile',
  'clusterSeedTarget',
  'icuDataTreeSha256',
  'mode',
  'cacheKey',
  'selectedExtensions',
  'extensions',
  'runtimeFeatures',
  'sharedPreloadLibraries',
  'mobileStaticRegistryState',
  'mobileStaticRegistryRegistered',
  'mobileStaticRegistryPending',
  'nativeModuleStems',
  'mobileStaticRegistrySource',
]);
export function parseProperties(text, source) {
  const values = new Map();
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (!line) continue;
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error(`${source}:${index + 1} is not key=value`);
    const key = line.slice(0, separator);
    if (values.has(key)) throw new Error(`${source}:${index + 1} repeats ${key}`);
    values.set(key, line.slice(separator + 1));
  }
  return values;
}

export function requireProperty(values, key, expected, source) {
  if (values.get(key) !== expected) {
    throw new Error(
      `${source} must declare ${key}=${expected}; got ${values.get(key) ?? '<missing>'}`,
    );
  }
}

async function readProperties(file) {
  return parseProperties(await fs.readFile(file, 'utf8'), file);
}

function requireResourceFields(values, source) {
  const missing = [...RESOURCE_FIELDS].filter((key) => !values.has(key)).sort();
  const unsupported = [...values.keys()].filter((key) => !RESOURCE_FIELDS.has(key)).sort();
  if (missing.length > 0 || unsupported.length > 0) {
    throw new Error(
      `${source} must contain its exact canonical runtime fields; missing=${missing.join(',')}; unsupported=${unsupported.join(',')}`,
    );
  }
}

export async function validateNativeRuntimeClosure(root, { target = TARGET } = {}) {
  const source = path.join(root, 'runtime/manifest.properties');
  const runtime = await readProperties(source);
  requireResourceFields(runtime, source);
  requireProperty(runtime, 'schema', RUNTIME_SCHEMA, source);
  requireProperty(runtime, 'layout', 'postgres-runtime-files-v1', source);
  requireProperty(runtime, 'artifactRole', 'runtime', source);
  requireProperty(runtime, 'catalogProfile', '', source);
  requireProperty(runtime, 'clusterSeedTarget', target, source);
  requireProperty(runtime, 'mode', 'native-direct', source);
  if (!validCacheKey(runtime.get('cacheKey') ?? '')) {
    throw new Error(`${source} has an invalid runtime cache key`);
  }
  const expectedRegistrySource =
    runtime.get('mobileStaticRegistryState') === 'complete'
      ? 'static-registry/oliphaunt_static_registry.c'
      : '';
  requireProperty(runtime, 'mobileStaticRegistrySource', expectedRegistrySource, source);
  requireProperty(runtime, 'runtimeFeatures', '', source);
  requireProperty(runtime, 'icuDataTreeSha256', '', source);
  for (const relative of ['cluster-seed', 'cluster-seed-icu', 'runtime/files/share/icu']) {
    const member = path.join(root, relative);
    const exists = await fs.lstat(member).then(
      () => true,
      (error) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      },
    );
    if (exists) throw new Error(member + ' belongs to a separate database resource carrier');
  }
  return { runtime };
}
