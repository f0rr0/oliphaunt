import path from 'node:path';

const SDK_RUNTIME_PAYLOAD_PATTERNS = [
  /(^|\/)assets\/oliphaunt\/runtime\//u,
  /(^|\/)assets\/oliphaunt\/cluster-seed\//u,
  /(^|\/)assets\/oliphaunt\/static-registry\/archives\//u,
  /(^|\/)oliphaunt\/runtime\/files\//u,
  /(^|\/)runtime\/files\/share\/postgresql\//u,
  /(^|\/)share\/postgresql\/extension\/[^/]+\.(control|sql)$/u,
  /(^|\/)release-assets\//u,
  /(^|\/)extension-artifacts\.json$/u,
  /(^|\/)liboliphaunt\.(so|dylib|dll|a|lib)$/u,
  /(^|\/)liboliphaunt_extensions\.(so|dylib|dll|a|lib)$/u,
  /(^|\/)liboliphaunt_extension_[^/]+\.(so|dylib|dll|a|lib)$/u,
  /\.xcframework(\/|$)/u,
];

const KOTLIN_ALLOWED_NATIVE_PAYLOADS = new Set(['liboliphaunt_mobile_bindings.so']);

export function findSdkRuntimePayloadViolation(
  product: string,
  names: Iterable<string>,
  allowedNames = new Set<string>(),
) {
  for (const name of names) {
    if (allowedNames.has(name)) continue;
    if (product === 'oliphaunt-kotlin' && KOTLIN_ALLOWED_NATIVE_PAYLOADS.has(path.basename(name)))
      continue;
    for (const pattern of SDK_RUNTIME_PAYLOAD_PATTERNS) {
      if (pattern.test(name)) return name;
    }
  }
  return null;
}
