export const ENGINE_SOURCE_CRATES = Object.freeze([
  'wasmer',
  'wasmer-wasix-types',
  'wasmer-journal',
  'wasmer-wasix',
]);

export const ENGINE_PAYLOAD_PACKAGE = 'oliphaunt-wasmer-v8-windows-x64-msvc';
export const ENGINE_CARGO_PACKAGES = Object.freeze([
  ...ENGINE_SOURCE_CRATES.map((name) => `oliphaunt-${name}`),
  ENGINE_PAYLOAD_PACKAGE,
]);
