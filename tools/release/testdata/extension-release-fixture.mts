import { expect } from 'bun:test';

export function fixture() {
  const extensionRuntimes = {
    'oliphaunt-wasix-ts': 'liboliphaunt-wasix',
    'oliphaunt-wasix-rust': 'liboliphaunt-wasix',
    'oliphaunt-js': 'liboliphaunt-native',
    'oliphaunt-kotlin': 'liboliphaunt-native',
    'oliphaunt-swift': 'liboliphaunt-native',
  };
  const sdks = new Set([
    ...Object.keys(extensionRuntimes),
    'oliphaunt-rust',
    'oliphaunt-react-native',
  ]);
  const versions = {
    'oliphaunt-wasix-ts': '0.2.1',
    'oliphaunt-wasix-napi': '0.2.0',
    'postgres-tools-wasix': '0.2.3',
    'oliphaunt-wasix-rust': '0.3.1',
    'oliphaunt-rust': '0.3.1',
    'oliphaunt-js': '0.3.0',
    'oliphaunt-kotlin': '0.3.1',
    'oliphaunt-swift': '0.8.0',
    'oliphaunt-react-native': '0.3.0',
    'oliphaunt-extension-vector': '9.8.7',
    'liboliphaunt-wasix': '0.3.1',
    'liboliphaunt-native': '0.3.1',
  };
  const products = Object.fromEntries(
    Object.entries(versions).map(([id, version]) => [
      id,
      {
        version,
        tag_prefix: `${id}-v`,
        ...(sdks.has(id) ? { kind: 'sdk' } : {}),
        ...(extensionRuntimes[id]
          ? { exact_extension_runtime: extensionRuntimes[id] }
          : id === 'oliphaunt-rust'
            ? { exact_extension_runtime: false }
            : {}),
        ...(id === 'oliphaunt-extension-vector' ? { extension: { class: 'external' } } : {}),
      },
    ]),
  );
  const pins = {
    'oliphaunt-wasix-ts': { 'liboliphaunt-wasix': '0.3.1', 'oliphaunt-wasix-napi': '0.2.0' },
    'oliphaunt-wasix-napi': { 'liboliphaunt-wasix': '0.3.1' },
    'oliphaunt-wasix-rust': { 'liboliphaunt-wasix': '0.3.1' },
    'postgres-tools-wasix': {
      'oliphaunt-wasix-ts': '0.2.1',
      'liboliphaunt-wasix': '0.3.1',
    },
    'oliphaunt-js': { 'liboliphaunt-native': '0.3.1' },
    'oliphaunt-kotlin': { 'liboliphaunt-native': '0.3.1' },
    'oliphaunt-swift': { 'liboliphaunt-native': '0.3.1' },
    'oliphaunt-rust': { 'liboliphaunt-native': '0.3.1' },
    'oliphaunt-react-native': { 'oliphaunt-kotlin': '0.3.1', 'oliphaunt-swift': '0.8.0' },
    'oliphaunt-extension-vector': { 'liboliphaunt-wasix': '0.3.1', 'liboliphaunt-native': '0.3.1' },
  };
  const published = structuredClone(pins);
  const publishedVersions = {};
  for (const [id, fields] of Object.entries(pins)) {
    products[id].compatibility_versions = Object.fromEntries(
      Object.keys(fields).map((source) => [source, { source_product: source }]),
    );
  }
  const reads = [];
  const readCompatibility = (product, source, _prefix, { ref }) => {
    reads.push({ product, source, ref });
    if (ref !== null) expect(ref.startsWith(products[product].tag_prefix)).toBe(true);
    return ref === null
      ? pins[product][source]
      : (publishedVersions[ref] ?? published[product])[source];
  };
  return { products, pins, published, publishedVersions, reads, readCompatibility };
}
