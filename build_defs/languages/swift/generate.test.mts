import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateGeneratedSwift, validateSwiftConfiguration } from './generate.mts';

test('conventional UniFFI module identity is required by the existing Swift consumers', () => {
  const swift = {
    module_name: 'OliphauntNativeBindings',
    ffi_module_name: 'OliphauntNativeBindingsFFI',
  };
  const config = (value: unknown) => ({
    crates: { oliphaunt_mobile_bindings: { bindings: { swift: value } } },
  });
  validateSwiftConfiguration(config(swift));
  for (const value of [
    null,
    {},
    { ...swift, module_name: 'Renamed' },
    { ...swift, ffi_module_name: undefined },
  ])
    expect(() => validateSwiftConfiguration(config(value))).toThrow();
});

test('generated shape rejects missing outputs and undeclared outputs', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'oliphaunt-uniffi-swift-'));
  try {
    for (const name of ['OliphauntNativeBindingsFFI.h', 'OliphauntNativeBindingsFFI.modulemap'])
      writeFileSync(path.join(directory, name), 'fixture\n');
    expect(() => validateGeneratedSwift(directory)).toThrow();
    writeFileSync(
      path.join(directory, 'OliphauntNativeBindings.swift'),
      'func backupToFd(fd: Int32) {}\n',
    );
    validateGeneratedSwift(directory);
    writeFileSync(path.join(directory, 'extra.swift'), 'extra\n');
    expect(() => validateGeneratedSwift(directory)).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
