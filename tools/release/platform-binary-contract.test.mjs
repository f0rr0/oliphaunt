import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  inspectPlatformBinaryBuffer,
  inspectPlatformBinaryEntries,
  inspectPlatformBinaryTree,
} from "./platform-binary-contract.mjs";
import { windowsImportLibraryFixture } from "../test/release-fixture-utils.mjs";

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function packedVersion(major, minor = 0, patch = 0) {
  return (major << 16) | (minor << 8) | patch;
}

function macho({
  platform = 1,
  minos = [11, 0, 0],
  cpu = 0x0100000c,
  cpuSubtype = 0,
  commandSize = 24,
  commands = 1,
} = {}) {
  const buffer = Buffer.alloc(32 + commandSize);
  buffer.writeUInt32LE(0xfeedfacf, 0);
  buffer.writeUInt32LE(cpu, 4);
  buffer.writeUInt32LE(cpuSubtype, 8);
  buffer.writeUInt32LE(6, 12);
  buffer.writeUInt32LE(commands, 16);
  buffer.writeUInt32LE(commandSize, 20);
  buffer.writeUInt32LE(0, 24);
  buffer.writeUInt32LE(0, 28);
  if (commands > 0 && commandSize >= 8) {
    buffer.writeUInt32LE(0x32, 32);
    buffer.writeUInt32LE(commandSize, 36);
    if (commandSize >= 24) {
      buffer.writeUInt32LE(platform, 40);
      buffer.writeUInt32LE(packedVersion(...minos), 44);
      buffer.writeUInt32LE(packedVersion(...minos), 48);
      buffer.writeUInt32LE(0, 52);
    }
  }
  return buffer;
}

function fatMacho(slices) {
  const tableSize = 8 + slices.length * 20;
  let cursor = tableSize;
  const offsets = [];
  for (const slice of slices) {
    while (cursor % 4 !== 0) cursor += 1;
    offsets.push(cursor);
    cursor += slice.length;
  }
  const buffer = Buffer.alloc(cursor);
  buffer.writeUInt32BE(0xcafebabe, 0);
  buffer.writeUInt32BE(slices.length, 4);
  for (let index = 0; index < slices.length; index += 1) {
    const entry = 8 + index * 20;
    buffer.writeUInt32BE(0x0100000c, entry);
    buffer.writeUInt32BE(slices[index].readUInt32LE(8), entry + 4);
    buffer.writeUInt32BE(offsets[index], entry + 8);
    buffer.writeUInt32BE(slices[index].length, entry + 12);
    buffer.writeUInt32BE(2, entry + 16);
    slices[index].copy(buffer, offsets[index]);
  }
  return buffer;
}

function ar(members) {
  const chunks = [Buffer.from("!<arch>\n", "ascii")];
  for (const [name, data] of members) {
    const encodedName = `${name}/`.padEnd(16, " ");
    const header = Buffer.from(
      `${encodedName}${"0".padEnd(12, " ")}${"0".padEnd(6, " ")}${"0".padEnd(6, " ")}${"100644".padEnd(8, " ")}${String(data.length).padEnd(10, " ")}\`\n`,
      "ascii",
    );
    chunks.push(header, data);
    if (data.length % 2 !== 0) chunks.push(Buffer.from("\n", "ascii"));
  }
  return Buffer.concat(chunks);
}

function elf({
  machine = 62,
  bits = 64,
  littleEndian = true,
  versions = [],
  truncateSectionTable = false,
  androidApi = null,
  type = 3,
} = {}) {
  const versionBytes = Buffer.from(`\0${versions.join("\0")}\0`, "ascii");
  const note = androidApi === null ? null : Buffer.alloc(24);
  if (note !== null) {
    note.writeUInt32LE(8, 0);
    note.writeUInt32LE(4, 4);
    note.writeUInt32LE(1, 8);
    note.write("Android\0", 12, "ascii");
    note.writeUInt32LE(androidApi, 20);
  }
  const noteOffset = align(64 + versionBytes.length, 4);
  const sectionOffset = note === null ? 0 : align(noteOffset + note.length, 8);
  const buffer = Buffer.alloc(note === null ? 64 + versionBytes.length : sectionOffset + 128);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(buffer, 0);
  buffer[4] = bits === 64 ? 2 : 1;
  buffer[5] = littleEndian ? 1 : 2;
  buffer[6] = 1;
  buffer.writeUInt16LE(type, 16);
  buffer.writeUInt16LE(machine, 18);
  buffer.writeUInt32LE(1, 20);
  buffer.writeUInt16LE(64, 52);
  if (truncateSectionTable) {
    buffer.writeBigUInt64LE(64n, 40);
    buffer.writeUInt16LE(64, 58);
    buffer.writeUInt16LE(2, 60);
  }
  versionBytes.copy(buffer, 64);
  if (note !== null) {
    note.copy(buffer, noteOffset);
    buffer.writeBigUInt64LE(BigInt(sectionOffset), 40);
    buffer.writeUInt16LE(64, 58);
    buffer.writeUInt16LE(2, 60);
    const noteSection = sectionOffset + 64;
    buffer.writeUInt32LE(7, noteSection + 4);
    buffer.writeBigUInt64LE(BigInt(noteOffset), noteSection + 24);
    buffer.writeBigUInt64LE(BigInt(note.length), noteSection + 32);
    buffer.writeBigUInt64LE(4n, noteSection + 48);
  }
  return buffer;
}

