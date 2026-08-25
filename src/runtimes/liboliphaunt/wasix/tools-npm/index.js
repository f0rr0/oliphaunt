import manifest from './package.json' with { type: 'json' };

// Source-workspace descriptor. Release packaging emits the same shape with
// package-local assets and removes the private marker.
export default Object.freeze({
  schema: 'oliphaunt-wasix-tools-v1',
  product: 'oliphaunt-wasix-tools',
  version: manifest.version,
  runtimeProduct: 'liboliphaunt-wasix',
  runtimeVersion: manifest.version,
  pgDump: Object.freeze({
    name: 'pg_dump',
    sha256: '90180532a2d4ccd68405f9ecc3057607e84fb5a033ae51541bc36535a8311909',
    size: 1324956,
    source: new URL('../../../../../target/oliphaunt-wasix/assets/bin/pg_dump.wasix.wasm', import.meta.url).href,
  }),
  psql: Object.freeze({
    name: 'psql',
    sha256: '894aeb0d846c249e4697a4795184b2e6a470ca53daa4819f61c204f05baf9c8d',
    size: 1419164,
    source: new URL('../../../../../target/oliphaunt-wasix/assets/bin/psql.wasix.wasm', import.meta.url).href,
  }),
});
