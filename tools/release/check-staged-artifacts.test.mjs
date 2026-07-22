import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { extensionReleasePropertiesText } from "./build-extension-ci-artifacts.mjs";
import { iosBaseLegalMetadata } from "./ios-carrier-manifest.mjs";
import {
  expectedExtensionBundleManifest,
  findSdkRuntimePayloadViolation,
  iosCocoaPodsExtensionLinkEvidence,
  iosPayloadCocoaPodsFileListPaths,
  parseUniquePropertiesText,
  validateReactNativePackagedCarrier,
  validateMobileExtensionManifestDomains,
  validatePackagedMobileRuntimeFiles,
  validateSwiftSourceFixtureEntries,
} from "./check-staged-artifacts.mjs";

const REPOSITORY_ROOT = path.join(
  import.meta.dir,
  "../../src/sdks/swift/Tests/Fixtures/swiftpm-extension-resources",
);
const ARCHIVE_ROOT = "package/Tests/Fixtures/swiftpm-extension-resources";
const REACT_NATIVE_METADATA = JSON.parse(readFileSync(path.join(
  import.meta.dir,
  "../../src/extensions/generated/sdk/react-native.json",
), "utf8"));
const MOBILE_STATIC_REGISTRY = JSON.parse(readFileSync(path.join(
  import.meta.dir,
  "../../src/extensions/generated/mobile/static-registry.json",
), "utf8"));
const EXPO_IOS_RUNNER = path.join(
  import.meta.dir,
  "../../src/sdks/react-native/tools/expo-ios-runner.sh",
);

function packagedMobileRuntimeNames(prefix, extensionAssets) {
  return extensionAssets.map(
    (name) => `${prefix}runtime/files/share/postgresql/extension/${name}`,
  );
}

test("staged iOS evidence and the Expo runner share the Payload CocoaPods file-list contract", () => {
  const scratchPath = path.join(path.sep, "candidate-scratch");
  const contract = iosPayloadCocoaPodsFileListPaths(scratchPath);
  assert.deepEqual(contract, {
    inputFile: path.join(
      scratchPath,
      "src/sdks/react-native/examples/expo/ios/Pods/Target Support Files/OliphauntReactNativePayload/OliphauntReactNativePayload-xcframeworks-input-files.xcfilelist",
    ),
    outputFile: path.join(
      scratchPath,
      "src/sdks/react-native/examples/expo/ios/Pods/Target Support Files/OliphauntReactNativePayload/OliphauntReactNativePayload-xcframeworks-output-files.xcfilelist",
    ),
    podName: "OliphauntReactNativePayload",
    supportRoot: path.join(
      scratchPath,
      "src/sdks/react-native/examples/expo/ios/Pods/Target Support Files/OliphauntReactNativePayload",
    ),
  });

  const runner = readFileSync(EXPO_IOS_RUNNER, "utf8");
  const validator = runner.match(
    /validate_ios_static_extension_linkage\(\) \{(?<body>[\s\S]*?)\n\}/u,
  )?.groups?.body;
  assert.ok(validator, "Expo iOS runner must define its static-extension linkage validator");
  assert.match(
    validator,
    /local pods_support="\$example_dir\/ios\/Pods\/Target Support Files\/OliphauntReactNativePayload"/u,
  );
  assert.match(
    validator,
    /local input_file="\$pods_support\/OliphauntReactNativePayload-xcframeworks-input-files\.xcfilelist"/u,
  );
  assert.match(
    validator,
    /local output_file="\$pods_support\/OliphauntReactNativePayload-xcframeworks-output-files\.xcfilelist"/u,
  );
});