function align(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

function pe({
  machine = 0x8664,
  optionalMagic = 0x20b,
  imports = ["KERNEL32.dll"],
  delayImports = [],
} = {}) {
  const peOffset = 0x80;
  const optionalSize = 240;
  const sectionTable = peOffset + 24 + optionalSize;
  const rawOffset = 0x200;
  const rawSize = 0x400;
  const virtualAddress = 0x1000;
  const buffer = Buffer.alloc(rawOffset + rawSize);
  buffer.write("MZ", 0, "ascii");
  buffer.writeUInt32LE(peOffset, 0x3c);
  buffer.write("PE\0\0", peOffset, "ascii");
  const coff = peOffset + 4;
  buffer.writeUInt16LE(machine, coff);
  buffer.writeUInt16LE(1, coff + 2);
  buffer.writeUInt16LE(optionalSize, coff + 16);
  buffer.writeUInt16LE(0x2022, coff + 18);
  const optional = coff + 20;
  buffer.writeUInt16LE(optionalMagic, optional);
  buffer.writeBigUInt64LE(0x140000000n, optional + 24);
  buffer.writeUInt32LE(rawOffset, optional + 60);
  buffer.writeUInt32LE(16, optional + 108);
  const descriptorBytes = (imports.length + 1) * 20;
  buffer.writeUInt32LE(virtualAddress, optional + 120);
  buffer.writeUInt32LE(descriptorBytes, optional + 124);
  if (delayImports.length > 0) {
    const delayDescriptorOffset = rawOffset + 0x100;
    buffer.writeUInt32LE(virtualAddress + (delayDescriptorOffset - rawOffset), optional + 216);
    buffer.writeUInt32LE((delayImports.length + 1) * 32, optional + 220);
  }
  buffer.write(".rdata\0\0", sectionTable, "ascii");
  buffer.writeUInt32LE(rawSize, sectionTable + 8);
  buffer.writeUInt32LE(virtualAddress, sectionTable + 12);
  buffer.writeUInt32LE(rawSize, sectionTable + 16);
  buffer.writeUInt32LE(rawOffset, sectionTable + 20);
  let nameOffset = rawOffset + 0x200;
  for (let index = 0; index < imports.length; index += 1) {
    const descriptor = rawOffset + index * 20;
    buffer.writeUInt32LE(virtualAddress + (nameOffset - rawOffset), descriptor + 12);
    buffer.write(`${imports[index]}\0`, nameOffset, "ascii");
    nameOffset += Buffer.byteLength(imports[index]) + 1;
  }
  for (let index = 0; index < delayImports.length; index += 1) {
    const descriptor = rawOffset + 0x100 + index * 32;
    buffer.writeUInt32LE(1, descriptor);
    buffer.writeUInt32LE(virtualAddress + (nameOffset - rawOffset), descriptor + 4);
    buffer.write(`${delayImports[index]}\0`, nameOffset, "ascii");
    nameOffset += Buffer.byteLength(delayImports[index]) + 1;
  }
  return buffer;
}

function entry(name, data) {
  return { name, data, isFile: true };
}

describe("Mach-O platform compatibility", () => {
  test("accepts a thin arm64 direct macOS binary at the 11.0 floor", () => {
    const result = inspectPlatformBinaryBuffer(macho(), { target: "macos-arm64", label: "lib.dylib" });
    expect(result.slices[0].platformName).toBe("macOS");
    expect(result.slices[0].minos).toEqual([11, 0, 0]);
  });

  test("rejects the observed accidental macOS 26.0 floor", () => {
    expect(() =>
      inspectPlatformBinaryBuffer(macho({ minos: [26, 0, 0] }), {
        target: "macos-arm64",
        label: "lib.dylib",
      }),
    ).toThrow(/minimum OS 26\.0 exceeds.*11\.0/u);
  });

  test("rejects x64, missing build metadata, and truncated load commands", () => {
    expect(() =>
      inspectPlatformBinaryBuffer(macho({ cpu: 0x01000007 }), { target: "macos-arm64", label: "wrong.dylib" }),
    ).toThrow(/not arm64/u);
    expect(() =>
      inspectPlatformBinaryBuffer(macho({ cpuSubtype: 2 }), {
        target: "macos-arm64",
        label: "arm64e.dylib",
      }),
    ).toThrow(/not generic ARM64_ALL.*arm64e-only/u);
    expect(() =>
      inspectPlatformBinaryBuffer(macho({ commands: 0, commandSize: 0 }), {
        target: "macos-arm64",
        label: "missing.dylib",
      }),
    ).toThrow(/exactly one LC_BUILD_VERSION/u);
    expect(() =>
      inspectPlatformBinaryBuffer(macho({ commandSize: 12 }), { target: "macos-arm64", label: "short.dylib" }),
    ).toThrow(/LC_BUILD_VERSION is truncated/u);
  });

  test("bounds-checks fat slices and validates every embedded slice", () => {
    const valid = fatMacho([macho()]);
    expect(inspectPlatformBinaryBuffer(valid, { target: "macos-arm64", label: "fat" }).slices).toHaveLength(1);
    const outside = Buffer.from(valid);
    outside.writeUInt32BE(outside.length - 4, 16);
    expect(() => inspectPlatformBinaryBuffer(outside, { target: "macos-arm64", label: "fat" })).toThrow(
      /outside the .*file/u,
    );
    const highFloor = fatMacho([macho({ minos: [14, 0, 0] })]);
    expect(() => inspectPlatformBinaryBuffer(highFloor, { target: "macos-arm64", label: "fat" })).toThrow(
      /exceeds.*11\.0/u,
    );
    expect(() =>
      inspectPlatformBinaryBuffer(fatMacho([macho(), macho()]), {
        target: "macos-arm64",
        label: "duplicate-fat",
      }),
    ).toThrow(/duplicates architecture identity arm64\/ARM64_ALL/u);
  });

  test("requires iOS device and simulator and permits macOS only through 14.0", () => {
    const entries = [
      entry("device/lib", macho({ platform: 2, minos: [17, 0, 0] })),
      entry("simulator/lib", macho({ platform: 7, minos: [17, 0, 0] })),
      entry("macos/lib", macho({ platform: 1, minos: [14, 0, 0] })),
    ];
    expect(inspectPlatformBinaryEntries(entries, { target: "ios-xcframework" }).platforms).toEqual([1, 2, 7]);
    expect(() => inspectPlatformBinaryEntries(entries.slice(0, 1), { target: "ios-xcframework" })).toThrow(
      /missing macOS and iOS Simulator/u,
    );
    expect(() =>
      inspectPlatformBinaryEntries(
        [...entries.slice(0, 2), entry("macos/lib", macho({ platform: 1, minos: [14, 1, 0] }))],
        { target: "ios-xcframework" },
      ),
    ).toThrow(/macOS minimum OS 14\.1 exceeds.*14\.0/u);
  });

  test("inspects Mach-O object members in static XCFramework archives", () => {
    const entries = [
      entry("macos/libextension.a", ar([["macos.o", macho({ platform: 1, minos: [11, 0, 0] })]])),
      entry("device/libextension.a", ar([["device.o", macho({ platform: 2, minos: [17, 0, 0] })]])),
      entry("simulator/libextension.a", ar([["sim.o", macho({ platform: 7, minos: [17, 0, 0] })]])),
    ];
    expect(
      inspectPlatformBinaryEntries(entries, {
        target: "ios-xcframework",
        requiredApplePlatforms: [1, 2, 7],
      }).slices,
    ).toBe(3);
    const malformed = Buffer.from(entries[1].data);
    malformed[8 + 58] = 0;
    expect(() =>
      inspectPlatformBinaryEntries([entries[0], entry("device/libextension.a", malformed), entries[2]], {
        target: "ios-xcframework",
        requiredApplePlatforms: [1, 2, 7],
      }),
    ).toThrow(/invalid header trailer/u);
    expect(() =>
      inspectPlatformBinaryEntries(
        [entries[0], entry("device/libextension.a", ar([["readme", Buffer.from("not an object")]])), entries[2]],
        { target: "ios-xcframework", requiredApplePlatforms: [1, 2, 7] },
      ),
    ).toThrow(/not a MACHO object/u);
    expect(() =>
      inspectPlatformBinaryEntries(entries.slice(1), {
        target: "ios-xcframework",
        requiredApplePlatforms: [1, 2, 7],
      }),
    ).toThrow(/missing macOS/u);
  });
});

describe("ELF platform and GNU symbol-version compatibility", () => {
  test("accepts the Linux x64 and arm64 ceilings", () => {
    const x64 = inspectPlatformBinaryBuffer(elf({ versions: ["GLIBC_2.38", "GLIBCXX_3.4.30"] }), {
      target: "linux-x64-gnu",
      label: "postgres",
    });
    expect(x64.slices[0].requiredVersions).toEqual(["GLIBCXX_3.4.30", "GLIBC_2.38"]);
    expect(() =>
      inspectPlatformBinaryBuffer(elf({ machine: 183, versions: ["GLIBC_2.17"] }), {
        target: "linux-arm64-gnu",
        label: "postgres",
      }),
    ).not.toThrow();
  });

  test("rejects GLIBC and GLIBCXX requirements above the contract", () => {
    expect(() =>
      inspectPlatformBinaryBuffer(elf({ versions: ["GLIBC_2.39"] }), {
        target: "linux-x64-gnu",
        label: "new-glibc.so",
      }),
    ).toThrow(/GLIBC_2\.39 exceeds.*2\.38/u);
    expect(() =>
      inspectPlatformBinaryBuffer(elf({ versions: ["GLIBCXX_3.4.31"] }), {
        target: "linux-x64-gnu",
        label: "new-libstdcxx.so",
      }),
    ).toThrow(/GLIBCXX_3\.4\.31 exceeds.*3\.4\.30/u);
  });

  test("rejects wrong architecture, class, byte order, and truncated tables", () => {
    expect(() =>
      inspectPlatformBinaryBuffer(elf({ machine: 183 }), { target: "linux-x64-gnu", label: "wrong.so" }),
    ).toThrow(/does not match x64/u);
    expect(() =>
      inspectPlatformBinaryBuffer(elf({ bits: 32 }), { target: "linux-x64-gnu", label: "32.so" }),
    ).toThrow(/not ELF64/u);
    expect(() =>
      inspectPlatformBinaryBuffer(elf({ littleEndian: false }), { target: "linux-x64-gnu", label: "be.so" }),
    ).toThrow(/not little-endian/u);
    expect(() =>
      inspectPlatformBinaryBuffer(elf({ truncateSectionTable: true }), {
        target: "linux-x64-gnu",
        label: "truncated.so",
      }),
    ).toThrow(/section-header table.*outside/u);
  });

  test("accepts Android without GNU desktop versions and rejects GLIBC leakage", () => {
    expect(() =>
      inspectPlatformBinaryBuffer(elf({ machine: 183, androidApi: 24 }), {
        target: "android-arm64-v8a",
        label: "liboliphaunt.so",
      }),
    ).not.toThrow();
    expect(() =>
      inspectPlatformBinaryBuffer(elf({ machine: 183, versions: ["GLIBC_2.17"], androidApi: 24 }), {
        target: "android-arm64-v8a",
        label: "host-leak.so",
      }),
    ).toThrow(/Android ELF requires forbidden.*GLIBC_2\.17/u);
    expect(() =>
      inspectPlatformBinaryBuffer(elf({ machine: 183 }), {
        target: "android-arm64-v8a",
        label: "missing-note.so",
      }),
    ).toThrow(/exactly one \.note\.android\.ident API record/u);
    expect(() =>
      inspectPlatformBinaryBuffer(elf({ machine: 183, androidApi: 26 }), {
        target: "android-arm64-v8a",
        label: "wrong-api.so",
      }),
    ).toThrow(/API level 26 does not match.*24/u);
  });
});

describe("PE32+ architecture and self-contained runtime imports", () => {
  test("accepts x64 PE32+ system imports", () => {
    const result = inspectPlatformBinaryBuffer(pe({ imports: ["node.exe", "KERNEL32.dll"] }), {
      target: "windows-x64-msvc",
      label: "oliphaunt_node.node",
    });
    expect(result.slices[0].imports).toEqual(["KERNEL32.dll", "node.exe"]);
  });

  test("requires app-local production MSVC runtime closure and rejects debug CRT", () => {
    const main = pe({ imports: ["VCRUNTIME140.dll"], delayImports: ["MSVCP140.dll"] });
    expect(() =>
      inspectPlatformBinaryEntries([entry("bin/oliphaunt.dll", main)], { target: "windows-x64-msvc" }),
    ).toThrow(/MSVCP140\.dll.*not bundled/u);
    expect(() =>
      inspectPlatformBinaryEntries(
        [
          entry("bin/oliphaunt.dll", main),
          entry("bin/VCRUNTIME140.dll", pe()),
          entry("bin/MSVCP140.dll", pe({ imports: ["VCRUNTIME140.dll"] })),
        ],
        { target: "windows-x64-msvc" },
      ),
    ).not.toThrow();
    expect(() =>
      inspectPlatformBinaryBuffer(pe({ imports: ["VCRUNTIME140D.dll"] }), {
        target: "windows-x64-msvc",
        label: "debug.exe",
      }),
    ).toThrow(/undeclared or debug VC runtime/u);
    expect(() =>
      inspectPlatformBinaryBuffer(pe({ imports: ["CONCRT140.dll"] }), {
        target: "windows-x64-msvc",
        label: "undeclared.exe",
      }),
    ).toThrow(/undeclared or debug VC runtime CONCRT140\.dll/u);
    expect(() =>
      inspectPlatformBinaryEntries(
        [entry("bin/oliphaunt.dll", pe()), entry("bin/vcruntime140.dll", pe())],
        { target: "windows-x64-msvc" },
      ),
    ).toThrow(/unneeded VC runtime closure member vcruntime140\.dll/u);
    expect(() =>
      inspectPlatformBinaryEntries(
        [
          entry("bin/oliphaunt.dll", pe()),
          entry("bin/msvcp140.dll", pe()),
          entry("bin/vcruntime140.dll", pe()),
          entry("bin/vcruntime140_1.dll", pe()),
        ],
        { target: "windows-x64-msvc", windowsVcRuntimeProfile: "provider" },
      ),
    ).not.toThrow();
    expect(() =>
      inspectPlatformBinaryEntries(
        [entry("bin/oliphaunt.dll", pe()), entry("bin/vcruntime140.dll", pe())],
        { target: "windows-x64-msvc", windowsVcRuntimeProfile: "provider" },
      ),
    ).toThrow(/provider VC runtime profile is missing msvcp140\.dll, vcruntime140_1\.dll/u);
  });

  test("rejects x86, PE32, malformed import descriptors, and truncated files", () => {
    expect(() =>
      inspectPlatformBinaryBuffer(pe({ machine: 0x14c }), { target: "windows-x64-msvc", label: "x86.exe" }),
    ).toThrow(/not x64/u);
    expect(() =>
      inspectPlatformBinaryBuffer(pe({ optionalMagic: 0x10b }), {
        target: "windows-x64-msvc",
        label: "pe32.exe",
      }),
    ).toThrow(/not PE32\+/u);
    const unterminated = pe({ imports: ["KERNEL32.dll"] });
    const optional = 0x80 + 24;
    unterminated.writeUInt32LE(20, optional + 124);
    expect(() =>
      inspectPlatformBinaryBuffer(unterminated, { target: "windows-x64-msvc", label: "bad.exe" }),
    ).toThrow(/unterminated/u);
    expect(() =>
      inspectPlatformBinaryBuffer(Buffer.from("MZ"), { target: "windows-x64-msvc", label: "short.exe" }),
    ).toThrow(/DOS header.*outside/u);
  });

  test("validates the exported Windows contract through the standalone CLI", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "platform-binary-windows-cli-"));
    temporaryRoots.push(root);
    await writeFile(path.join(root, "oliphaunt_node.node"), pe());
    const result = spawnSync(
      process.execPath,
      [
        path.join(import.meta.dir, "platform-binary-contract.mjs"),
        "--target",
        "windows-x64-msvc",
        "--root",
        root,
      ],
      { encoding: "utf8" },
    );
    expect(result.status, `${result.stderr}${result.stdout}`).toBe(0);
    expect(result.stdout).toContain("platform binary contract passed: target=windows-x64-msvc");
  });

  test("accepts only the required lib/oliphaunt.lib import-library identity behind an explicit runtime opt-in", async () => {
    const importLibrary = windowsImportLibraryFixture();
    const runtimeEntries = [
      entry("bin/oliphaunt.dll", pe()),
      entry("lib/oliphaunt.lib", importLibrary),
    ];
    const result = inspectPlatformBinaryEntries(runtimeEntries, {
      target: "windows-x64-msvc",
      requireWindowsRuntimeImportLibrary: true,
    });
    expect(result.files).toEqual(["bin/oliphaunt.dll", "lib/oliphaunt.lib"]);
    expect(result.binaries).toBe(2);
    expect(result.slices).toBe(6);

    expect(() =>
      inspectPlatformBinaryEntries(runtimeEntries, { target: "windows-x64-msvc" }),
    ).toThrow(/only permitted when the exact lib\/oliphaunt\.lib runtime contract is required/u);
    expect(() =>
      inspectPlatformBinaryEntries(
        [entry("bin/oliphaunt.dll", pe()), entry("lib/renamed.lib", importLibrary)],
        { target: "windows-x64-msvc", requireWindowsRuntimeImportLibrary: true },
      ),
    ).toThrow(/only the exact lib\/oliphaunt\.lib runtime import library is permitted/u);
    expect(() =>
      inspectPlatformBinaryEntries([entry("bin/oliphaunt.dll", pe())], {
        target: "windows-x64-msvc",
        requireWindowsRuntimeImportLibrary: true,
      }),
    ).toThrow(/lib\/oliphaunt\.lib.*required Windows runtime import library is missing/u);
    expect(() =>
      inspectPlatformBinaryEntries([...runtimeEntries, entry("lib/oliphaunt.lib", importLibrary)], {
        target: "windows-x64-msvc",
        requireWindowsRuntimeImportLibrary: true,
      }),
    ).toThrow(/repeats lib\/oliphaunt\.lib/u);

    const root = await mkdtemp(path.join(tmpdir(), "platform-binary-windows-import-library-cli-"));
    temporaryRoots.push(root);
    await mkdir(path.join(root, "bin"), { recursive: true });
    await mkdir(path.join(root, "lib"), { recursive: true });
    await writeFile(path.join(root, "bin/oliphaunt.dll"), pe());
    await writeFile(path.join(root, "lib/oliphaunt.lib"), importLibrary);
    const cli = spawnSync(
      process.execPath,
      [
        path.join(import.meta.dir, "platform-binary-contract.mjs"),
        "--target",
        "windows-x64-msvc",
        "--root",
        root,
        "--require-windows-runtime-import-library",
      ],
      { encoding: "utf8" },
    );
    expect(cli.status, `${cli.stderr}${cli.stdout}`).toBe(0);
  });

  test("keeps PostGIS COPYING.LIB legal text out of Windows binary discovery without admitting stray libraries", () => {
    const legalText = Buffer.from(
      "GNU LIBRARY GENERAL PUBLIC LICENSE\n\fTERMS AND CONDITIONS\n",
      "utf8",
    );
    const entries = [
      entry("bin/oliphaunt.dll", pe()),
      entry("files/lib/postgresql/postgis-3.dll", pe()),
      entry("files/lib/modules/postgis-3.dll", pe()),
      entry("lib/oliphaunt.lib", windowsImportLibraryFixture()),
      entry("files/share/licenses/libcharset/COPYING.LIB", legalText),
      entry("files/share/licenses/libiconv/COPYING.LIB", legalText),
    ];
    const result = inspectPlatformBinaryEntries(entries, {
      target: "windows-x64-msvc",
      requireWindowsRuntimeImportLibrary: true,
    });
    expect(result.files).toEqual([
      "bin/oliphaunt.dll",
      "files/lib/modules/postgis-3.dll",
      "files/lib/postgresql/postgis-3.dll",
      "lib/oliphaunt.lib",
    ]);
    expect(result.binaries).toBe(4);

    expect(() =>
      inspectPlatformBinaryEntries(
        [...entries, entry("files/lib/arbitrary.lib", windowsImportLibraryFixture())],
        { target: "windows-x64-msvc", requireWindowsRuntimeImportLibrary: true },
      ),
    ).toThrow(/only the exact lib\/oliphaunt\.lib runtime import library is permitted/u);
    expect(() =>
      inspectPlatformBinaryEntries(
        [...entries, entry("files/lib/malformed.lib", Buffer.from("not an import library\n"))],
        { target: "windows-x64-msvc", requireWindowsRuntimeImportLibrary: true },
      ),
    ).toThrow(/files\/lib\/malformed\.lib.*expected native binary is malformed or truncated/u);
    expect(() =>
      inspectPlatformBinaryEntries(
        [...entries, entry("files/share/uncontracted/COPYING.LIB", legalText)],
        { target: "windows-x64-msvc", requireWindowsRuntimeImportLibrary: true },
      ),
    ).toThrow(/files\/share\/uncontracted\/COPYING\.LIB.*expected native binary is malformed or truncated/u);
    expect(() =>
      inspectPlatformBinaryEntries(
        entries.map((candidate) =>
          candidate.name === "files/share/licenses/libcharset/COPYING.LIB"
            ? entry(candidate.name, windowsImportLibraryFixture())
            : candidate,
        ),
        { target: "windows-x64-msvc", requireWindowsRuntimeImportLibrary: true },
      ),
    ).toThrow(/only the exact lib\/oliphaunt\.lib runtime import library is permitted/u);
    expect(() =>
      inspectPlatformBinaryEntries(
        entries.map((candidate) =>
          candidate.name === "files/share/licenses/libcharset/COPYING.LIB"
            ? entry(candidate.name, Buffer.from([0x47, 0x50, 0x4c, 0x00, 0xff]))
            : candidate,
        ),
        { target: "windows-x64-msvc", requireWindowsRuntimeImportLibrary: true },
      ),
    ).toThrow(/COPYING\.LIB.*expected native binary is malformed or truncated/u);
  });

  test("rejects malformed, wrong-machine, wrong-DLL, and arbitrary Windows libraries", () => {
    const inspectImportLibrary = (data) =>
      inspectPlatformBinaryEntries(
        [entry("bin/oliphaunt.dll", pe()), entry("lib/oliphaunt.lib", data)],
        { target: "windows-x64-msvc", requireWindowsRuntimeImportLibrary: true },
      );

    expect(() =>
      inspectImportLibrary(windowsImportLibraryFixture({ objectMachine: 0x14c })),
    ).toThrow(/COFF object machine 0x14c is not x64/u);
    expect(() =>
      inspectImportLibrary(windowsImportLibraryFixture({ importMachine: 0x14c })),
    ).toThrow(/COFF import-object machine 0x14c is not x64/u);
    expect(() =>
      inspectImportLibrary(windowsImportLibraryFixture({ dllName: "unrelated.dll" })),
    ).toThrow(/names unexpected DLL "unrelated\.dll"/u);
    expect(() =>
      inspectImportLibrary(windowsImportLibraryFixture({ symbol: "unrelated_symbol" })),
    ).toThrow(/does not expose required symbol oliphaunt_init/u);
    expect(() =>
      inspectImportLibrary(windowsImportLibraryFixture({ importSymbols: ["oliphaunt_init"] })),
    ).toThrow(/does not expose required symbol oliphaunt_init_ex/u);
    expect(() =>
      inspectImportLibrary(
        windowsImportLibraryFixture({
          importSymbols: ["oliphaunt_init", "oliphaunt_init_ex"],
        }),
      ),
    ).toThrow(/does not expose required symbol oliphaunt_logical_generation/u);
    expect(() =>
      inspectImportLibrary(
        windowsImportLibraryFixture({
          importSymbols: [
            "oliphaunt_init",
            "oliphaunt_init_ex",
            "oliphaunt_logical_generation",
          ],
        }),
      ),
    ).toThrow(/does not expose required symbol oliphaunt_close_if_generation/u);

    const invalidOffset = Buffer.from(windowsImportLibraryFixture());
    invalidOffset.writeUInt32BE(0, 8 + 60 + 4);
    expect(() => inspectImportLibrary(invalidOffset)).toThrow(/refers to non-object archive offset 0/u);
    expect(() => inspectImportLibrary(Buffer.from("not an import library\n"))).toThrow(
      /expected native binary is malformed or truncated/u,
    );
    expect(() =>
      inspectPlatformBinaryEntries(
        [entry("bin/oliphaunt.dll", pe()), entry("lib/arbitrary.lib", windowsImportLibraryFixture())],
        { target: "windows-x64-msvc" },
      ),
    ).toThrow(/only the exact lib\/oliphaunt\.lib runtime import library is permitted/u);
    expect(() =>
      inspectPlatformBinaryEntries(
        [entry("bin/oliphaunt.dll", pe()), entry("lib/arbitrary.lib", pe())],
        { target: "windows-x64-msvc" },
      ),
    ).toThrow(/only the exact lib\/oliphaunt\.lib runtime import library is permitted/u);
    expect(() =>
      inspectPlatformBinaryEntries(
        [entry("bin/oliphaunt.dll", pe()), entry("lib/development.a", windowsImportLibraryFixture())],
        { target: "windows-x64-msvc" },
      ),
    ).toThrow(/static \.a archives are not permitted in a Windows release carrier/u);
    expect(() =>
      inspectPlatformBinaryEntries(
        [entry("bin/oliphaunt.dll", pe()), entry("lib/development.a", pe())],
        { target: "windows-x64-msvc" },
      ),
    ).toThrow(/static \.a archives are not permitted in a Windows release carrier/u);
  });

  test("keeps the real Windows package shape and hosted C link smoke behind the same validator", async () => {
    const packager = await readFile(
      path.join(import.meta.dir, "package-liboliphaunt-windows-assets.ps1"),
      "utf8",
    );
    expect(packager).toContain('$ImportLib = Join-Path $WorkRoot "out/lib/oliphaunt.lib"');
    expect(packager).toContain('Copy-Item -Force $ImportLib (Join-Path $Stage "lib")');
    const validation = packager.indexOf("--require-windows-runtime-import-library");
    const linkSmoke = packager.indexOf("run-host-c-smoke.mjs");
    expect(validation).toBeGreaterThan(0);
    expect(linkSmoke).toBeGreaterThan(validation);
  });
});

