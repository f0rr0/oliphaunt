export const EXPO_SMOKE_PASS_TAG = 'OLIPHAUNT_EXPO_SMOKE_PASS' as const;
export const EXPO_SMOKE_PASS_EVENT_MAX_BYTES = 768;

export type ExpoSmokePassPlatform = 'android' | 'ios';
export type ExpoSmokePassCatalogProfile = 'standard' | 'icu';

export type ExpoSmokePassReceiptInput = {
  readonly platform: ExpoSmokePassPlatform;
  readonly extensions: readonly string[];
  readonly activatedExtensions: readonly string[];
  readonly extensionCatalogComplete: boolean;
  readonly pgTextsearchEnglishBm25: boolean;
  readonly extensionCatalogSha256: string;
  readonly catalogProfile: ExpoSmokePassCatalogProfile;
  readonly icuRuntimeProof: boolean;
};

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export function serializeExpoSmokePassReceipt(input: ExpoSmokePassReceiptInput): string {
  if (input.platform !== 'android' && input.platform !== 'ios') {
    throw new Error(`unsupported installed-app receipt platform: ${String(input.platform)}`);
  }
  if (!/^[0-9a-f]{64}$/u.test(input.extensionCatalogSha256)) {
    throw new Error('installed-app receipt requires a lowercase SHA-256 extension catalog digest');
  }
  if (typeof input.icuRuntimeProof !== 'boolean') {
    throw new Error('installed-app receipt requires an ICU runtime proof boolean');
  }
  if (input.catalogProfile !== 'standard' && input.catalogProfile !== 'icu') {
    throw new Error(`installed-app receipt has unsupported catalog profile: ${String(input.catalogProfile)}`);
  }
  if (input.icuRuntimeProof !== (input.catalogProfile === 'icu')) {
    throw new Error('installed-app receipt ICU proof must match its catalog profile');
  }

  const extensions = [...input.extensions].sort();
  if (extensions.length === 0 || new Set(extensions).size !== extensions.length) {
    throw new Error('installed-app receipt requires a nonempty unique extension set');
  }
  for (const extension of extensions) {
    if (!/^[a-z][a-z0-9_-]*$/u.test(extension)) {
      throw new Error(`installed-app receipt contains a noncanonical extension name: ${extension}`);
    }
  }
  if (!Array.isArray(input.activatedExtensions)) {
    throw new Error('installed-app receipt requires an activated extension set');
  }
  const activatedExtensions = [...input.activatedExtensions].sort();
  if (
    new Set(activatedExtensions).size !== activatedExtensions.length ||
    JSON.stringify(activatedExtensions) !== JSON.stringify(extensions)
  ) {
    throw new Error(
      `installed-app receipt activated extension mismatch: expected ${extensions.join(',')}, got ${activatedExtensions.join(',')}`,
    );
  }
  if (input.extensionCatalogComplete !== true) {
    throw new Error('installed-app receipt requires extension catalog completeness');
  }
  const expectedPgTextsearchProof = extensions.includes('pg_textsearch');
  if (input.pgTextsearchEnglishBm25 !== expectedPgTextsearchProof) {
    throw new Error(
      `installed-app receipt pg_textsearch English BM25 proof mismatch: expected ${expectedPgTextsearchProof}, got ${String(input.pgTextsearchEnglishBm25)}`,
    );
  }

  const serialized = JSON.stringify({
    schema: 'oliphaunt-expo-smoke-pass-v4',
    runner: 'smoke',
    platform: input.platform,
    extensionCount: extensions.length,
    allExtensionsActivated: true,
    extensionCatalogComplete: true,
    pgTextsearchEnglishBm25: input.pgTextsearchEnglishBm25,
    extensionCatalogSha256: input.extensionCatalogSha256,
    catalogProfile: input.catalogProfile,
    icuRuntimeProof: input.icuRuntimeProof,
  });
  const eventBytes = utf8ByteLength(`${EXPO_SMOKE_PASS_TAG} ${serialized}`);
  if (eventBytes > EXPO_SMOKE_PASS_EVENT_MAX_BYTES) {
    throw new Error(
      `installed-app PASS receipt is ${eventBytes} bytes; unified-log-safe budget is ${EXPO_SMOKE_PASS_EVENT_MAX_BYTES}`,
    );
  }
  return serialized;
}
