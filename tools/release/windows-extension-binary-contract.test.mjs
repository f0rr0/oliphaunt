import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  parseExtensionCatalog,
  stageWindowsExtensionBinaryContract,
  validateWindowsEmbeddedModuleImports,
  validateWindowsExtensionArtifactBinaryContract,
  validateWindowsServerModuleImports,
} from "../../src/extensions/artifacts/native/tools/stage-windows-binary-contract.mjs";
import { validateExactArtifactBinaryContract } from "../../src/extensions/artifacts/native/tools/extension-artifact-packager.mjs";
import { inspectPlatformBinaryTree } from "./platform-binary-contract.mjs";
import { WINDOWS_VC_RUNTIME_DLLS } from "./windows-vc-runtime-closure.mjs";
import { elfFixture, machoFixture } from "../test/release-fixture-utils.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");
const temporaryRoots = [];
const CATALOG_HEADER = [
  "sql_name",
  "pg_major",
  "creates_extension",
  "native_module_stem",
  "dependencies",
  "shared_preload",
  "desktop_prebuilt",
  "mobile_prebuilt",
  "mobile_static_registry_required",
  "mobile_static_archive_targets",
  "data_files",
  "artifact",
].join("\t");

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(name) {
  const root = await mkdtemp(
    path.join(tmpdir(), `oliphaunt-windows-extension-contract-${name}-`),
  );
  temporaryRoots.push(root);
  return root;
}

function catalog(...rows) {
  return `${[CATALOG_HEADER, ...rows.map((row) => row.join("\t"))].join("\n")}\n`;
}

const vectorRow = [
  "vector",
  "18",
  "yes",
  "vector",
  "-",
  "-",
  "yes",
  "yes",
  "yes",
  "-",
  "-",
  "first-party",
];
const postgisRow = [
  "postgis",
  "18",
  "yes",
  "postgis-3",
  "-",
  "-",
  "yes",
  "yes",
  "yes",
  "-",
  "-",
  "first-party",
];
const deferredQualificationRow = [
  "deferred_extension",
  "18",
  "yes",
  "deferred_extension",
  "-",
  "-",
  "yes",
  "no",
  "yes",
  "-",
  "-",
  "contrib",
];
const HOSTED_EARTHDISTANCE_IMPORTS = Object.freeze([
  "VCRUNTIME140.dll",
  "api-ms-win-crt-math-l1-1-0.dll",
  "api-ms-win-crt-runtime-l1-1-0.dll",
  "KERNEL32.dll",
]);

function pe({
  machine = 0x8664,
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
  buffer.writeUInt16LE(0x20b, optional);
  buffer.writeBigUInt64LE(0x140000000n, optional + 24);
  buffer.writeUInt32LE(rawOffset, optional + 60);
  buffer.writeUInt32LE(16, optional + 108);
  buffer.writeUInt32LE(virtualAddress, optional + 120);
  buffer.writeUInt32LE((imports.length + 1) * 20, optional + 124);
  if (delayImports.length > 0) {
    const delayDescriptorOffset = rawOffset + 0x100;
    buffer.writeUInt32LE(
      virtualAddress + (delayDescriptorOffset - rawOffset),
      optional + 216,
    );
    buffer.writeUInt32LE(
      (delayImports.length + 1) * 32,
      optional + 220,
    );
  }
  buffer.write(".rdata\0\0", sectionTable, "ascii");
  buffer.writeUInt32LE(rawSize, sectionTable + 8);
  buffer.writeUInt32LE(virtualAddress, sectionTable + 12);
  buffer.writeUInt32LE(rawSize, sectionTable + 16);
  buffer.writeUInt32LE(rawOffset, sectionTable + 20);
  let nameOffset = rawOffset + 0x200;
  for (const [index, name] of imports.entries()) {
    buffer.writeUInt32LE(
      virtualAddress + (nameOffset - rawOffset),
      rawOffset + index * 20 + 12,
    );
    buffer.write(`${name}\0`, nameOffset, "ascii");
    nameOffset += Buffer.byteLength(name) + 1;
  }
  for (const [index, name] of delayImports.entries()) {
    const descriptor = rawOffset + 0x100 + index * 32;
    buffer.writeUInt32LE(1, descriptor);
    buffer.writeUInt32LE(
      virtualAddress + (nameOffset - rawOffset),
      descriptor + 4,
    );
    buffer.write(`${name}\0`, nameOffset, "ascii");
    nameOffset += Buffer.byteLength(name) + 1;
  }
  return buffer;
}

async function writeRuntimeFile(runtime, relative, data) {
  const file = path.join(runtime, ...relative.split("/"));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data);
}

