#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditExtensionUpstreamLicenseSources } from '../../extensions/tools/extension-upstream-licenses.mts';
import { validateSource } from './source-fetch-core.mts';
import {
  defaultSourceScope,
  scopeIncludes,
  scopeIncludesExtensions,
  sourceDomainsForScope,
  sourceOrigins,
  sourceScopes,
} from './source-fetch-scopes.mts';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
process.chdir(workspaceRoot);

const allowedScopes = new Set(sourceScopes);
try {
  const [operation, output, ...args] = process.argv.slice(2);
  if (operation === 'audit') {
    const count = Number(output);
    if (count > 0) {
      const audited = auditExtensionUpstreamLicenseSources();
      if (!Number.isSafeInteger(audited) || audited < 1)
        throw new Error('extension legal audit inspected no pinned files');
      console.error(
        `audited ${audited} pinned extension legal source files after qualifying ${count} extension source checkouts`,
      );
    }
  } else if (operation === 'plan' && output) {
    writeFileSync(join(output, 'mode'), 'skip');
    const { scope, force, validateOnly, verifyOnly } = parseArgs(args);
    if (!allowedScopes.has(scope)) throw new Error('unsupported source fetch scope: ' + scope);
    let mode = verifyOnly ? 'verify' : 'fetch';
    if (
      !validateOnly &&
      !verifyOnly &&
      !force &&
      process.env.CI !== 'true' &&
      process.env.OLIPHAUNT_FETCH_SOURCES !== '1'
    ) {
      console.log(
        `source checkout fetch skipped outside CI for scope '${scope}'; set OLIPHAUNT_FETCH_SOURCES=1 or pass --force`,
      );
      mode = 'skip';
    }
    const sources = loadSourcesManifest(scope).sources.filter((source) =>
      scopeIncludes(scope, source.origin),
    );
    if (sources.length === 0)
      throw new Error('source metadata must contain at least one source pin');
    for (const source of sources) validateSource(source);
    if (validateOnly) mode = 'skip';
    writeFileSync(join(output, 'mode'), mode);
    writeFileSync(
      join(output, 'extension-count'),
      String(sources.filter((source) => source.origin === sourceOrigins.extension).length),
    );
    const pins = [];
    if (mode !== 'skip')
      for (const source of sources) {
        const file = join(output, source.name + '.json');
        writeFileSync(file, JSON.stringify(source));
        pins.push(file);
      }
    writeFileSync(join(output, 'pins'), pins.length ? pins.join('\0') + '\0' : '');
  } else
    throw new Error('source planning is internal; use bash third-party/tools/fetch-sources.sh');
} catch (error) {
  fail(error.message);
}

function parseArgs(args) {
  let selectedScope = defaultSourceScope;
  let sawScope = false;
  let forceFetch = false;
  let validateOnly = false;
  let verifyOnly = false;
  for (const arg of args) {
    if (arg === '--force') {
      forceFetch = true;
      continue;
    }
    if (arg === '--verify-only') {
      verifyOnly = true;
      continue;
    }
    if (arg === '--validate-only') {
      validateOnly = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log(
        `usage: bash third-party/tools/fetch-sources.sh [${sourceScopes.join('|')}] [--force|--validate-only|--verify-only]`,
      );
      process.exit(0);
    }
    if (sawScope) {
      fail(`unexpected argument '${arg}'`, 2);
    }
    selectedScope = arg;
    sawScope = true;
  }
  if (Number(forceFetch) + Number(validateOnly) + Number(verifyOnly) > 1) {
    fail('--force, --validate-only, and --verify-only are mutually exclusive', 2);
  }
  return { scope: selectedScope, force: forceFetch, validateOnly, verifyOnly };
}

function loadSourcesManifest(selectedScope) {
  const sources = [];
  const names = new Set();
  if (selectedScope === 'icu') {
    pushSourcePin(
      sources,
      names,
      join(workspaceRoot, 'database-resources/icu/source.toml'),
      sourceOrigins.sharedThirdParty,
    );
    return { sources };
  }
  if (scopeIncludes(selectedScope, sourceOrigins.sharedThirdParty)) {
    pushSourcePin(
      sources,
      names,
      join(workspaceRoot, 'database-resources/icu/source.toml'),
      sourceOrigins.sharedThirdParty,
    );
  }
  for (const [domain, origin] of sourceDomainsForScope(selectedScope)) {
    const domainDir = join(workspaceRoot, domain);
    if (!existsSync(domainDir)) throw new Error(`missing source directory: ${domainDir}`);
    for (const file of readdirSync(domainDir).sort()) {
      if (!file.endsWith('.toml')) {
        continue;
      }
      pushSourcePin(sources, names, join(domainDir, file), origin);
    }
  }
  if (scopeIncludesExtensions(selectedScope)) {
    for (const sourcePath of extensionSourcePinPaths()) {
      pushSourcePin(sources, names, sourcePath, sourceOrigins.extension);
    }
  }
  return { sources };
}

function extensionSourcePinPaths() {
  const root = join(workspaceRoot, 'extensions', 'external');
  const paths = [];
  collectSourcePins(root, paths);
  return paths.sort();
}

function collectSourcePins(dir, paths) {
  if (!existsSync(dir)) {
    return;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourcePins(path, paths);
    } else if (entry.name === 'source.toml') {
      paths.push(path);
    }
  }
}

function pushSourcePin(sources, names, path, origin) {
  const raw = readToml(path);
  const source = {
    name: stringField(raw, 'name', path),
    kind: raw.kind ?? 'git',
    url: stringField(raw, 'url', path),
    mirrorUrl: optionalStringField(raw, 'mirror_url', path),
    branch: stringField(raw, 'branch', path),
    commit: stringField(raw, 'commit', path),
    sha256: optionalStringField(raw, 'sha256', path),
    stripPrefix:
      optionalStringField(raw, 'strip_prefix', path) ??
      optionalStringField(raw, 'strip-prefix', path),
    origin,
  };
  if (names.has(source.name)) {
    throw new Error(`duplicate source pin '${source.name}' in source metadata`);
  }
  names.add(source.name);
  sources.push(source);
}

function readToml(path) {
  const text = readFileSync(path, 'utf8');
  try {
    return Bun.TOML.parse(text);
  } catch (error) {
    throw new Error(`parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function stringField(object, field, path) {
  const value = object[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${path} must set non-empty string field '${field}'`);
  }
  return value;
}

function optionalStringField(object, field, path) {
  const value = object[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`${path} field '${field}' must be a string`);
  }
  return value;
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}
