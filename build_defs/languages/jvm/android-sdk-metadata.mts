import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function properties(file) {
  return Object.fromEntries(
    readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.includes('=') && !line.startsWith('#'))
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
      }),
  );
}

export function androidSdkMetadata(manifest, { os = process.platform, arch = process.arch } = {}) {
  if (os !== 'linux' || arch !== 'x64')
    throw new Error('native Android SDK construction requires Linux x86_64 execution');
  const packages = manifest.packages;
  const api = Number(packages?.compile_sdk);
  if (
    !Number.isSafeInteger(api) ||
    api <= 0 ||
    !/^\d+[.]\d+[.]\d+$/u.test(packages?.build_tools) ||
    !/^\d+[.]\d+[.]\d+$/u.test(packages?.platform_tools)
  )
    throw new Error('Android SDK acquisition requires exact conventional SDK package versions');
  const archives = [
    { ...manifest.platform, directory: `platforms/android-${api}`, role: 'platform' },
    {
      ...manifest.build_tools?.linux,
      directory: `build-tools/${packages.build_tools}`,
      role: 'build-tools',
    },
    { ...manifest.platform_tools?.linux, directory: 'platform-tools', role: 'platform-tools' },
  ];
  for (const archive of archives) {
    if (
      typeof archive.url !== 'string' ||
      !/^https:\/\/dl[.]google[.]com\/android\/repository\/[A-Za-z0-9_.-]+[.]zip$/u.test(
        archive.url,
      ) ||
      !/^[a-f0-9]{64}$/u.test(archive.sha256) ||
      !/^[A-Za-z0-9_.-]+$/u.test(archive.strip_prefix)
    )
      throw new Error(
        `Android SDK ${archive.role} requires an immutable Google archive and SHA-256`,
      );
  }
  if (
    manifest.platform.strip_prefix !== `android-${api}` ||
    !/^[1-9]\d*$/u.test(manifest.platform.revision)
  )
    throw new Error(
      'Android SDK platform archive must match the conventional compile SDK and revision',
    );
  return {
    api,
    buildTools: packages.build_tools,
    platformTools: packages.platform_tools,
    archives,
  };
}

export function verifyAndroidSdk(directory, metadata) {
  const platform = properties(
    path.join(directory, `platforms/android-${metadata.api}/source.properties`),
  );
  const buildTools = properties(
    path.join(directory, `build-tools/${metadata.buildTools}/source.properties`),
  );
  const platformTools = properties(path.join(directory, 'platform-tools/source.properties'));
  if (
    Number(platform['AndroidVersion.ApiLevel']) !== metadata.api ||
    platform['Pkg.Revision'] !== metadata.archives[0].revision ||
    buildTools['Pkg.Revision'] !== metadata.buildTools ||
    platformTools['Pkg.Revision'] !== metadata.platformTools
  )
    throw new Error('Android SDK archive package identities differ from the conventional pins');
}

if (import.meta.main) {
  const [manifestFile, outputFile, directory] = process.argv.slice(2);
  if (!manifestFile || !outputFile || process.argv.length > 5)
    throw new Error('usage: android-sdk-metadata.mts MANIFEST OUTPUT [SDK_DIRECTORY]');
  const metadata = androidSdkMetadata(Bun.TOML.parse(readFileSync(manifestFile, 'utf8')));
  if (directory) verifyAndroidSdk(directory, metadata);
  writeFileSync(outputFile, JSON.stringify(metadata));
}
