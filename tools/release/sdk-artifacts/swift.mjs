import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  IOS_CARRIER_FILENAME,
  buildIosCarrierManifest,
} from "../ios-carrier-manifest.mjs";
import {
  assertReleaseNoticesInArchive,
  assertReleaseNoticesInDirectory,
  stageReleaseNotices,
} from "../release-notices.mjs";
import { currentProductVersionSync } from "../release-artifact-targets.mjs";
import { validateSwiftSourceReleaseContract } from "../swift-source-carrier-contract.mjs";
import {
  BUN,
  ROOT,
  copyDirContents,
  fail,
  rel,
  requireCommand,
  requireFile,
  run,
} from "./shared.mjs";

const PREFIX = "build-sdk-ci-artifacts.mjs";

export function stageArtifacts(artifactRoot, workRoot) {
  requireCommand("swift");
  const swiftSourceArchive = path.join(
    ROOT,
    "target/liboliphaunt-sdk-check/oliphaunt-swift/package-shape/swift-source-archive/Oliphaunt-source.zip",
  );
  requireFile(swiftSourceArchive);
  const stagedSourceArchive = path.join(artifactRoot, "Oliphaunt-source.zip");
  copyFileSync(swiftSourceArchive, stagedSourceArchive);
  assertReleaseNoticesInArchive(stagedSourceArchive, { prefix: "package" });
  const assetDir = process.env.OLIPHAUNT_SWIFT_RELEASE_ASSET_DIR;
  if (!assetDir) {
    fail("oliphaunt-swift package artifacts require OLIPHAUNT_SWIFT_RELEASE_ASSET_DIR");
  }
  run(BUN, [
    "tools/release/render_swiftpm_release_package.mjs",
    "--asset-dir",
    assetDir,
    "--output",
    path.join(artifactRoot, "Package.swift.release"),
    "--generated-tree",
    path.join(workRoot, "swiftpm-release-tree"),
  ], { label: "render SwiftPM release package" });
  const releaseTree = path.join(artifactRoot, "release-tree");
  rmSync(releaseTree, { recursive: true, force: true });
  copyDirContents(path.join(workRoot, "swiftpm-release-tree"), releaseTree);
  stageReleaseNotices(releaseTree);
  assertReleaseNoticesInDirectory(releaseTree);
  const carrier = buildIosCarrierManifest({
    baseAssetDir: assetDir,
    extensionManifests: [],
  });
  const carrierFile = path.join(
    releaseTree,
    "src/sdks/swift/Carriers",
    IOS_CARRIER_FILENAME,
  );
  mkdirSync(path.dirname(carrierFile), { recursive: true });
  writeFileSync(carrierFile, `${JSON.stringify(carrier, null, 2)}\n`, "utf8");
  const manifest = readFileSync(path.join(artifactRoot, "Package.swift.release"), "utf8");
  try {
    validateSwiftSourceReleaseContract({
      carrier,
      expectedNativeVersion: currentProductVersionSync("liboliphaunt-native", PREFIX),
      label: `${rel(artifactRoot)} source release`,
      manifestText: manifest,
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  for (const fragment of [
    "liboliphaunt-native-v",
    '.library(name: "COliphaunt"',
    '.library(name: "OliphauntExtensionSupport"',
    'path: "src/sdks/swift/Sources/OliphauntExtensionSupport"',
  ]) {
    if (!manifest.includes(fragment)) {
      fail(`staged SwiftPM release manifest is missing ${JSON.stringify(fragment)}`);
    }
  }
  if (manifest.includes("file://")) {
    fail("staged SwiftPM release manifest must not contain local file URLs");
  }
  const generatorRoot = path.join(artifactRoot, "extension-generator");
  mkdirSync(generatorRoot, { recursive: true });
  for (const name of [
    "extension-resource-inventory.mjs",
    "render-extension-products.mjs",
    "swift-carrier-resolver.mjs",
    "swiftpm-extension-input.schema.json",
  ]) {
    copyFileSync(
      path.join(ROOT, "src/sdks/swift/tools", name),
      path.join(generatorRoot, name),
    );
  }
  copyFileSync(
    path.join(ROOT, "src/extensions/generated/sdk/swift.json"),
    path.join(generatorRoot, "extension-owner-catalog.json"),
  );
}
