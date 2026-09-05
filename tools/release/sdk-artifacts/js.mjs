import { cpSync } from "node:fs";
import path from "node:path";

import {
  assertSourceOnlyNpmArchive,
  prepareSourceOnlyNpmPackage,
  SOURCE_ONLY_NPM_PROFILES,
} from "../source-only-sdk-package.mjs";
import { packageNpmWorkspace } from "./npm.mjs";
import { ROOT, requireDir } from "./shared.mjs";

export function stageArtifacts(artifactRoot, workRoot) {
  const packageShapeDir = path.join(ROOT, "target/liboliphaunt-sdk-check/oliphaunt-js/package-shape/src/sdks/js");
  requireDir(packageShapeDir);
  const releasePackageDir = path.join(workRoot, "package");
  cpSync(packageShapeDir, releasePackageDir, { recursive: true });
  prepareSourceOnlyNpmPackage(releasePackageDir, SOURCE_ONLY_NPM_PROFILES.js);
  const archive = packageNpmWorkspace(releasePackageDir, artifactRoot);
  assertSourceOnlyNpmArchive(archive, SOURCE_ONLY_NPM_PROFILES.js);
}
