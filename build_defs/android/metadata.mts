import { PLATFORM_COMPATIBILITY_POLICY } from '../../tools/release/platform-compatibility-policy.mts';

export function androidNdkMetadata(value: unknown) {
  const manifest = value as {
    packages?: { ndk?: unknown };
    ndk?: { linux?: { url?: unknown; sha256?: unknown; strip_prefix?: unknown } };
  };
  const revision = manifest.packages?.ndk;
  const archive = manifest.ndk?.linux;
  if (typeof revision !== 'string' || !/^\d+\.\d+\.\d+$/u.test(revision)) {
    throw new Error('Android native NDK must have an exact packages.ndk revision');
  }
  if (
    typeof archive?.url !== 'string' ||
    !/^https:\/\/dl\.google\.com\/android\/repository\/android-ndk-r\d+[a-z]?-linux\.zip$/u.test(
      archive.url,
    ) ||
    typeof archive.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(archive.sha256) ||
    typeof archive.strip_prefix !== 'string' ||
    archive.strip_prefix !== archive.url.split('/').at(-1)?.replace('-linux.zip', '')
  ) {
    throw new Error('Android native NDK needs one checksummed canonical Google Linux archive');
  }
  const api = PLATFORM_COMPATIBILITY_POLICY['android-arm64-v8a'].elf.androidApiLevel;
  if (api !== PLATFORM_COMPATIBILITY_POLICY['android-x86_64'].elf.androidApiLevel) {
    throw new Error('Android native targets must use the same canonical minimum API');
  }
  const pageAlignment =
    PLATFORM_COMPATIBILITY_POLICY['android-arm64-v8a'].elf.minimumLoadSegmentAlignment;
  if (
    pageAlignment !==
    PLATFORM_COMPATIBILITY_POLICY['android-x86_64'].elf.minimumLoadSegmentAlignment
  ) {
    throw new Error('Android native targets must use the same canonical ELF page alignment');
  }
  return {
    revision,
    api,
    page_alignment: pageAlignment,
    url: archive.url,
    sha256: archive.sha256,
    strip_prefix: archive.strip_prefix,
  };
}

if (import.meta.main) {
  const source = process.argv[2];
  if (!source) throw new Error('usage: metadata.mts android-sdk.toml');
  console.log(JSON.stringify(androidNdkMetadata(Bun.TOML.parse(await Bun.file(source).text()))));
}
