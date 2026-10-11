import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { generateUniffi } from '../uniffi.mts';

export function validateSwiftConfiguration(configuration: unknown) {
  const values = configuration as {
    crates?: { oliphaunt_mobile_bindings?: { bindings?: { swift?: Record<string, unknown> } } };
  };
  const swift = values.crates?.oliphaunt_mobile_bindings?.bindings?.swift;
  assert.equal(swift?.module_name, 'OliphauntNativeBindings');
  assert.equal(swift?.ffi_module_name, 'OliphauntNativeBindingsFFI');
}

export function validateGeneratedSwift(directory: string) {
  assert.deepEqual(readdirSync(directory).sort(), [
    'OliphauntNativeBindings.swift',
    'OliphauntNativeBindingsFFI.h',
    'OliphauntNativeBindingsFFI.modulemap',
  ]);
}

if (import.meta.main) {
  const [generator, library, configuration, directory] = process.argv.slice(2);
  assert.equal(process.argv.length, 6, 'Expected generator, metadata library, config and output');
  validateSwiftConfiguration(Bun.TOML.parse(readFileSync(configuration, 'utf8')));
  generateUniffi({ generator, library, configuration, directory, language: 'swift' });
  validateGeneratedSwift(directory);
}