test("matches CocoaPods iOS link inputs exactly for all generated extension identities", () => {
  assert.equal(REACT_NATIVE_METADATA.extensions.length, 39);
  const bySqlName = new Map(REACT_NATIVE_METADATA.extensions.map((row) => [
    row["sql-name"],
    row["native-module-stem"],
  ]));
  assert.equal(bySqlName.get("intarray"), "_int");
  assert.equal(bySqlName.get("pgtap"), null);
  assert.equal(bySqlName.get("postgis"), "postgis-3");
  assert.equal(bySqlName.get("uuid-ossp"), "uuid-ossp");

  const expectedStems = [...bySqlName.values()].filter((stem) => stem !== null).sort();
  assert.equal(expectedStems.length, 38);
  const evidence = iosCocoaPodsExtensionLinkEvidence({
    expectedStems,
    inputText: expectedStems.map(
      (stem) => `\${PODS_ROOT}/../oliphaunt/frameworks/extensions/liboliphaunt_extension_${stem}.xcframework`,
    ).join("\r\n"),
    outputText: expectedStems.map(
      (stem, index) => `\${PODS_XCFRAMEWORKS_BUILD_DIR}/OliphauntReactNativePayload/liboliphaunt_extension_${stem}${index === 0 ? ".framework" : ".a"}`,
    ).join("\n"),
  });
  const expectedArtifacts = expectedStems.map((stem) => `liboliphaunt_extension_${stem}`).sort();

  assert.deepEqual(evidence, {
    expectedArtifacts,
    inputArtifacts: expectedArtifacts,
    missingInput: [],
    missingOutput: [],
    outputArtifacts: expectedArtifacts,
    unexpectedInput: [],
    unexpectedOutput: [],
  });
});

test("does not let prefix collisions or free-text fragments satisfy iOS link identities", () => {
  const evidence = iosCocoaPodsExtensionLinkEvidence({
    expectedStems: ["postgis-3", "uuid-ossp"],
    inputText: [
      "note: liboliphaunt_extension_postgis-3.xcframework is not a path component",
      "${PODS_ROOT}/liboliphaunt_extension_postgis-30.xcframework",
      "${PODS_ROOT}/liboliphaunt_extension_uuid-ossp-extra.xcframework",
    ].join("\n"),
    outputText: [
      "${PODS_XCFRAMEWORKS_BUILD_DIR}/liboliphaunt_extension_postgis-30.a",
      "${PODS_XCFRAMEWORKS_BUILD_DIR}/liboliphaunt_extension_uuid-ossp-extra.a",
    ].join("\n"),
  });

  assert.deepEqual(evidence.missingInput, [
    "liboliphaunt_extension_postgis-3",
    "liboliphaunt_extension_uuid-ossp",
  ]);
  assert.deepEqual(evidence.unexpectedInput, [
    "liboliphaunt_extension_postgis-30",
    "liboliphaunt_extension_uuid-ossp-extra",
  ]);
  assert.deepEqual(evidence.missingOutput, evidence.missingInput);
  assert.deepEqual(evidence.unexpectedOutput, evidence.unexpectedInput);

  const inputOnly = iosCocoaPodsExtensionLinkEvidence({
    expectedStems: ["postgis-3"],
    inputText: "${PODS_ROOT}/liboliphaunt_extension_postgis-3.xcframework",
    outputText: "",
  });
  assert.deepEqual(inputOnly.missingInput, []);
  assert.deepEqual(inputOnly.missingOutput, ["liboliphaunt_extension_postgis-3"]);

  const outputOnly = iosCocoaPodsExtensionLinkEvidence({
    expectedStems: ["postgis-3"],
    inputText: "",
    outputText: "${PODS_XCFRAMEWORKS_BUILD_DIR}/liboliphaunt_extension_postgis-3.a",
  });
  assert.deepEqual(outputOnly.missingInput, ["liboliphaunt_extension_postgis-3"]);
  assert.deepEqual(outputOnly.missingOutput, []);

  assert.throws(
    () => iosCocoaPodsExtensionLinkEvidence({
      expectedStems: ["postgis-3"],
      inputText: "${PODS_ROOT}/liboliphaunt_extension_postgis-3.xcframework.attacker",
      outputText: "${PODS_XCFRAMEWORKS_BUILD_DIR}/liboliphaunt_extension_postgis-3.a",
    }),
    /unsupported Oliphaunt extension artifact component/u,
  );
  assert.throws(
    () => iosCocoaPodsExtensionLinkEvidence({
      expectedStems: ["postgis-3"],
      inputText: [
        "${PODS_ROOT}/liboliphaunt_extension_postgis-3.xcframework",
        "${PODS_ROOT}/liboliphaunt_extension_postgis-3.xcframework",
      ].join("\n"),
      outputText: "${PODS_XCFRAMEWORKS_BUILD_DIR}/liboliphaunt_extension_postgis-3.a",
    }),
    /input file list repeats Oliphaunt extension artifact/u,
  );
  assert.throws(
    () => iosCocoaPodsExtensionLinkEvidence({
      expectedStems: ["postgis-3"],
      inputText: "${PODS_ROOT}/liboliphaunt_extension_postgis-3.xcframework\0",
      outputText: "${PODS_XCFRAMEWORKS_BUILD_DIR}/liboliphaunt_extension_postgis-3.a",
    }),
    /input file list line 1 contains NUL/u,
  );
  assert.throws(
    () => iosCocoaPodsExtensionLinkEvidence({
      expectedStems: ["future-name", "future_name"],
      inputText: "",
      outputText: "",
    }),
    /collide after registration-symbol normalization/u,
  );
});

