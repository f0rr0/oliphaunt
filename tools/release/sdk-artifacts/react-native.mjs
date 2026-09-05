import {
  cpSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  IOS_CARRIER_FILENAME,
  buildIosCarrierManifest,
} from "../ios-carrier-manifest.mjs";
import {
  assertSourceOnlyNpmArchive,
  prepareSourceOnlyNpmPackage,
  SOURCE_ONLY_NPM_PROFILES,
} from "../source-only-sdk-package.mjs";
import { packageNpmWorkspace } from "./npm.mjs";
import {
  ROOT,
  fail,
  requireCommand,
  requireDir,
  run,
} from "./shared.mjs";

export function stageArtifacts(artifactRoot, workRoot) {
  const packageShapeDir = path.join(ROOT, "target/liboliphaunt-sdk-check/oliphaunt-react-native/package-shape/src/sdks/react-native");
  requireDir(packageShapeDir);
  const releasePackageDir = path.join(workRoot, "package");
  cpSync(packageShapeDir, releasePackageDir, { recursive: true });
  const assetDir = process.env.OLIPHAUNT_REACT_NATIVE_IOS_RELEASE_ASSET_DIR;
  if (!assetDir) {
    fail("oliphaunt-react-native package artifacts require OLIPHAUNT_REACT_NATIVE_IOS_RELEASE_ASSET_DIR");
  }
  const carrier = buildIosCarrierManifest({
    baseAssetDir: assetDir,
    extensionManifests: [],
  });
  writeFileSync(
    path.join(releasePackageDir, IOS_CARRIER_FILENAME),
    `${JSON.stringify(carrier, null, 2)}\n`,
    "utf8",
  );
  const packageJsonFile = path.join(releasePackageDir, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonFile, "utf8"));
  packageJson.oliphaunt = {
    ...(packageJson.oliphaunt ?? {}),
    iosCarrierManifest: `./${IOS_CARRIER_FILENAME}`,
  };
  packageJson.files = [...new Set([...(packageJson.files ?? []), IOS_CARRIER_FILENAME])];
  packageJson.exports = {
    ...(packageJson.exports ?? {}),
    "./ios-carriers": `./${IOS_CARRIER_FILENAME}`,
  };
  writeFileSync(packageJsonFile, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  requireCommand("node");
  run("node", [
    path.join(releasePackageDir, "tools/verify-ios-package.mjs"),
    "--package-dir",
    releasePackageDir,
  ], { label: "React Native source-only package verification" });
  prepareSourceOnlyNpmPackage(releasePackageDir, SOURCE_ONLY_NPM_PROFILES["react-native"]);
  const archive = packageNpmWorkspace(releasePackageDir, artifactRoot);
  assertSourceOnlyNpmArchive(archive, SOURCE_ONLY_NPM_PROFILES["react-native"]);
  run("node", [
    path.join(ROOT, "src/sdks/react-native/tools/ios-icu-autolinking.test.mjs"),
    "--react-native-tarball",
    archive,
    "--icu-source",
    path.join(ROOT, "src/runtimes/liboliphaunt/native/icu-npm"),
    "--expo-project",
    path.join(ROOT, "examples/react-native-expo"),
  ], { label: "React Native and ICU autolinking contract" });
  const carrierEvidence = path.join(artifactRoot, "ios-carriers", IOS_CARRIER_FILENAME);
  mkdirSync(path.dirname(carrierEvidence), { recursive: true });
  writeFileSync(carrierEvidence, `${JSON.stringify(carrier, null, 2)}\n`, "utf8");
}
