export const ENGINE_SOURCE_CRATES = Object.freeze([
  'wasmer',
  'wasmer-wasix-types',
  'wasmer-journal',
  'wasmer-wasix',
]);

export const ENGINE_PAYLOAD_PACKAGE = 'oliphaunt-wasmer-v8-windows-x64-msvc';
export function isEnginePayloadPart(name: string): boolean {
  return new RegExp(`^${ENGINE_PAYLOAD_PACKAGE}-part-(?!000)[0-9]{3}$`, 'u').test(name);
}

export const ENGINE_CARGO_PACKAGES = Object.freeze([
  ...ENGINE_SOURCE_CRATES.map((name) => `oliphaunt-${name}`),
  ENGINE_PAYLOAD_PACKAGE,
]);