function selectionNeutralCarrier(version = "1.2.3") {
  const product = "liboliphaunt-native";
  const tag = `${product}-v${version}`;
  const assets = [
    ["base-xcframework", `liboliphaunt-${version}-apple-spm-xcframework.zip`, "zip", "liboliphaunt.xcframework", "a"],
    ["runtime-resources", `liboliphaunt-${version}-runtime-resources.tar.gz`, "tar.gz", "oliphaunt", "b"],
    ["icu-data", `liboliphaunt-${version}-icu-data.tar.gz`, "tar.gz", "share/icu", "c"],
  ].map(([role, name, format, member, digit], index) => ({
    bytes: index + 1,
    format,
    member,
    name,
    role,
    sha256: digit.repeat(64),
    url: `https://github.com/f0rr0/oliphaunt/releases/download/${tag}/${name}`,
  }));
  return {
    base: { assets, product, tag, version },
    carriers: [],
    extensions: [],
    legal: { base: iosBaseLegalMetadata(), extensions: [] },
    schema: "oliphaunt-react-native-ios-carrier-v1",
  };
}

function fixtureFiles(root = REPOSITORY_ROOT) {
  const files = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      if (statSync(file).isDirectory()) {
        visit(file);
      } else if (statSync(file).isFile()) {
        files.push(file);
      }
    }
  };
  visit(root);
  return files;
}

function repositoryFixtureEntries() {
  return new Map(fixtureFiles().map((file) => {
    const relative = path.relative(REPOSITORY_ROOT, file).split(path.sep).join("/");
    const bytes = readFileSync(file);
    return [
      `${ARCHIVE_ROOT}/${relative}`,
      { isFile: true, data: () => bytes },
    ];
  }));
}

test("permits only an exact byte-for-byte Swift extension-resource fixture mirror", () => {
  const entries = repositoryFixtureEntries();
  const allowed = validateSwiftSourceFixtureEntries("Oliphaunt-source.zip", entries);

  assert.deepEqual([...allowed].sort(), [...entries.keys()].sort());
  assert.equal(
    findSdkRuntimePayloadViolation("oliphaunt-swift", [...entries.keys()], allowed),
    null,
  );
});

