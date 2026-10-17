import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { generateUniffi } from '../uniffi.mts';

export function validateKotlinConfiguration(configuration: unknown) {
  const values = configuration as {
    crates?: { oliphaunt_mobile_bindings?: { bindings?: { kotlin?: Record<string, unknown> } } };
  };
  const kotlin = values.crates?.oliphaunt_mobile_bindings?.bindings?.kotlin;
  assert.equal(kotlin?.package_name, 'dev.oliphaunt.bindings');
  assert.equal(kotlin?.cdylib_name, 'oliphaunt_mobile_bindings');
  assert.equal(kotlin?.disable_java_cleaner, true, 'Android API24 uses the configured JNA cleaner');
}

export function validateGeneratedKotlin(directory: string) {
  const children = readdirSync(directory, { recursive: true }).sort();
  assert.deepEqual(children, [
    'dev',
    'dev/oliphaunt',
    'dev/oliphaunt/bindings',
    'dev/oliphaunt/bindings/oliphaunt_mobile_bindings.kt',
  ]);
  const text = readFileSync(
    path.join(directory, 'dev/oliphaunt/bindings/oliphaunt_mobile_bindings.kt'),
    'utf8',
  );
  assert.match(text, /^package dev\.oliphaunt\.bindings$/mu);
  assert.ok(
    text.includes('oliphaunt_mobile_bindings'),
    'Generated bindings must load the conventional mobile cdylib',
  );
}

if (import.meta.main) {
  const [generator, library, configuration, directory] = process.argv.slice(2);
  assert.equal(process.argv.length, 6, 'Expected generator, metadata library, config and output');
  validateKotlinConfiguration(Bun.TOML.parse(readFileSync(configuration, 'utf8')));
  generateUniffi({ generator, library, configuration, directory, language: 'kotlin' });
  validateGeneratedKotlin(directory);
}