async function createProviderRuntime(runtime) {
  for (const name of WINDOWS_VC_RUNTIME_DLLS) {
    await writeRuntimeFile(runtime, `bin/${name}`, pe());
  }
}

async function relativeFiles(root, relative = "") {
  const files = [];
  for (const entry of await readdir(path.join(root, relative), {
    withFileTypes: true,
  })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await relativeFiles(root, child)));
    else files.push(child);
  }
  return files.sort();
}

describe("desktop exact-extension post-strip binary qualification", () => {
  test("validates both Linux profiles and rejects a corrupt or over-floor embedded module", async () => {
    const root = await fixture("linux-exact-profiles");
    const artifact = path.join(root, "artifact");
    const server = "files/lib/postgresql/vector.so";
    const embedded = "files/lib/modules/vector.so";
    await writeRuntimeFile(
      artifact,
      server,
      elfFixture({ machine: 62, requiredVersions: ["GLIBC_2.17"] }),
    );
    await writeRuntimeFile(
      artifact,
      embedded,
      elfFixture({ machine: 62, requiredVersions: ["GLIBC_2.27"] }),
    );
    await writeRuntimeFile(
      artifact,
      "files/share/licenses/libcharset/COPYING.LIB",
      Buffer.from("GNU LIBRARY GENERAL PUBLIC LICENSE\n"),
    );
    const args = {
      nativeModuleStem: "vector",
      nativeTarget: "linux-x64-gnu",
    };
    await expect(validateExactArtifactBinaryContract(artifact, args)).resolves.toMatchObject({
      target: "linux-x64-gnu",
      binaries: 2,
    });

    await writeRuntimeFile(
      artifact,
      embedded,
      elfFixture({ machine: 62, requiredVersions: ["GLIBC_2.39"] }),
    );
    await expect(validateExactArtifactBinaryContract(artifact, args)).rejects.toThrow(
      /GLIBC_2\.39 exceeds/u,
    );

    await writeRuntimeFile(artifact, embedded, Buffer.from("truncated ELF"));
    await expect(validateExactArtifactBinaryContract(artifact, args)).rejects.toThrow(
      /expected native binary is malformed or truncated/u,
    );
  });

  test("validates both macOS profiles against the exact post-strip minimum-OS floor", async () => {
    const root = await fixture("macos-exact-profiles");
    const artifact = path.join(root, "artifact");
    const server = "files/lib/postgresql/vector.dylib";
    const embedded = "files/lib/modules/vector.dylib";
    await writeRuntimeFile(artifact, server, machoFixture({ minos: [11, 0, 0] }));
    await writeRuntimeFile(artifact, embedded, machoFixture({ minos: [11, 0, 0] }));
    const args = {
      nativeModuleStem: "vector",
      nativeTarget: "macos-arm64",
    };
    await expect(validateExactArtifactBinaryContract(artifact, args)).resolves.toMatchObject({
      target: "macos-arm64",
      binaries: 2,
    });

    await writeRuntimeFile(artifact, embedded, machoFixture({ minos: [14, 0, 0] }));
    await expect(validateExactArtifactBinaryContract(artifact, args)).rejects.toThrow(
      /minimum OS 14\.0 exceeds/u,
    );
  });
});