test("rejects missing and extra Swift extension-resource fixture files", () => {
  const missing = repositoryFixtureEntries();
  missing.delete(missing.keys().next().value);
  assert.throws(
    () => validateSwiftSourceFixtureEntries("missing.zip", missing),
    /file set must exactly match.*missing=\["/u,
  );

  const extra = repositoryFixtureEntries();
  extra.set(`${ARCHIVE_ROOT}/unexpected/extra.control`, {
    isFile: true,
    data: () => Buffer.from("unexpected\n"),
  });
  assert.throws(
    () => validateSwiftSourceFixtureEntries("extra.zip", extra),
    /file set must exactly match.*extra=\["/u,
  );
});

test("rejects tampered Swift extension-resource fixture bytes", () => {
  const entries = repositoryFixtureEntries();
  const [name, entry] = entries.entries().next().value;
  entries.set(name, {
    ...entry,
    data: () => Buffer.concat([Buffer.from(entry.data()), Buffer.from("tampered")]),
  });

  assert.throws(
    () => validateSwiftSourceFixtureEntries("tampered.zip", entries),
    /must byte-for-byte match/u,
  );
});

test("continues to reject runtime payloads outside the exact fixture subtree", () => {
  const entries = repositoryFixtureEntries();
  const allowed = validateSwiftSourceFixtureEntries("Oliphaunt-source.zip", entries);
  const outsideFixture =
    "package/Sources/Oliphaunt/Resources/runtime/files/share/postgresql/extension/pgtap.control";

  assert.equal(
    findSdkRuntimePayloadViolation(
      "oliphaunt-swift",
      [...entries.keys(), outsideFixture],
      allowed,
    ),
    outsideFixture,
  );
});

test("mobile artifact gate uses generated ownership for ancillary extension SQL", () => {
  for (const [platform, prefix] of [
    ["Android", "assets/oliphaunt/"],
    ["iOS", "OliphauntReactNativeResources.bundle/oliphaunt/"],
  ]) {
    const artifactNames = packagedMobileRuntimeNames(prefix, [
      "pgtap.control",
      "pgtap--1.3.5.sql",
      "pgtap-core--1.3.5.sql",
      "pgtap-schema.sql",
      "uninstall_pgtap.sql",
      "plpgsql.control",
      "plpgsql--1.0.sql",
    ]);

    assert.doesNotThrow(() => validatePackagedMobileRuntimeFiles({
      artifactNames,
      metadata: REACT_NATIVE_METADATA,
      platform,
      prefix,
      registry: MOBILE_STATIC_REGISTRY,
      selected: ["pgtap"],
    }));
    assert.throws(
      () => validatePackagedMobileRuntimeFiles({
        artifactNames,
        metadata: REACT_NATIVE_METADATA,
        platform,
        prefix,
        registry: MOBILE_STATIC_REGISTRY,
        selected: [],
      }),
      /unselected PostgreSQL extension asset/u,
    );
  }
});

test("mobile manifests keep full, createable, and native extension domains distinct", () => {
  const rows = new Map([
    ["auto_explain", {
      "creates-extension": false,
      "native-module-stem": "auto_explain",
      "sql-name": "auto_explain",
    }],
    ["future_hook", {
      "creates-extension": false,
      "native-module-stem": "-",
      "sql-name": "future_hook",
    }],
    ["pgtap", {
      "creates-extension": true,
      "native-module-stem": "-",
      "sql-name": "pgtap",
    }],
  ]);
  const runtime = {
    extensions: "pgtap",
    mobileStaticRegistryRegistered: "auto_explain",
    mobileStaticRegistryPending: "",
    mobileStaticRegistryState: "complete",
    nativeModuleStems: "auto_explain",
    selectedExtensions: "auto_explain,future_hook,pgtap",
  };
  const staticRegistry = {
    modules: "auto_explain",
    nativeModuleStems: "auto_explain",
    pendingExtensions: "",
    registeredExtensions: "auto_explain",
    state: "complete",
  };

  assert.deepEqual(
    validateMobileExtensionManifestDomains({ runtime, staticRegistry, rows }),
    {
      createableExtensions: ["pgtap"],
      nativeExtensions: ["auto_explain"],
      nativeModuleStems: ["auto_explain"],
      selectedExtensions: ["auto_explain", "future_hook", "pgtap"],
    },
  );
  assert.throws(
    () => validateMobileExtensionManifestDomains({
      runtime: Object.fromEntries(
        Object.entries(runtime).filter(([key]) => key !== "selectedExtensions"),
      ),
      staticRegistry,
      rows,
    }),
    /must define the full selectedExtensions domain/u,
  );
  assert.throws(
    () => validateMobileExtensionManifestDomains({
      runtime: { ...runtime, extensions: "auto_explain,pgtap" },
      staticRegistry,
      rows,
    }),
    /createable extensions/u,
  );
  assert.throws(
    () => validateMobileExtensionManifestDomains({
      runtime: { ...runtime, mobileStaticRegistryRegistered: "pgtap" },
      staticRegistry,
      rows,
    }),
    /registered native extensions/u,
  );
  assert.throws(
    () => validateMobileExtensionManifestDomains({
      runtime: { ...runtime, mobileStaticRegistryState: "not-required" },
      staticRegistry,
      rows,
    }),
    /mobileStaticRegistryState/u,
  );
  assert.throws(
    () => validateMobileExtensionManifestDomains({
      runtime,
      staticRegistry: { ...staticRegistry, modules: "" },
      rows,
    }),
    /static-registry modules/u,
  );
});

test("binds the React Native npm carrier bytes to selection-neutral staged evidence", () => {
  const member = "package/oliphaunt-react-native-ios-carriers.json";
  const bytes = Buffer.from(`${JSON.stringify(selectionNeutralCarrier(), null, 2)}\n`);
  assert.deepEqual(
    validateReactNativePackagedCarrier({
      artifact: "oliphaunt-react-native.tgz",
      evidence: bytes,
      expectedNativeVersion: "1.2.3",
      memberBytes: bytes,
      names: [member],
    }),
    selectionNeutralCarrier(),
  );

  assert.throws(
    () => validateReactNativePackagedCarrier({
      artifact: "missing.tgz",
      evidence: bytes,
      expectedNativeVersion: "1.2.3",
      memberBytes: Buffer.alloc(0),
      names: [],
    }),
    /must contain exactly one/u,
  );
  assert.throws(
    () => validateReactNativePackagedCarrier({
      artifact: "skewed.tgz",
      evidence: bytes,
      expectedNativeVersion: "1.2.3",
      memberBytes: Buffer.from(`${JSON.stringify(selectionNeutralCarrier("1.2.4"))}\n`),
      names: [member],
    }),
    /byte-for-byte match/u,
  );
  assert.throws(
    () => validateReactNativePackagedCarrier({
      artifact: "wrong-version.tgz",
      evidence: Buffer.from(`${JSON.stringify(selectionNeutralCarrier("1.2.4"))}\n`),
      expectedNativeVersion: "1.2.3",
      memberBytes: Buffer.from(`${JSON.stringify(selectionNeutralCarrier("1.2.4"))}\n`),
      names: [member],
    }),
    /must match liboliphaunt-native 1\.2\.3/u,
  );
});

test("derives nested bundle compatibility from the staged bundle data", () => {
  const compatibility = {
    nativeRuntimeProduct: "liboliphaunt-native",
    nativeRuntimeVersion: "1.2.3",
    postgresMajor: "18",
  };
  const carrier = {
    family: "native",
    target: "android-arm64-v8a",
  };
  const rows = [{
    member: { sqlName: "cube" },
    asset: {
      bytes: 123,
      identity: null,
      kind: "runtime",
      memberPath: "extensions/cube/cube.tar.gz",
      sha256: "a".repeat(64),
    },
  }];

  assert.deepEqual(
    expectedExtensionBundleManifest({
      product: "oliphaunt-extension-contrib-pg18",
      version: "1.0.0",
      data: { compatibility },
      carrier,
      rows,
    }),
    {
      schema: "oliphaunt-extension-bundle-v1",
      product: "oliphaunt-extension-contrib-pg18",
      version: "1.0.0",
      compatibility,
      family: "native",
      target: "android-arm64-v8a",
      licenseProfile: "contrib-native",
      licenseFiles: [],
      members: [{
        sqlName: "cube",
        kind: "runtime",
        identity: null,
        path: "extensions/cube/cube.tar.gz",
        sha256: "a".repeat(64),
        bytes: 123,
      }],
    },
  );
});

test("renders every single-extension asset identity into the public properties manifest", () => {
  const dependencyIdentities = ["geos", "geos-c", "json-c", "libxml2", "proj", "sqlite"];
  const assets = [
    ...dependencyIdentities.map((identity) => ({
      family: "native",
      target: "ios-xcframework",
      kind: "ios-dependency-xcframework",
      identity,
      name: `postgis-${identity}.zip`,
    })),
    {
      family: "native",
      target: "ios-xcframework",
      kind: "ios-xcframework",
      identity: "postgis-3",
      name: "postgis.zip",
    },
    {
      family: "native",
      target: "ios-xcframework",
      kind: "runtime",
      identity: null,
      name: "postgis-runtime.tar.gz",
    },
  ];
  const text = extensionReleasePropertiesText({
    product: "oliphaunt-extension-postgis",
    version: "1.0.0",
    manifest: {
      schema: "oliphaunt-extension-ci-artifacts-v1",
      sqlName: "postgis",
      createsExtension: true,
      dependencies: [],
      dataFiles: ["contrib/postgis-3.6/postgis.sql", "proj/proj.db"],
      extensionSqlFileNames: ["uninstall_postgis.sql"],
      extensionSqlFilePrefixes: ["postgis_comments", "rtpostgis"],
      nativeDependencies: [],
      nativeModuleStem: "postgis-3",
      iosNativeDependencies: dependencyIdentities,
      sharedPreloadLibraries: [],
      mobileReleaseReady: true,
      desktopReleaseReady: true,
      assets,
    },
    releaseData: {
      schema: "oliphaunt-extension-release-manifest-v1",
      extensionClass: "external",
      versioning: "independent",
      sourceIdentity: { kind: "git" },
    },
    directAssets: assets,
  });
  const assetLines = text.split("\n").filter((line) => line.startsWith("asset."));

  assert.deepEqual(assetLines, [
    "asset.native.ios-xcframework.ios-dependency-xcframework.geos=postgis-geos.zip",
    "asset.native.ios-xcframework.ios-dependency-xcframework.geos-c=postgis-geos-c.zip",
    "asset.native.ios-xcframework.ios-dependency-xcframework.json-c=postgis-json-c.zip",
    "asset.native.ios-xcframework.ios-dependency-xcframework.libxml2=postgis-libxml2.zip",
    "asset.native.ios-xcframework.ios-dependency-xcframework.proj=postgis-proj.zip",
    "asset.native.ios-xcframework.ios-dependency-xcframework.sqlite=postgis-sqlite.zip",
    "asset.native.ios-xcframework.ios-xcframework.postgis-3=postgis.zip",
    "asset.native.ios-xcframework.runtime=postgis-runtime.tar.gz",
  ]);
  assert.equal(
    Object.keys(parseUniquePropertiesText(text)).filter((key) => key.startsWith("asset.")).length,
    8,
  );
  const properties = parseUniquePropertiesText(text);
  assert.equal(properties.createsExtension, "true");
  assert.equal(properties.dataFiles, "contrib/postgis-3.6/postgis.sql,proj/proj.db");
  assert.equal(properties.extensionSqlFileNames, "uninstall_postgis.sql");
  assert.equal(properties.extensionSqlFilePrefixes, "postgis_comments,rtpostgis");
  assert.doesNotMatch(text, /^carrier\./mu);
});

test("freezes each bundle member desktop inventory in the public properties manifest", () => {
  const text = extensionReleasePropertiesText({
    product: "oliphaunt-extension-contrib-pg18",
    version: "1.0.0",
    manifest: {
      schema: "oliphaunt-extension-ci-artifacts-v2",
      extensions: [{
        sqlName: "pgtap",
        createsExtension: true,
        dependencies: [],
        dataFiles: [],
        extensionSqlFileNames: ["uninstall_pgtap.sql"],
        extensionSqlFilePrefixes: ["pgtap-core", "pgtap-schema"],
        nativeDependencies: [],
        nativeModuleStem: null,
        iosNativeDependencies: [],
        sharedPreloadLibraries: [],
        mobileReleaseReady: true,
        desktopReleaseReady: true,
        assets: [],
      }],
    },
    releaseData: {
      schema: "oliphaunt-extension-release-manifest-v2",
      extensionClass: "contrib",
      versioning: "coordinated",
      sourceIdentity: { kind: "repository" },
    },
    directAssets: [],
  });
  const properties = parseUniquePropertiesText(text);

  assert.equal(properties["extension.pgtap.createsExtension"], "true");
  assert.equal(properties["extension.pgtap.dataFiles"], "");
  assert.equal(properties["extension.pgtap.extensionSqlFileNames"], "uninstall_pgtap.sql");
  assert.equal(properties["extension.pgtap.extensionSqlFilePrefixes"], "pgtap-core,pgtap-schema");
});

test("preserves hostile property names and rejects repeated keys", () => {
  const hostile = parseUniquePropertiesText("__proto__=undeclared\n");
  assert.equal(Object.hasOwn(hostile, "__proto__"), true);
  assert.equal(hostile.__proto__, "undeclared");
  assert.throws(
    () => parseUniquePropertiesText("asset.native.ios-xcframework.runtime=first.tar.gz\nasset.native.ios-xcframework.runtime=second.tar.gz\n"),
    /repeats key "asset\.native\.ios-xcframework\.runtime"/u,
  );
  assert.throws(
    () => parseUniquePropertiesText("asset.native.ios-xcframework.ios-dependency-xcframework=geos.zip\nasset.native.ios-xcframework.ios-dependency-xcframework=geos-c.zip\n"),
    /repeats key "asset\.native\.ios-xcframework\.ios-dependency-xcframework"/u,
  );
  assert.throws(
    () => parseUniquePropertiesText("__proto__=first\n__proto__=second\n"),
    /repeats key "__proto__"/u,
  );
});
