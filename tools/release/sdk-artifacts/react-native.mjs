import {
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

export function stageArtifacts(artifactRoot) {
  const packageShapeDir = path.join(ROOT, "target/liboliphaunt-sdk-check/oliphaunt-react-native/package-shape/src/sdks/react-native");
  requireDir(packageShapeDir);
  const assetDir = process.env.OLIPHAUNT_REACT_NATIVE_IOS_RELEASE_ASSET_DIR;
  if (!assetDir) {
    fail("oliphaunt-react-native package artifacts require OLIPHAUNT_REACT_NATIVE_IOS_RELEASE_ASSET_DIR");
  }
  const carrier = buildIosCarrierManifest({
    baseAssetDir: assetDir,
    extensionManifests: [],
  });
  writeFileSync(
    path.join(packageShapeDir, IOS_CARRIER_FILENAME),
    `${JSON.stringify(carrier, null, 2)}\n`,
    "utf8",
  );
  const packageJsonFile = path.join(packageShapeDir, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonFile, "utf8"));
  packageJson.oliphaunt = {
    ...(packageJson.oliphaunt ?? {}),
    iosCarrierManifest: `./${IOS_CARRIER_FILENAME}`,
  };
  packageJson.files = [...new Set([...(packageJson.files ?? []), IOS_CARRIER_FILENAME])];
  packageJson.exports = {
    ".": {
      types: "./lib/typescript/index.d.ts",
      "react-native": "./lib/module/index.js",
      import: "./lib/module/index.js",
      require: "./lib/commonjs/index.js",
      default: "./lib/module/index.js",
    },
    "./ios-carriers": `./${IOS_CARRIER_FILENAME}`,
    "./package.json": "./package.json",
  };
  writeFileSync(packageJsonFile, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  requireCommand("node");
  run("node", [
    path.join(packageShapeDir, "tools/verify-ios-package.mjs"),
    "--package-dir",
    packageShapeDir,
  ], { label: "React Native source-only package verification" });
  prepareSourceOnlyNpmPackage(packageShapeDir, SOURCE_ONLY_NPM_PROFILES["react-native"]);
  const archive = packageNpmWorkspace(packageShapeDir, artifactRoot);
  assertSourceOnlyNpmArchive(archive, SOURCE_ONLY_NPM_PROFILES["react-native"]);
  const carrierEvidence = path.join(artifactRoot, "ios-carriers", IOS_CARRIER_FILENAME);
  mkdirSync(path.dirname(carrierEvidence), { recursive: true });
  writeFileSync(carrierEvidence, `${JSON.stringify(carrier, null, 2)}\n`, "utf8");
}