describe("Windows exact-extension binary-contract staging", () => {
  test("validates the public and deferred build union while excluding every development/archive class", async () => {
    const root = await fixture("selected");
    const runtime = path.join(root, "install");
    const output = path.join(root, "contract-view");
    await createProviderRuntime(runtime);
    await writeRuntimeFile(
      runtime,
      "lib/postgresql/vector.dll",
      pe({ imports: ["postgres.exe", "VCRUNTIME140.dll"] }),
    );
    await writeRuntimeFile(
      runtime,
      "lib/postgresql/deferred_extension.dll",
      pe({ imports: HOSTED_EARTHDISTANCE_IMPORTS }),
    );
    await writeRuntimeFile(
      runtime,
      "lib/postgresql/postgis-3.dll",
      pe({ machine: 0xaa64 }),
    );
    const installedDevelopmentArchives = [
      "lib/libpgport.a",
      "lib/libpgport_shlib.a",
      "lib/libpgcommon.a",
      "lib/libpgcommon_shlib.a",
      "lib/libpq.a",
      "lib/libpgfeutils.a",
      "lib/libpgtypes.a",
      "lib/libecpg.a",
      "lib/libecpg_compat.a",
      "lib/libpq.lib",
      "lib/postgres.lib",
      "lib/postgresql/pgevent.lib",
      "lib/libpgtypes.lib",
      "lib/libecpg.lib",
      "lib/libecpg_compat.lib",
    ];
    for (const relative of installedDevelopmentArchives) {
      await writeRuntimeFile(
        runtime,
        relative,
        Buffer.from("!<arch>\n", "ascii"),
      );
    }
    await writeRuntimeFile(
      runtime,
      "lib/libpgcommon.la",
      "development metadata\n",
    );
    await writeRuntimeFile(
      runtime,
      "lib/postgresql/pgevent.lib",
      Buffer.from("!<arch>\n", "ascii"),
    );
    await writeRuntimeFile(runtime, "bin/postgres.pdb", "debug symbols\n");
    await writeRuntimeFile(
      runtime,
      "include/postgresql/server/postgres.h",
      "development header\n",
    );

    const result = await stageWindowsExtensionBinaryContract({
      runtimeRoot: runtime,
      catalogText: catalog(vectorRow, postgisRow, deferredQualificationRow),
      selectedSqlNames: "vector,deferred_extension",
      outputRoot: output,
    });

    expect(result.schema).toBe(
      "oliphaunt-windows-extension-binary-contract-v4",
    );
    expect(result.standaloneBackendProvider).toBe("postgres.exe");
    expect(result.forbiddenEmbeddedBackendProvider).toBe("oliphaunt.dll");
    expect(result.extensionModules).toEqual([
      "deferred_extension.dll",
      "vector.dll",
    ]);
    expect(result.serverBoundExtensionModules).toEqual(["vector.dll"]);
    expect(result.hostNeutralServerModules).toEqual(["deferred_extension.dll"]);
    expect(result.providerRuntimeDlls).toEqual([...WINDOWS_VC_RUNTIME_DLLS]);
    expect(await relativeFiles(output)).toEqual(
      [
        ...WINDOWS_VC_RUNTIME_DLLS.map((name) => `bin/${name}`),
        "binary-contract-manifest.json",
        "lib/postgresql/deferred_extension.dll",
        "lib/postgresql/vector.dll",
      ].sort(),
    );
    const inspected = await inspectPlatformBinaryTree(output, {
      target: "windows-x64-msvc",
      windowsVcRuntimeProfile: "provider",
    });
    expect(inspected.files).toContain("lib/postgresql/vector.dll");
    expect(inspected.files).toContain("lib/postgresql/deferred_extension.dll");
    expect(inspected.files).not.toContain("lib/postgresql/postgis-3.dll");
    for (const relative of installedDevelopmentArchives) {
      expect(inspected.files).not.toContain(relative);
    }
    expect(inspected.binaries).toBe(WINDOWS_VC_RUNTIME_DLLS.length + 2);
  });

  test("still rejects a selected wrong-architecture extension DLL", async () => {
    const root = await fixture("wrong-architecture");
    const runtime = path.join(root, "install");
    const output = path.join(root, "contract-view");
    await createProviderRuntime(runtime);
    await writeRuntimeFile(
      runtime,
      "lib/postgresql/vector.dll",
      pe({ machine: 0xaa64 }),
    );
    await expect(
      stageWindowsExtensionBinaryContract({
        runtimeRoot: runtime,
        catalogText: catalog(vectorRow),
        selectedSqlNames: "vector",
        outputRoot: output,
      }),
    ).rejects.toThrow(/PE machine 0xaa64 is not x64/u);
  });

  test("classifies backend bindings from direct and delay import inventories, independent of module name", () => {
    expect(
      validateWindowsServerModuleImports(
        pe({ imports: HOSTED_EARTHDISTANCE_IMPORTS }),
        "earthdistance.dll",
      ),
    ).toMatchObject({
      backendProvider: "host-neutral",
      hostNeutral: true,
      serverBound: false,
    });
    expect(
      validateWindowsEmbeddedModuleImports(
        pe({ imports: HOSTED_EARTHDISTANCE_IMPORTS }),
        "earthdistance.dll",
      ),
    ).toMatchObject({
      backendProvider: "host-neutral",
      hostNeutral: true,
      providerBound: false,
    });
    expect(
      validateWindowsServerModuleImports(
        pe({ imports: ["VCRUNTIME140.dll"], delayImports: ["PoStGrEs.ExE"] }),
        "earthdistance.dll",
      ),
    ).toMatchObject({
      backendProvider: "postgres.exe",
      hostNeutral: false,
      serverBound: true,
    });
    expect(() =>
      validateWindowsEmbeddedModuleImports(
        pe({ imports: ["VCRUNTIME140.dll"], delayImports: ["PoStGrEs.ExE"] }),
        "earthdistance.dll",
      ),
    ).toThrow(/imports postgres\.exe/u);
  });

  test("validates exact post-strip artifact bytes and never ignores an archive that enters the carrier", async () => {
    const root = await fixture("exact-artifact");
    const runtime = path.join(root, "install");
    const artifact = path.join(root, "artifact");
    await createProviderRuntime(runtime);
    await writeRuntimeFile(
      artifact,
      "files/lib/postgresql/vector.dll",
      pe({ imports: ["postgres.exe", "VCRUNTIME140.dll"] }),
    );
    await writeRuntimeFile(
      artifact,
      "files/lib/modules/vector.dll",
      pe({ imports: ["oliphaunt.dll", "VCRUNTIME140.dll"] }),
    );
    const neutralEarthdistance = pe({
      imports: HOSTED_EARTHDISTANCE_IMPORTS,
    });
    await writeRuntimeFile(
      artifact,
      "files/lib/postgresql/earthdistance.dll",
      neutralEarthdistance,
    );
    await writeRuntimeFile(
      artifact,
      "files/lib/modules/earthdistance.dll",
      neutralEarthdistance,
    );
    await writeRuntimeFile(
      artifact,
      "files/share/postgresql/extension/vector.control",
      "default_version = '0.8.2'\n",
    );
    await writeRuntimeFile(
      artifact,
      "files/share/licenses/libcharset/COPYING.LIB",
      "GNU LIBRARY GENERAL PUBLIC LICENSE\n",
    );
    await writeRuntimeFile(
      artifact,
      "files/share/licenses/libiconv/COPYING.LIB",
      "GNU LIBRARY GENERAL PUBLIC LICENSE\n",
    );

    const result = await validateWindowsExtensionArtifactBinaryContract({
      artifactRoot: artifact,
      providerRuntimeRoot: runtime,
    });
    expect(result.files).toContain("artifact/files/lib/postgresql/vector.dll");
    expect(result.files).toContain("artifact/files/lib/modules/vector.dll");
    expect(result.files).not.toContain(
      "artifact/files/share/licenses/libcharset/COPYING.LIB",
    );
    expect(result.files).not.toContain(
      "artifact/files/share/licenses/libiconv/COPYING.LIB",
    );
    expect(result.serverBoundExtensionModules).toEqual(["vector.dll"]);
    expect(result.providerBoundEmbeddedModules).toEqual(["vector.dll"]);
    expect(result.hostNeutralServerModules).toEqual(["earthdistance.dll"]);
    expect(result.hostNeutralEmbeddedModules).toEqual(["earthdistance.dll"]);
    expect(result.byteIdenticalHostNeutralModules).toEqual([
      "earthdistance.dll",
    ]);
    expect(result.profileBindings).toEqual({
      "earthdistance.dll": {
        embedded: "host-neutral",
        server: "host-neutral",
      },
      "vector.dll": {
        embedded: "oliphaunt.dll",
        server: "postgres.exe",
      },
    });
    expect(result.profileSha256["earthdistance.dll"].server).toBe(
      result.profileSha256["earthdistance.dll"].embedded,
    );
    expect(result.profileSha256["vector.dll"].server).not.toBe(
      result.profileSha256["vector.dll"].embedded,
    );

    await writeRuntimeFile(
      artifact,
      "files/lib/accidental-development.a",
      Buffer.from("!<arch>\n", "ascii"),
    );
    await expect(
      validateWindowsExtensionArtifactBinaryContract({
        artifactRoot: artifact,
        providerRuntimeRoot: runtime,
      }),
    ).rejects.toThrow(
      /static \.a archives are not permitted in a Windows release carrier/u,
    );
    await rm(path.join(artifact, "files/lib/accidental-development.a"));

    await writeRuntimeFile(
      artifact,
      "files/lib/postgresql/vector.dll",
      pe({ machine: 0xaa64 }),
    );
    await expect(
      validateWindowsExtensionArtifactBinaryContract({
        artifactRoot: artifact,
        providerRuntimeRoot: runtime,
      }),
    ).rejects.toThrow(/PE machine 0xaa64 is not x64/u);
  });

  test("fails closed for unknown selections, missing modules, malformed catalogs, and overlapping output", async () => {
    const root = await fixture("fail-closed");
    const runtime = path.join(root, "install");
    await createProviderRuntime(runtime);

    expect(() => parseExtensionCatalog(catalog(vectorRow), "missing")).toThrow(
      /absent from the extension catalog/u,
    );
    expect(() =>
      parseExtensionCatalog(`${CATALOG_HEADER}\nvector\t18\n`, "vector"),
    ).toThrow(/has 2 columns/u);
    await expect(
      stageWindowsExtensionBinaryContract({
        runtimeRoot: runtime,
        catalogText: catalog(vectorRow),
        selectedSqlNames: "vector",
        outputRoot: path.join(root, "contract-view"),
      }),
    ).rejects.toThrow(
      /lib\/postgresql\/vector\.dll must be a real regular file/u,
    );
    await expect(
      stageWindowsExtensionBinaryContract({
        runtimeRoot: runtime,
        catalogText: catalog(vectorRow),
        selectedSqlNames: "vector",
        outputRoot: path.join(runtime, "contract-view"),
      }),
    ).rejects.toThrow(/must not overlap/u);

    const runtimeAlias = path.join(root, "runtime-alias");
    await symlink(
      runtime,
      runtimeAlias,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      stageWindowsExtensionBinaryContract({
        runtimeRoot: runtime,
        catalogText: catalog(vectorRow),
        selectedSqlNames: "vector",
        outputRoot: path.join(runtimeAlias, "missing-stage", "contract-view"),
      }),
    ).rejects.toThrow(/must not overlap/u);
    expect(await readdir(runtime)).not.toContain("missing-stage");

    const protectedOutput = path.join(root, "protected-output");
    await writeFile(protectedOutput, "do not replace\n");
    await expect(
      stageWindowsExtensionBinaryContract({
        runtimeRoot: runtime,
        catalogText: catalog(vectorRow),
        selectedSqlNames: "vector",
        outputRoot: protectedOutput,
      }),
    ).rejects.toThrow(/must be a real directory/u);
    expect(await readFile(protectedOutput, "utf8")).toBe("do not replace\n");
  });

  test("rejects direct and delay-loaded embedded-provider imports in the standalone server profile", async () => {
    const root = await fixture("server-provider-confusion");
    const runtime = path.join(root, "install");
    const output = path.join(root, "contract-view");
    await createProviderRuntime(runtime);
    await writeRuntimeFile(
      runtime,
      "lib/postgresql/vector.dll",
      pe({ imports: ["oliphaunt.dll", "VCRUNTIME140.dll"] }),
    );

    await expect(
      stageWindowsExtensionBinaryContract({
        runtimeRoot: runtime,
        catalogText: catalog(vectorRow),
        selectedSqlNames: "vector",
        outputRoot: output,
      }),
    ).rejects.toThrow(
      /imports oliphaunt\.dll; standalone PostgreSQL extension DLLs must not bind to the embedded provider/u,
    );

    await writeRuntimeFile(
      runtime,
      "lib/postgresql/vector.dll",
      pe({
        imports: ["postgres.exe", "VCRUNTIME140.dll"],
        delayImports: ["OlIpHaUnT.DlL"],
      }),
    );
    await expect(
      stageWindowsExtensionBinaryContract({
        runtimeRoot: runtime,
        catalogText: catalog(vectorRow),
        selectedSqlNames: "vector",
        outputRoot: output,
      }),
    ).rejects.toThrow(
      /imports oliphaunt\.dll; standalone PostgreSQL extension DLLs must not bind to the embedded provider/u,
    );
  });

  test("accepts byte-identical neutral profiles but rejects every crossed provider and a missing profile", async () => {
    const root = await fixture("exact-profile-confusion");
    const runtime = path.join(root, "install");
    const artifact = path.join(root, "artifact");
    await createProviderRuntime(runtime);
    const neutral = pe({ imports: HOSTED_EARTHDISTANCE_IMPORTS });
    await writeRuntimeFile(
      artifact,
      "files/lib/postgresql/earthdistance.dll",
      neutral,
    );
    await writeRuntimeFile(
      artifact,
      "files/lib/modules/earthdistance.dll",
      neutral,
    );

    await expect(
      validateWindowsExtensionArtifactBinaryContract({
        artifactRoot: artifact,
        providerRuntimeRoot: runtime,
      }),
    ).resolves.toMatchObject({
      byteIdenticalHostNeutralModules: ["earthdistance.dll"],
      hostNeutralEmbeddedModules: ["earthdistance.dll"],
      hostNeutralServerModules: ["earthdistance.dll"],
      providerBoundEmbeddedModules: [],
      serverBoundExtensionModules: [],
    });

    const crossed = pe({ imports: ["postgres.exe", "VCRUNTIME140.dll"] });
    await writeRuntimeFile(artifact, "files/lib/modules/earthdistance.dll", crossed);
    await expect(
      validateWindowsExtensionArtifactBinaryContract({
        artifactRoot: artifact,
        providerRuntimeRoot: runtime,
      }),
    ).rejects.toThrow(
      /imports postgres\.exe; embedded extension DLLs must not bind to the standalone server provider/u,
    );

    await writeRuntimeFile(
      artifact,
      "files/lib/modules/earthdistance.dll",
      neutral,
    );
    await writeRuntimeFile(
      artifact,
      "files/lib/postgresql/earthdistance.dll",
      pe({ imports: ["oliphaunt.dll", "VCRUNTIME140.dll"] }),
    );
    await expect(
      validateWindowsExtensionArtifactBinaryContract({
        artifactRoot: artifact,
        providerRuntimeRoot: runtime,
      }),
    ).rejects.toThrow(
      /imports oliphaunt\.dll; standalone PostgreSQL extension DLLs must not bind to the embedded provider/u,
    );

    await writeRuntimeFile(
      artifact,
      "files/lib/postgresql/earthdistance.dll",
      neutral,
    );
    await rm(path.join(artifact, "files/lib/modules/earthdistance.dll"));
    await expect(
      validateWindowsExtensionArtifactBinaryContract({
        artifactRoot: artifact,
        providerRuntimeRoot: runtime,
      }),
    ).rejects.toThrow(/missing embedded provider profile/u);
  });

  test("the hosted packager validates the staged selection after verifying the provider closure", async () => {
    const source = await readFile(
      path.join(
        ROOT,
        "src/extensions/artifacts/native/tools/package-release-assets.sh",
      ),
      "utf8",
    );
    const desktop = source.slice(
      source.indexOf("package_desktop_target()"),
      source.indexOf("package_ios_target()"),
    );
    const closure = desktop.indexOf("windows-vc-runtime-closure.mjs verify");
    const stage = desktop.indexOf(
      'binary_contract_runtime="$(prepare_windows_binary_contract_runtime "$runtime")"',
    );
    const contract = desktop.indexOf('--root "$binary_contract_runtime"');
    const qualificationReturn = desktop.indexOf(
      'if [ "$qualification_only" = "1" ]; then',
    );
    const windowsBranch = desktop.slice(
      desktop.indexOf('if [ "$target_id" = "windows-x64-msvc" ]; then'),
      desktop.indexOf("  else\n"),
    );
    expect(closure).toBeGreaterThan(-1);
    expect(stage).toBeGreaterThan(closure);
    expect(contract).toBeGreaterThan(stage);
    expect(qualificationReturn).toBeGreaterThan(contract);
    expect(windowsBranch.match(/--root "\$runtime"/gu)).toHaveLength(1);
    expect(windowsBranch).toContain('--root "$binary_contract_runtime"');
    const stageFunction = source.slice(
      source.indexOf("prepare_windows_binary_contract_runtime()"),
      source.indexOf("build_desktop_extension_runtime()"),
    );
    expect(stageFunction).toContain('--selected-sql-names "$build_sql_names"');
    expect(stageFunction).not.toContain('--selected-sql-names "$selected_sql_names"');

    for (const [start, end] of [
      ["package_desktop_target()", "package_ios_target()"],
      ["package_ios_target()", "package_android_target()"],
      ["package_android_target()", "\nfetch_extension_source_assets\n"],
    ]) {
      const body = source.slice(source.indexOf(start), source.indexOf(end));
      const qualificationOnlyReturn = body.indexOf(
        'if [ "$qualification_only" = "1" ]; then',
      );
      const publicCatalogLoop = body.indexOf("while IFS=$'\\t' read -r sql_name");
      const publicSelectionFilter = body.indexOf(
        'selected_sql_name_matches "$sql_name" || continue',
        publicCatalogLoop,
      );
      const artifactPackaging = body.indexOf(
        "make_extension_artifact",
        publicSelectionFilter,
      );
      expect(qualificationOnlyReturn).toBeGreaterThan(-1);
      expect(publicCatalogLoop).toBeGreaterThan(qualificationOnlyReturn);
      expect(publicSelectionFilter).toBeGreaterThan(publicCatalogLoop);
      expect(artifactPackaging).toBeGreaterThan(publicSelectionFilter);
    }

    const fetch = source.lastIndexOf("\nfetch_extension_source_assets\n");
    const listCatalog = source.indexOf(
      'bun "$packager" list-catalog --qualification-target "$target_id" >"$catalog_file"',
      fetch,
    );
    const releaseOnly = source.indexOf(
      'if [ "$qualification_only" = "0" ]; then',
      fetch,
    );
    const dispatch = source.indexOf('case "$target_id" in', releaseOnly);
    expect(fetch).toBeGreaterThan(-1);
    expect(listCatalog).toBeGreaterThan(fetch);
    expect(releaseOnly).toBeGreaterThan(listCatalog);
    expect(dispatch).toBeGreaterThan(releaseOnly);
    expect(source).toContain('catalog_file="$stage_root/extension-catalog.tsv"');
    expect(source.slice(releaseOnly, dispatch)).not.toContain("list-catalog");
    expect(source.slice(releaseOnly, dispatch)).toContain("write_indexes");

    const packager = await readFile(
      path.join(
        ROOT,
        "src/extensions/artifacts/native/tools/extension-artifact-packager.mjs",
      ),
      "utf8",
    );
    expect(packager).toContain(
      "qualificationCandidateSqlNamesForTarget(qualificationTarget, { family: 'native' })",
    );
    expect(packager).toMatch(
      /case 'list-catalog':\s+await listCatalog\(args\);/u,
    );
    expect(packager).toMatch(
      /copyRuntimeRelativeFile\(\s*args\.runtime,\s*filesRoot,\s*`lib\/postgresql\/\$\{metadata\.nativeModuleFile\}`\s*,?\s*\)/u,
    );
    const createArtifact = packager.slice(
      packager.indexOf("async function createArtifact"),
    );
    const firstStrip = createArtifact.indexOf("stripNativeReleaseBinaries(");
    const firstValidation = createArtifact.indexOf(
      "await validateExactArtifactBinaryContract(",
    );
    const secondStrip = createArtifact.indexOf(
      "stripNativeReleaseBinaries(",
      firstStrip + 1,
    );
    const secondValidation = createArtifact.indexOf(
      "await validateExactArtifactBinaryContract(",
      firstValidation + 1,
    );
    expect(firstValidation).toBeGreaterThan(firstStrip);
    expect(secondStrip).toBeGreaterThan(firstValidation);
    expect(secondValidation).toBeGreaterThan(secondStrip);

    const policy = JSON.parse(
      await readFile(
        path.join(ROOT, "tools/release/native-runtime-payload-policy.json"),
        "utf8",
      ),
    );
    expect(policy.devRuntimeSuffixes).toEqual(
      expect.arrayContaining([".a", ".la", ".pdb"]),
    );
    expect(policy.windowsDevRuntimeSuffixes).toContain(".lib");

    const project = Bun.YAML.parse(
      await readFile(
        path.join(ROOT, "src/extensions/artifacts/native/moon.yml"),
        "utf8",
      ),
    );
    for (const taskName of ["release-check", "build-target"]) {
      expect(project.tasks[taskName].inputs).toContain(
        "/tools/release/native-runtime-payload-policy.json",
      );
      expect(project.tasks[taskName].inputs).toContain(
        "/tools/release/windows-vc-runtime-closure.mjs",
      );
    }
  });
});
