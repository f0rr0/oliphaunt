const version = (...parts) => Object.freeze(parts);

export const APPLE_PLATFORM_COMPATIBILITY = Object.freeze({
  macos: Object.freeze({ id: 1, name: "macOS", cliName: "macos" }),
  ios: Object.freeze({ id: 2, name: "iOS", cliName: "ios" }),
  iosSimulator: Object.freeze({
    id: 7,
    name: "iOS Simulator",
    cliName: "ios-simulator",
  }),
});

const MACHO_ARM64 = Object.freeze({ cpuType: 0x0100000c, cpuSubtype: 0 });
const ELF64_LITTLE_ENDIAN = Object.freeze({ bits: 64, endianness: "little" });
const GNU_REQUIRED_VERSION_MAXIMUMS = Object.freeze({
  GLIBC: version(2, 38, 0),
  GLIBCXX: version(3, 4, 30),
});
const FORBIDDEN_ANDROID_VERSION_FAMILIES = Object.freeze(["GLIBC", "GLIBCXX"]);

function applePlatform(key, maximumMinimumOs) {
  const platform = APPLE_PLATFORM_COMPATIBILITY[key];
  return Object.freeze({ ...platform, maximumMinimumOs });
}

function machoArm64Contract({ carrier, platforms, requiredPlatforms, allowPlatformOverride }) {
  const allowed = Object.freeze(
    Object.fromEntries(
      platforms.map(([key, maximumMinimumOs]) => [key, applePlatform(key, maximumMinimumOs)]),
    ),
  );
  return Object.freeze({
    format: "macho",
    architecture: "arm64",
    macho: MACHO_ARM64,
    apple: Object.freeze({
      carrier,
      platforms: allowed,
      requiredPlatforms: Object.freeze([...requiredPlatforms]),
      allowPlatformOverride,
    }),
  });
}

function desktopElfContract(architecture, machine) {
  return Object.freeze({
    format: "elf",
    architecture,
    elf: Object.freeze({
      ...ELF64_LITTLE_ENDIAN,
      machine,
      maximumRequiredVersions: GNU_REQUIRED_VERSION_MAXIMUMS,
    }),
  });
}

function androidElfContract(architecture, machine) {
  return Object.freeze({
    format: "elf",
    architecture,
    elf: Object.freeze({
      ...ELF64_LITTLE_ENDIAN,
      machine,
      androidApiLevel: 24,
      forbiddenRequiredVersionFamilies: FORBIDDEN_ANDROID_VERSION_FAMILIES,
    }),
  });
}

export const PLATFORM_COMPATIBILITY_POLICY = Object.freeze({
  "macos-arm64": machoArm64Contract({
    carrier: "direct macOS carrier",
    platforms: [["macos", version(11, 0, 0)]],
    requiredPlatforms: ["macos"],
    allowPlatformOverride: false,
  }),
  "linux-x64-gnu": desktopElfContract("x64", 62),
  "linux-arm64-gnu": desktopElfContract("arm64", 183),
  "android-arm64-v8a": androidElfContract("arm64", 183),
  "android-x86_64": androidElfContract("x64", 62),
  "ios-xcframework": machoArm64Contract({
    carrier: "iOS XCFramework tree",
    platforms: [
      ["macos", version(14, 0, 0)],
      ["ios", version(17, 0, 0)],
      ["iosSimulator", version(17, 0, 0)],
    ],
    requiredPlatforms: ["macos", "ios", "iosSimulator"],
    allowPlatformOverride: true,
  }),
  "windows-x64-msvc": Object.freeze({
    format: "pe",
    architecture: "x64",
    pe: Object.freeze({ machine: 0x8664, optionalHeaderMagic: 0x20b }),
    windowsVcRuntime: Object.freeze({
      profiles: Object.freeze(["direct", "provider"]),
    }),
  }),
});

export function platformCompatibilityContract(target) {
  return PLATFORM_COMPATIBILITY_POLICY[target];
}

export function platformCompatibilityTargets() {
  return Object.freeze(Object.keys(PLATFORM_COMPATIBILITY_POLICY).sort());
}

function displayVersion(parts) {
  const values = [...parts];
  while (values.length > 2 && values.at(-1) === 0) values.pop();
  return values.join(".");
}

function sameVersion(left, right) {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

export const PUBLIC_PLATFORM_COMPATIBILITY_BLOCK = Object.freeze({
  start: "<!-- BEGIN GENERATED PLATFORM COMPATIBILITY -->",
  end: "<!-- END GENERATED PLATFORM COMPATIBILITY -->",
});

/**
 * Render the consumer-facing compatibility table from the same contract used
 * to inspect release binaries. The public release reference keeps this block
 * byte-for-byte synchronized in platform-compatibility-policy.test.mjs.
 */
export function renderPublicPlatformCompatibilityTable() {
  const linuxX64 = PLATFORM_COMPATIBILITY_POLICY["linux-x64-gnu"].elf.maximumRequiredVersions;
  const linuxArm64 = PLATFORM_COMPATIBILITY_POLICY["linux-arm64-gnu"].elf.maximumRequiredVersions;
  for (const family of ["GLIBC", "GLIBCXX"]) {
    if (!sameVersion(linuxX64[family], linuxArm64[family])) {
      throw new Error(`published Linux targets disagree on the ${family} compatibility ceiling`);
    }
  }
  const androidArm64 = PLATFORM_COMPATIBILITY_POLICY["android-arm64-v8a"].elf.androidApiLevel;
  const androidX64 = PLATFORM_COMPATIBILITY_POLICY["android-x86_64"].elf.androidApiLevel;
  if (androidArm64 !== androidX64) {
    throw new Error("published Android targets disagree on the minimum API level");
  }
  const directMacos = PLATFORM_COMPATIBILITY_POLICY["macos-arm64"].apple.platforms.macos;
  const xcframework = PLATFORM_COMPATIBILITY_POLICY["ios-xcframework"].apple.platforms;
  return [
    "| Published carrier | Enforced consumer compatibility contract |",
    "| --- | --- |",
    `| Linux x64/arm64 GNU | Required symbol versions do not exceed \`GLIBC_${displayVersion(linuxX64.GLIBC)}\` or \`GLIBCXX_${displayVersion(linuxX64.GLIBCXX)}\`. |`,
    `| Direct macOS arm64 runtime | Minimum deployment target is macOS ${displayVersion(directMacos.maximumMinimumOs)}. |`,
    `| Android \`arm64-v8a\` and \`x86_64\` | Minimum Android API level is ${androidArm64}; Android binaries must not require GLIBC/GLIBCXX symbol families. |`,
    `| Apple XCFramework | Contains macOS arm64, iOS device arm64, and iOS Simulator arm64 slices; minimum targets are macOS ${displayVersion(xcframework.macos.maximumMinimumOs)}, iOS ${displayVersion(xcframework.ios.maximumMinimumOs)}, and iOS Simulator ${displayVersion(xcframework.iosSimulator.maximumMinimumOs)}. |`,
    "| Windows x64 MSVC | Requires the x64 PE/COFF contract and the declared app-local Visual C++ runtime profile; Windows ARM64 is not published. |",
  ].join("\n");
}
