#!/usr/bin/env bun
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT = resolve(ROOT, 'contract.toml');

function fail(message) {
  console.error(`extension-runtime-contract: ${message}`);
  process.exit(1);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

let data;
try {
  data = Bun.TOML.parse(await readFile(CONTRACT, 'utf8'));
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  fail(`cannot parse ${CONTRACT}: ${detail}`);
}

if (data.schema !== 'oliphaunt-extension-runtime-contract-v1') {
  fail('contract.toml must use schema oliphaunt-extension-runtime-contract-v1');
}

const runtime = data.runtime;
const selection = data.selection;
const artifacts = data.artifacts;
if (!isRecord(runtime) || !isRecord(selection) || !isRecord(artifacts)) {
  fail('contract.toml must define runtime, selection, and artifacts tables');
}

if (runtime.resource_layout !== 'share/postgresql/extension') {
  fail('runtime.resource_layout must match PostgreSQL extension resources');
}
if (runtime.dynamic_loader !== 'postgres-compatible') {
  fail('runtime.dynamic_loader must stay PostgreSQL-compatible');
}
if (runtime.static_registry_abi !== 1) {
  fail('runtime.static_registry_abi must be 1 until the C ABI changes');
}
if (selection.unit !== 'sql-extension-name') {
  fail('selection.unit must be exact SQL extension name');
}
for (const key of ['implicit_extensions', 'implicit_extension_groups']) {
  if (selection[key] !== false) {
    fail(`selection.${key} must be false`);
  }
}
if (artifacts.base_runtime_contains_optional_extensions !== false) {
  fail('base runtime must not contain optional extension artifacts');
}
if (artifacts.extension_artifacts_are_exact !== true) {
  fail('extension artifacts must be exact-selected');
}
