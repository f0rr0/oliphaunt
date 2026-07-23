#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import {
  createPortablePathCollisionTracker,
  loadSwiftExtensionInventoryCatalog,
  readSafeFileSnapshot,
  validateSwiftExtensionResourceArtifact,
} from "./extension-resource-inventory.mjs";
import {
  publishCreateOnly,
  safeGeneratedOutput,
} from "./render-extension-products.mjs";

const sdk = path.resolve(import.meta.dirname, "..");
const root = path.resolve(process.argv[2] ?? path.join(sdk, ".build", "inventory-test"));
const fixtureFile = path.join(sdk, "Tests", "Fixtures", "swiftpm-extension-input.json");

async function main() {
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });

  const workspaceRoot = path.join(root, "workspace");
  const cacheRoot = path.join(root, "carrier-cache");
  await fs.mkdir(workspaceRoot);
  await fs.mkdir(cacheRoot);
  const allowedWorkspaceOutput = path.join(workspaceRoot, "generated-package");
  assert.equal(
    await safeGeneratedOutput(allowedWorkspaceOutput, [{
      label: "working directory",
      mode: "containment",
      path: workspaceRoot,
    }]),
    allowedWorkspaceOutput,
    "working-directory protection must allow a generated descendant",
  );
  await assert.rejects(
    () => safeGeneratedOutput(path.join(cacheRoot, "generated-package"), [{
      label: "carrier cache",
      mode: "disjoint",
      path: cacheRoot,
    }]),
    /overlaps protected carrier cache/u,
  );
  await assert.rejects(
    () => safeGeneratedOutput(root, [{
      label: "carrier cache",
      mode: "disjoint",
      path: cacheRoot,
    }]),
    /overlaps protected carrier cache/u,
  );

  const publicationStaging = path.join(root, ".publication-output.tmp-fixture");
  const publicationOutput = path.join(root, "publication-output");
  const completionMarker = ".oliphaunt-swiftpm-extension-products";
  await fs.mkdir(path.join(publicationStaging, "Sources"), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(publicationStaging, completionMarker), "completion marker\n"),
    fs.writeFile(path.join(publicationStaging, "Package.swift"), "package fixture\n"),
    fs.writeFile(path.join(publicationStaging, "extension-products.json"), "{}\n"),
  ]);
  const publicationEntries = [
    completionMarker,
    "Package.swift",
    "Sources",
    "extension-products.json",
  ];
  await assert.rejects(
    () => publishCreateOnly(
      publicationStaging,
      publicationOutput,
      publicationEntries,
      async () => {
        const conflictingSources = path.join(publicationOutput, "Sources");
        await fs.mkdir(conflictingSources);
        await fs.writeFile(path.join(conflictingSources, "do-not-delete.txt"), "same-user race\n");
      },
    ),
    /(?:directory not empty|file already exists|EEXIST|ENOTEMPTY)/iu,
  );
  assert.equal(
    await fs.lstat(path.join(publicationOutput, completionMarker)).catch(() => null),
    null,
    "a failed publication must not expose its completion marker",
  );
  assert.equal(
    await fs.readFile(path.join(publicationOutput, "Sources", "do-not-delete.txt"), "utf8"),
    "same-user race\n",
    "a conflicting nonempty publication entry must not be deleted",
  );
  assert.ok(
    (await fs.lstat(path.join(publicationStaging, completionMarker))).isFile(),
    "a failed publication must retain its completion marker in private staging",
  );

  const document = JSON.parse(await fs.readFile(fixtureFile, "utf8"));
  const catalog = await loadSwiftExtensionInventoryCatalog();
  const extensions = new Map();
  for (const row of document.extensions) {
    const resourceRoot = path.join(root, row.sqlName);
    await fs.cp(
      path.resolve(path.dirname(fixtureFile), row.resourceRoot),
      resourceRoot,
      { recursive: true },
    );
    const extension = { ...row, resourceRoot };
    extensions.set(row.sqlName, extension);
    await validateSwiftExtensionResourceArtifact({
      extension,
      canonical: catalog.get(row.sqlName),
      nativeRuntime: document.nativeRuntime,
      label: `legitimate ${row.sqlName} fixture`,
    });
  }

  const postgis = extensions.get("postgis");
  const postgisManifest = path.join(postgis.resourceRoot, "manifest.properties");
  const postgisManifestText = await fs.readFile(postgisManifest, "utf8");
  await assert.rejects(
    () => validateSwiftExtensionResourceArtifact({
      extension: postgis,
      canonical: catalog.get("postgis"),
      nativeRuntime: document.nativeRuntime,
      allowMobileCarrierArchives: true,
    }),
    /mobileStaticArchives must exactly cover/u,
    "carrier-resolved native artifacts must include both iOS static archives",
  );
  const mobileTargets = ["ios-device", "ios-simulator"];
  const mobileStaticArchives = mobileTargets.map(
    (target) =>
      `${target}:mobile-static/${target}/extensions/${postgis.nativeModuleStem}/` +
      `liboliphaunt_extension_${postgis.nativeModuleStem}.a`,
  );
  const mobileStaticDependencyArchives = mobileTargets.flatMap((target) =>
    postgis.nativeDependencies.map(
      ({ name }) =>
        `${target}:${name}:mobile-static/${target}/dependencies/${name}/lib${name}.a`,
    ));
  const productionPostgisManifest = postgisManifestText
    .replace(
      "mobileStaticArchives=\n",
      `mobileStaticArchives=${mobileStaticArchives.join(",")}\n`,
    )
    .replace(
      "mobileStaticDependencyArchives=\n",
      `mobileStaticDependencyArchives=${mobileStaticDependencyArchives.join(",")}\n`,
    );
  await fs.writeFile(postgisManifest, productionPostgisManifest);
  for (const row of [...mobileStaticArchives, ...mobileStaticDependencyArchives]) {
    const relative = row.slice(row.lastIndexOf(":") + 1);
    const archive = path.join(postgis.resourceRoot, ...relative.split("/"));
    await fs.mkdir(path.dirname(archive), { recursive: true });
    await fs.writeFile(archive, "production-shaped static archive\n");
  }
  await assert.rejects(
    () => validateSwiftExtensionResourceArtifact({
      extension: postgis,
      canonical: catalog.get("postgis"),
      nativeRuntime: document.nativeRuntime,
    }),
    /mobile static archives are only valid for carrier-resolved inputs/u,
  );
  const productionResources = await validateSwiftExtensionResourceArtifact({
    extension: postgis,
    canonical: catalog.get("postgis"),
    nativeRuntime: document.nativeRuntime,
    allowMobileCarrierArchives: true,
  });
  assert.ok(
    productionResources.files.every(({ relative }) => !relative.endsWith(".a")),
    "mobile static carrier inputs must not enter rendered Swift resources",
  );

  const wronglyOrderedDependencies = [...mobileStaticDependencyArchives].reverse();
  await fs.writeFile(
    postgisManifest,
    productionPostgisManifest.replace(
      mobileStaticDependencyArchives.join(","),
      wronglyOrderedDependencies.join(","),
    ),
  );
  await assert.rejects(
    () => validateSwiftExtensionResourceArtifact({
      extension: postgis,
      canonical: catalog.get("postgis"),
      nativeRuntime: document.nativeRuntime,
      allowMobileCarrierArchives: true,
    }),
    /must exactly cover both iOS targets and every native dependency/u,
  );

  await fs.writeFile(
    postgisManifest,
    productionPostgisManifest.replace(
      mobileStaticArchives.join(","),
      mobileStaticArchives[0],
    ),
  );
  await assert.rejects(
    () => validateSwiftExtensionResourceArtifact({
      extension: postgis,
      canonical: catalog.get("postgis"),
      nativeRuntime: document.nativeRuntime,
      allowMobileCarrierArchives: true,
    }),
    /mobileStaticArchives must exactly cover/u,
  );
  const simulatorDependency = mobileStaticDependencyArchives.find((row) =>
    row.startsWith("ios-simulator:"));
  assert.ok(simulatorDependency, "production fixture must include a simulator dependency archive");
  await fs.writeFile(
    postgisManifest,
    productionPostgisManifest.replace(
      simulatorDependency,
      simulatorDependency.replace(/libgeos\.a$/u, "libgeos_skew.a"),
    ),
  );
  await assert.rejects(
    () => validateSwiftExtensionResourceArtifact({
      extension: postgis,
      canonical: catalog.get("postgis"),
      nativeRuntime: document.nativeRuntime,
      allowMobileCarrierArchives: true,
    }),
    /same archive file name across both iOS targets/u,
  );
  await fs.writeFile(postgisManifest, productionPostgisManifest);
  const undeclaredStatic = path.join(
    postgis.resourceRoot,
    "mobile-static/ios-device/dependencies/geos/libundeclared.a",
  );
  await fs.writeFile(undeclaredStatic, "undeclared static archive\n");
  await assert.rejects(
    () => validateSwiftExtensionResourceArtifact({
      extension: postgis,
      canonical: catalog.get("postgis"),
      nativeRuntime: document.nativeRuntime,
      allowMobileCarrierArchives: true,
    }),
    /leaf inventory mismatch.*libundeclared\.a/u,
  );
  await fs.rm(undeclaredStatic);
  await fs.writeFile(postgisManifest, postgisManifestText);
  await fs.rm(path.join(postgis.resourceRoot, "mobile-static"), { recursive: true, force: true });

  const pgtap = extensions.get("pgtap");
  const pgtapManifest = path.join(pgtap.resourceRoot, "manifest.properties");
  const pgtapManifestText = await fs.readFile(pgtapManifest, "utf8");
  for (const [from, to, pattern] of [
    [
      "licenseProfile=external-native\n",
      "licenseProfile=contrib-native\n",
      /manifest licenseProfile must be/u,
    ],
    [
      "licenseFiles=share/licenses/pgtap/README.md\n",
      "licenseFiles=outside/licenses/pgtap/README.md\n",
      /manifest licenseFiles must live under share\/licenses/u,
    ],
    [
      "licenseProfile=external-native\n",
      "",
      /exact canonical fields/u,
    ],
  ]) {
    await fs.writeFile(pgtapManifest, pgtapManifestText.replace(from, to));
    await assert.rejects(
      () => validateSwiftExtensionResourceArtifact({
        extension: pgtap,
        canonical: catalog.get("pgtap"),
        nativeRuntime: document.nativeRuntime,
      }),
      pattern,
    );
  }
  await fs.writeFile(pgtapManifest, pgtapManifestText);
  const pgtapLicense = path.join(
    pgtap.resourceRoot,
    "files/share/licenses/pgtap/README.md",
  );
  const pgtapLicenseBytes = await fs.readFile(pgtapLicense);
  await fs.rm(pgtapLicense);
  await assert.rejects(
    () => validateSwiftExtensionResourceArtifact({
      extension: pgtap,
      canonical: catalog.get("pgtap"),
      nativeRuntime: document.nativeRuntime,
    }),
    /missing: files\/share\/licenses\/pgtap\/README\.md/u,
  );
  await fs.writeFile(pgtapLicense, pgtapLicenseBytes);
  const undeclaredLegalFile = path.join(
    pgtap.resourceRoot,
    "files/share/licenses/pgtap/UNDECLARED",
  );
  await fs.writeFile(undeclaredLegalFile, "undeclared legal fixture\n");
  await assert.rejects(
    () => validateSwiftExtensionResourceArtifact({
      extension: pgtap,
      canonical: catalog.get("pgtap"),
      nativeRuntime: document.nativeRuntime,
    }),
    /undeclared: files\/share\/licenses\/pgtap\/UNDECLARED/u,
  );
  await fs.rm(undeclaredLegalFile);
  for (const [from, to, pattern] of [
    [
      "extensionSqlFileNames=uninstall_pgtap.sql\n",
      "extensionSqlFileNames=foreign.sql\n",
      /manifest extensionSqlFileNames must be/u,
    ],
    [
      "extensionSqlFilePrefixes=pgtap-core,pgtap-schema\n",
      "extensionSqlFilePrefixes=foreign-prefix\n",
      /manifest extensionSqlFilePrefixes must be/u,
    ],
    [
      "extensionSqlFileNames=uninstall_pgtap.sql\n",
      "",
      /exact canonical fields/u,
    ],
  ]) {
    await fs.writeFile(pgtapManifest, pgtapManifestText.replace(from, to));
    await assert.rejects(
      () => validateSwiftExtensionResourceArtifact({
        extension: pgtap,
        canonical: catalog.get("pgtap"),
        nativeRuntime: document.nativeRuntime,
      }),
      pattern,
    );
  }
  await fs.writeFile(pgtapManifest, pgtapManifestText);
  const extensionDirectory = path.join(
    pgtap.resourceRoot,
    "files/share/postgresql/extension",
  );
  const prefixedControl = path.join(extensionDirectory, "pgtap-core-evil.control");
  await fs.writeFile(prefixedControl, "undeclared\n");
  await assert.rejects(
    () => validateSwiftExtensionResourceArtifact({
      extension: pgtap,
      canonical: catalog.get("pgtap"),
      nativeRuntime: document.nativeRuntime,
    }),
    /undeclared extension SQL\/control file.*pgtap-core-evil\.control/u,
  );
  await fs.rm(prefixedControl);

  const foreign = path.join(extensionDirectory, "foreign.control");
  await fs.writeFile(foreign, "undeclared\n");
  await assert.rejects(
    () => validateSwiftExtensionResourceArtifact({
      extension: pgtap,
      canonical: catalog.get("pgtap"),
      nativeRuntime: document.nativeRuntime,
    }),
    /undeclared extension SQL\/control file.*foreign\.control/u,
  );
  await fs.rm(foreign);

  const pgtapInstall = path.join(extensionDirectory, "pgtap--1.3.5.sql");
  const pgtapInstallBytes = await fs.readFile(pgtapInstall);
  const pgtapTransition = path.join(extensionDirectory, "pgtap--1.3.4--1.3.5.sql");
  await fs.rm(pgtapInstall);
  await fs.writeFile(pgtapTransition, "owned transition is not a base install\n");
  await assert.rejects(
    () => validateSwiftExtensionResourceArtifact({
      extension: pgtap,
      canonical: catalog.get("pgtap"),
      nativeRuntime: document.nativeRuntime,
    }),
    /pgtap\.control and canonical base installation SQL/u,
  );
  await fs.rm(pgtapTransition);
  const pgtapLetterLeading = path.join(extensionDirectory, "pgtap--release.sql");
  await fs.writeFile(pgtapLetterLeading, "letter-leading version is not a base install\n");
  await assert.rejects(
    () => validateSwiftExtensionResourceArtifact({
      extension: pgtap,
      canonical: catalog.get("pgtap"),
      nativeRuntime: document.nativeRuntime,
    }),
    /pgtap\.control and canonical base installation SQL/u,
  );
  await fs.rm(pgtapLetterLeading);
  await fs.writeFile(pgtapInstall, pgtapInstallBytes);

  const cube = extensions.get("cube");
  const cubeControl = path.join(
    cube.resourceRoot,
    "files/share/postgresql/extension/cube.control",
  );
  for (const [label, paths] of [
    [
      "case collision",
      [
        "files/share/postgresql/extension/cube.control",
        "files/share/postgresql/extension/Cube.control",
      ],
    ],
    [
      "NFC collision",
      [
        "files/share/postgresql/extension/caf\u00e9.control",
        "files/share/postgresql/extension/cafe\u0301.control",
      ],
    ],
    [
      "multi-code-point case collision",
      [
        "files/share/postgresql/extension/stra\u00dfe.control",
        "files/share/postgresql/extension/STRASSE.control",
      ],
    ],
  ]) {
    const trackPortablePath = createPortablePathCollisionTracker(`synthetic ${label}`);
    trackPortablePath(paths[0]);
    assert.throws(
      () => trackPortablePath(paths[1]),
      /case\/NFC-colliding paths/u,
      `${label} policy must be testable without materializing aliases on the host filesystem`,
    );
  }

  const cubeControlBytes = await fs.readFile(cubeControl);
  const collision = path.join(path.dirname(cubeControl), "Cube.control");
  let collisionCreated = false;
  try {
    await fs.writeFile(collision, "collision\n", { flag: "wx" });
    collisionCreated = true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    assert.deepEqual(
      await fs.readFile(cubeControl),
      cubeControlBytes,
      "an aliased case-collision probe must not overwrite the canonical cube.control fixture",
    );
  }
  if (collisionCreated) {
    try {
      await assert.rejects(
        () => validateSwiftExtensionResourceArtifact({
          extension: cube,
          canonical: catalog.get("cube"),
          nativeRuntime: document.nativeRuntime,
        }),
        /case\/NFC-colliding paths/u,
      );
    } finally {
      await fs.rm(collision);
    }
  }
  assert.deepEqual(
    await fs.readFile(cubeControl),
    cubeControlBytes,
    "the physical collision probe must preserve the canonical cube.control fixture",
  );

  const validatedCube = await validateSwiftExtensionResourceArtifact({
    extension: cube,
    canonical: catalog.get("cube"),
    nativeRuntime: document.nativeRuntime,
  });
  const cubeControlSnapshot = validatedCube.files.find(
    ({ relative }) => relative === "extension/cube.control",
  );
  assert.ok(cubeControlSnapshot, "cube.control must be present in the validated resource snapshot");
  await fs.writeFile(cubeControl, "changed after validation\n");
  await assert.rejects(
    () => readSafeFileSnapshot(cubeControlSnapshot, "mutated cube.control"),
    /changed after validation/u,
  );
  await fs.writeFile(cubeControl, cubeControlBytes);

  const symlinkValidatedCube = await validateSwiftExtensionResourceArtifact({
    extension: cube,
    canonical: catalog.get("cube"),
    nativeRuntime: document.nativeRuntime,
  });
  const symlinkCubeControlSnapshot = symlinkValidatedCube.files.find(
    ({ relative }) => relative === "extension/cube.control",
  );
  const outsideResource = path.join(root, "outside-resource.txt");
  await fs.writeFile(outsideResource, "bytes that must never enter the generated package\n");
  await fs.rm(cubeControl);
  await fs.symlink(outsideResource, cubeControl);
  await assert.rejects(
    () => readSafeFileSnapshot(symlinkCubeControlSnapshot, "symlink-swapped cube.control"),
    /must remain a regular file and must not be a symlink/u,
  );
  await fs.rm(cubeControl);
  await fs.writeFile(cubeControl, cubeControlBytes);

  const injectedMobileArchive = path.join(
    cube.resourceRoot,
    "mobile-static/ios-device/extensions/cube/liboliphaunt_extension_cube.a",
  );
  await fs.mkdir(path.dirname(injectedMobileArchive), { recursive: true });
  await fs.writeFile(injectedMobileArchive, "undeclared mobile archive\n");
  await assert.rejects(
    () => validateSwiftExtensionResourceArtifact({
      extension: cube,
      canonical: catalog.get("cube"),
      nativeRuntime: document.nativeRuntime,
    }),
    /leaf inventory mismatch; undeclared: mobile-static\/ios-device/u,
  );
  await fs.rm(path.join(cube.resourceRoot, "mobile-static"), { recursive: true, force: true });

  const manifest = path.join(cube.resourceRoot, "manifest.properties");
  const canonicalManifest = await fs.readFile(manifest);
  await fs.writeFile(manifest, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), canonicalManifest]));
  await assert.rejects(
    () => validateSwiftExtensionResourceArtifact({
      extension: cube,
      canonical: catalog.get("cube"),
      nativeRuntime: document.nativeRuntime,
    }),
    /canonical NFC UTF-8/u,
  );

  console.log("extension-resource-inventory.test.mjs: legitimate inventories and adversarial contamination checks passed");
}

main().catch((error) => {
  console.error(error.stack ?? String(error));
  process.exit(1);
});
