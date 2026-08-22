#!/usr/bin/env node

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA = 'oliphaunt-android-static-extension-link-v1';

export function validateAndroidLinkEvidence({
  evidenceFile,
  expectedAbi,
  expectedModuleStems,
  staticRegistryManifest,
  target,
}) {
  const registry = readProperties(staticRegistryManifest);
  const expectedExtensions = new Set(csv(expectedModuleStems));
  const expectedDependencies = new Set(csv(registry.dependencyArchives));
  const extensions = new Set();
  const dependencies = new Set();
  let schemaRows = 0;
  let abiRows = 0;
  let runtimeRows = 0;

  const lines = readFileSync(evidenceFile, 'utf8').split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index]) continue;
    const parts = lines[index].split('\t');
    const line = index + 1;
    switch (parts[0]) {
      case 'schema':
        exact(parts, ['schema', SCHEMA], evidenceFile, line);
        schemaRows += 1;
        break;
      case 'abi':
        exact(parts, ['abi', expectedAbi], evidenceFile, line);
        abiRows += 1;
        break;
      case 'runtime':
        if (parts.length !== 3 || parts[1] !== 'liboliphaunt') {
          fail(evidenceFile, line, 'invalid runtime row');
        }
        requireFile(parts[2], evidenceFile, line, 'runtime');
        if (path.basename(parts[2]) !== 'liboliphaunt.so') {
          fail(evidenceFile, line, 'runtime path must end in liboliphaunt.so');
        }
        runtimeRows += 1;
        break;
      case 'extension':
        validateArchiveRow({
          parts,
          evidenceFile,
          line,
          registry,
          target,
          kind: 'extension',
          expectedKey: stem => `module.${stem}.archive.${target}`,
          expectedName: stem => `liboliphaunt_extension_${stem}.a`,
        });
        addUnique(extensions, parts[1], evidenceFile, line, 'extension');
        break;
      case 'dependency':
        validateArchiveRow({
          parts,
          evidenceFile,
          line,
          registry,
          target,
          kind: 'dependency',
          expectedKey: name => `dependency.${name}.archive.${target}`,
        });
        addUnique(dependencies, parts[1], evidenceFile, line, 'dependency');
        break;
      default:
        fail(evidenceFile, line, `unknown row kind ${JSON.stringify(parts[0])}`);
    }
  }

  if (schemaRows !== 1) throw new Error(`${evidenceFile} must contain exactly one schema row`);
  if (abiRows !== 1) throw new Error(`${evidenceFile} must contain exactly one ABI row`);
  if (runtimeRows !== 1) throw new Error(`${evidenceFile} must contain exactly one runtime row`);
  exactSet(extensions, expectedExtensions, evidenceFile, 'extension');
  exactSet(dependencies, expectedDependencies, evidenceFile, 'dependency');
  return { extensions: [...extensions].sort(), dependencies: [...dependencies].sort() };
}

function validateArchiveRow({
  parts,
  evidenceFile,
  line,
  registry,
  target,
  kind,
  expectedKey,
  expectedName,
}) {
  if (parts.length !== 3 || !parts[1]) fail(evidenceFile, line, `invalid ${kind} row`);
  const [name, rawArchive] = [parts[1], parts[2]];
  const archive = requireFile(rawArchive, evidenceFile, line, kind);
  const relative = registry[expectedKey(name)];
  if (!relative) {
    fail(evidenceFile, line, `${kind} ${JSON.stringify(name)} is absent from the static registry for ${target}`);
  }
  if (expectedName && path.basename(archive) !== expectedName(name)) {
    fail(evidenceFile, line, `${kind} archive name does not match ${JSON.stringify(name)}`);
  }
  if (!slash(archive).endsWith(slash(relative))) {
    fail(evidenceFile, line, `${kind} archive does not match registry path ${JSON.stringify(relative)}`);
  }
}

function readProperties(file) {
  const properties = {};
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error(`${file} contains an invalid properties row: ${rawLine}`);
    properties[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return properties;
}

function requireFile(raw, evidenceFile, line, kind) {
  const resolved = path.isAbsolute(raw) ? raw : path.resolve(path.dirname(evidenceFile), raw);
  try {
    if (!statSync(resolved).isFile()) throw new Error('not a file');
  } catch {
    fail(evidenceFile, line, `${kind} path does not exist: ${resolved}`);
  }
  return resolved;
}

function exact(actual, expected, file, line) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(file, line, `expected ${expected.join('\t')}`);
}

function exactSet(actual, expected, file, kind) {
  const missing = [...expected].filter(value => !actual.has(value)).sort();
  const unexpected = [...actual].filter(value => !expected.has(value)).sort();
  if (missing.length || unexpected.length) {
    throw new Error(
      `${file} ${kind} set mismatch (missing=${missing.join(',') || '-'}, unexpected=${unexpected.join(',') || '-'})`,
    );
  }
}

function addUnique(set, value, file, line, kind) {
  if (set.has(value)) fail(file, line, `duplicate ${kind} ${JSON.stringify(value)}`);
  set.add(value);
}

function csv(value) {
  return String(value ?? '').split(',').map(item => item.trim()).filter(Boolean);
}

function slash(value) {
  return String(value).split(path.sep).join('/');
}

function fail(file, line, message) {
  throw new Error(`${file}:${line} ${message}`);
}

function parseCli(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error('arguments must be --name value pairs');
    values[key.slice(2)] = value;
  }
  return values;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseCli(process.argv.slice(2));
    validateAndroidLinkEvidence({
      evidenceFile: args.evidence,
      expectedAbi: args.abi,
      expectedModuleStems: args['module-stems'],
      staticRegistryManifest: args['static-registry'],
      target: args.target,
    });
    console.log(`validated Android static-extension link evidence: ${args.evidence}`);
  } catch (error) {
    console.error(`validate-android-link-evidence.mjs: ${error.message}`);
    process.exitCode = 1;
  }
}
