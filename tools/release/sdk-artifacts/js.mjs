import path from "node:path";

import {
  assertSourceOnlyJsrDirectory,
  assertSourceOnlyNpmArchive,
  prepareSourceOnlyNpmPackage,
  SOURCE_ONLY_NPM_PROFILES,
} from "../source-only-sdk-package.mjs";
import {
  packageNpmWorkspace,
  stageJsrSourceWorkspace,
} from "./npm.mjs";
import { ROOT, requireDir } from "./shared.mjs";

export function stageArtifacts(artifactRoot) {
  const packageShapeDir = path.join(ROOT, "target/liboliphaunt-sdk-check/oliphaunt-js/package-shape/src/sdks/js");
  requireDir(packageShapeDir);
  prepareSourceOnlyNpmPackage(packageShapeDir, SOURCE_ONLY_NPM_PROFILES.js);
  const archive = packageNpmWorkspace(packageShapeDir, artifactRoot);
  assertSourceOnlyNpmArchive(archive, SOURCE_ONLY_NPM_PROFILES.js);
  const jsrSource = path.join(artifactRoot, "jsr-source");
  stageJsrSourceWorkspace(packageShapeDir, jsrSource);
  assertSourceOnlyJsrDirectory(jsrSource);
}
