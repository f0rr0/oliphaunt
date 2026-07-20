export const EXPO_SMOKE_PASS_TAG = 'OLIPHAUNT_EXPO_SMOKE_PASS' as const;
export const EXPO_SMOKE_PASS_EVENT_MAX_BYTES = 768;

export type ExpoSmokePassPlatform = 'android' | 'ios';

export type ExpoSmokePassReceiptInput = {
  readonly platform: ExpoSmokePassPlatform;
  readonly extensions: readonly string[];
  readonly extensionProofCount: number;
  readonly extensionCatalogSha256: string;
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
  if (!Number.isSafeInteger(input.extensionProofCount) || input.extensionProofCount <= 0) {
    throw new Error('installed-app receipt requires a positive extension proof count');
  }
  if (!/^[0-9a-f]{64}$/u.test(input.extensionCatalogSha256)) {
    throw new Error('installed-app receipt requires a lowercase SHA-256 extension catalog digest');
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
  const expectedProofCount = extensions.length + 1;
  if (input.extensionProofCount !== expectedProofCount) {
    throw new Error(
      `installed-app receipt extension proof mismatch: expected ${expectedProofCount}, got ${input.extensionProofCount}`,
    );
  }

  const serialized = JSON.stringify({
    schema: 'oliphaunt-expo-smoke-pass-v1',
    runner: 'smoke',
    platform: input.platform,
    extensionCount: extensions.length,
    extensionProofCount: input.extensionProofCount,
    extensionCatalogSha256: input.extensionCatalogSha256,
  });
  const eventBytes = utf8ByteLength(`${EXPO_SMOKE_PASS_TAG} ${serialized}`);
  if (eventBytes > EXPO_SMOKE_PASS_EVENT_MAX_BYTES) {
    throw new Error(
      `installed-app PASS receipt is ${eventBytes} bytes; unified-log-safe budget is ${EXPO_SMOKE_PASS_EVENT_MAX_BYTES}`,
    );
  }
  return serialized;
}
