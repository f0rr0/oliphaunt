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

export function androidEmulatorMetadata(
  manifest,
  { os = process.platform, arch = process.arch } = {},
) {
  if (os !== 'linux' || arch !== 'x64')
    throw new Error('installed Android qualification requires Linux x86_64 execution');
  const version = manifest.packages?.emulator;
  const image = manifest.system_image?.linux_x86_64;
  if (
    !/^\d+[.]\d+[.]\d+$/u.test(version) ||
    !image ||
    image.api !== '35' ||
    image.tag !== 'google_atd' ||
    image.abi !== 'x86_64' ||
    !/^[1-9]\d*$/u.test(image.revision)
  )
    throw new Error(
      'installed Android qualification requires exact emulator and API35 google_atd/x86_64 pins',
    );
  const imagePath = `system-images/android-${image.api}/${image.tag}/${image.abi}`;
  const archives = [
    { ...manifest.emulator?.linux, directory: 'emulator', role: 'emulator' },
    { ...image, directory: imagePath, role: 'system-image' },
    {
      ...manifest.command_line_tools?.linux,
      directory: 'cmdline-tools/latest',
      role: 'command-line-tools',
      strip_prefix: 'cmdline-tools',
    },
  ];
  for (const archive of archives) {
    const allowed =
      archive.role === 'emulator'
        ? /^https:\/\/dl[.]google[.]com\/android\/repository\/emulator-linux_x64-\d+[.]zip$/u
        : archive.role === 'system-image'
          ? /^https:\/\/dl[.]google[.]com\/android\/repository\/sys-img\/google_atd\/x86_64-35_r\d+[.]zip$/u
          : /^https:\/\/dl[.]google[.]com\/android\/repository\/commandlinetools-linux-\d+_latest[.]zip$/u;
    if (
      !allowed.test(archive.url) ||
      !/^[a-f0-9]{64}$/u.test(archive.sha256) ||
      !/^[A-Za-z0-9_.-]+$/u.test(archive.strip_prefix) ||
      !Number.isSafeInteger(Number(archive.bytes)) ||
      Number(archive.bytes) <= 0
    )
      throw new Error(
        `installed Android ${archive.role} requires an immutable official archive, size and SHA-256`,
      );
  }
  if (archives[0].strip_prefix !== 'emulator' || archives[1].strip_prefix !== image.abi)
    throw new Error('installed Android archive prefixes differ from their package identities');
  if (
    archives[2].url !==
      `https://dl.google.com/android/repository/commandlinetools-linux-${manifest.packages.command_line_tools_build}_latest.zip` ||
    !/^\d+[.]\d+$/u.test(manifest.packages.command_line_tools_revision)
  )
    throw new Error(
      'Installed Android AVD tools differ from the conventional command-line tools pin',
    );
  return {
    version,
    api: Number(image.api),
    tag: image.tag,
    abi: image.abi,
    commandLineToolsRevision: manifest.packages.command_line_tools_revision,
    imageRevision: image.revision,
    imagePath,
    archives,
  };
}

export function verifyAndroidEmulator(directory, metadata) {
  const emulator = properties(path.join(directory, 'emulator/source.properties'));
  const image = properties(path.join(directory, metadata.imagePath, 'source.properties'));
  const tools = properties(path.join(directory, 'cmdline-tools/latest/source.properties'));
  if (
    emulator['Pkg.Revision'] !== metadata.version ||
    image['Pkg.Revision'] !== metadata.imageRevision ||
    Number(image['AndroidVersion.ApiLevel']) !== metadata.api ||
    image['SystemImage.TagId'] !== metadata.tag ||
    image['SystemImage.Abi'] !== metadata.abi ||
    tools['Pkg.Revision'] !== metadata.commandLineToolsRevision
  )
    throw new Error('Android emulator/image package identities differ from the conventional pins');
  const minimum = /^emulator#(\d+[.]\d+[.]\d+)$/u.exec(image['Pkg.Dependencies']);
  if (!minimum || !Bun.semver.satisfies(metadata.version, '>=' + minimum[1]))
    throw new Error('Pinned emulator does not satisfy the original system-image requirement');
}

export function androidLocalPackageDocuments(directory, metadata) {
  verifyAndroidEmulator(directory, metadata);
  const image = properties(path.join(directory, metadata.imagePath, 'source.properties'));
  const xml = (text) =>
    String(text)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  if (
    !/^\d+$/u.test(image['AndroidVersion.ExtensionLevel']) ||
    !['true', 'false'].includes(image['AndroidVersion.IsBaseSdk']) ||
    image['Addon.VendorId'] !== 'google'
  )
    throw new Error('Original Android system image lacks its standard SDK type metadata');
  const document = (id, type, revision, description) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<common:repository xmlns:common="http://schemas.android.com/repository/android/common/02" xmlns:generic="http://schemas.android.com/repository/android/generic/02" xmlns:sys-img="http://schemas.android.com/sdk/android/repo/sys-img2/04" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n<localPackage path="${xml(id)}">${type}<revision>${revision}</revision><display-name>${xml(description)}</display-name></localPackage>\n</common:repository>\n`;
  const [major, minor, micro] = metadata.version.split('.');
  return {
    'emulator/package.xml': document(
      'emulator',
      '<type-details xsi:type="generic:genericDetailsType"/>',
      `<major>${major}</major><minor>${minor}</minor><micro>${micro}</micro>`,
      'Android Emulator',
    ),
    [metadata.imagePath + '/package.xml']: document(
      metadata.imagePath.replaceAll('/', ';'),
      `<type-details xsi:type="sys-img:sysImgDetailsType"><api-level>${metadata.api}</api-level><extension-level>${image['AndroidVersion.ExtensionLevel']}</extension-level><base-extension>${image['AndroidVersion.IsBaseSdk']}</base-extension><tag><id>${xml(metadata.tag)}</id><display>${xml(image['SystemImage.TagDisplay'])}</display></tag><vendor><id>${xml(image['Addon.VendorId'])}</id><display>${xml(image['Addon.VendorDisplay'])}</display></vendor><abi>${xml(metadata.abi)}</abi><abis>${xml(metadata.abi)}</abis></type-details>`,
      `<major>${metadata.imageRevision}</major>`,
      image['Pkg.Desc'],
    ),
  };
}

if (import.meta.main) {
  const [manifestFile, outputFile, ...rest] = process.argv.slice(2);
  const installed = rest[0] === '--emulator';
  const directory = rest[installed ? 1 : 0];
  if (!manifestFile || !outputFile || rest.length > (installed ? 2 : 1))
    throw new Error('usage: android-sdk-metadata.mts MANIFEST OUTPUT [--emulator] [SDK_DIRECTORY]');
  const manifest = Bun.TOML.parse(readFileSync(manifestFile, 'utf8'));
  const metadata = installed ? androidEmulatorMetadata(manifest) : androidSdkMetadata(manifest);
  if (directory) (installed ? verifyAndroidEmulator : verifyAndroidSdk)(directory, metadata);
  if (installed && directory)
    for (const [relative, text] of Object.entries(
      androidLocalPackageDocuments(directory, metadata),
    ))
      writeFileSync(path.join(directory, relative), text);
  writeFileSync(outputFile, JSON.stringify(metadata));
}