describe("staged-tree discovery", () => {
  test("requires a binary and rejects malformed expected binary names", () => {
    expect(() => inspectPlatformBinaryEntries([entry("README.md", Buffer.from("text"))], { target: "linux-x64-gnu" })).toThrow(
      /no ELF binaries/u,
    );
    expect(() =>
      inspectPlatformBinaryEntries(
        [entry("lib/good.so", elf()), entry("lib/truncated.dylib", Buffer.from([0xcf, 0xfa]))],
        { target: "linux-x64-gnu" },
      ),
    ).toThrow(/truncated\.dylib.*malformed or truncated/u);
    expect(() =>
      inspectPlatformBinaryEntries([entry("lib/wrong.so", macho())], { target: "linux-x64-gnu" }),
    ).toThrow(/MACHO content does not match/u);
  });

  test("walks a staged release tree without executing platform tools", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oliphaunt-platform-binary-"));
    temporaryRoots.push(root);
    await mkdir(path.join(root, "lib"), { recursive: true });
    await writeFile(path.join(root, "README.md"), "fixture");
    await writeFile(path.join(root, "lib", "liboliphaunt.so"), elf({ versions: ["GLIBC_2.38"] }));
    const result = await inspectPlatformBinaryTree(root, { target: "linux-x64-gnu" });
    expect(result.binaries).toBe(1);
    expect(result.files).toEqual(["lib/liboliphaunt.so"]);
  });

  test("fails closed on symbolic links and non-regular archive entries", async () => {
    expect(() =>
      inspectPlatformBinaryEntries(
        [entry("lib/libok.so", elf()), { name: "lib/redirect.so", isFile: false, isSymbolicLink: true }],
        { target: "linux-x64-gnu" },
      ),
    ).toThrow(/redirect\.so.*symbolic link/u);
    expect(() =>
      inspectPlatformBinaryEntries(
        [entry("lib/libok.so", elf()), { name: "lib/device", isFile: false }],
        { target: "linux-x64-gnu" },
      ),
    ).toThrow(/device.*non-regular special entry/u);

    const root = await mkdtemp(path.join(tmpdir(), "platform-binary-link-"));
    temporaryRoots.push(root);
    await mkdir(path.join(root, "lib"));
    await writeFile(path.join(root, "lib/libok.so"), elf());
    await writeFile(path.join(root, "target"), "outside");
    await symlink("target", path.join(root, "redirect"));
    await expect(inspectPlatformBinaryTree(root, { target: "linux-x64-gnu" })).rejects.toThrow(
      /redirect.*symbolic link/u,
    );
  });
});
