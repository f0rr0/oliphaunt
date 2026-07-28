import { copyFileSync } from "node:fs";
import path from "node:path";

import { manualCargoPackageSource } from "../cargo-source-package.mjs";
import {
  prepareOliphauntBuildReleaseSource,
  prepareRustReleaseSource,
} from "../prepare-rust-release-source.mjs";
import { assertReleaseNoticesInArchive } from "../release-notices.mjs";
import {
  ROOT,
  fail,
  rel,
  requireCommand,
  requireFile,
} from "./shared.mjs";

export function stageArtifacts(artifactRoot, workRoot) {
  requireCommand("cargo");
  const packageListing = path.join(ROOT, "target/liboliphaunt-sdk-check/rust-cargo-package-list.txt");
  requireFile(packageListing);

  const releaseManifest = prepareRustReleaseSource({
    stageDir: path.join(workRoot, "oliphaunt-release-source"),
    log: false,
  });
  const releaseCrate = manualCargoPackageSource(
    releaseManifest,
    path.join(workRoot, "oliphaunt-release-crate"),
    { root: ROOT, fail, rel },
  );
  requireFile(releaseCrate);
  assertReleaseNoticesInArchive(releaseCrate, {
    profile: "source-sdk",
    prefix: path.basename(releaseCrate, ".crate"),
  });
  copyFileSync(releaseCrate, path.join(artifactRoot, path.basename(releaseCrate)));

  const buildManifest = prepareOliphauntBuildReleaseSource({
    stageDir: path.join(workRoot, "oliphaunt-build-release-source"),
    log: false,
  });
  const buildCrate = manualCargoPackageSource(
    buildManifest,
    path.join(workRoot, "oliphaunt-build-release-crate"),
    { root: ROOT, fail, rel },
  );
  requireFile(buildCrate);
  assertReleaseNoticesInArchive(buildCrate, {
    profile: "source-sdk",
    prefix: path.basename(buildCrate, ".crate"),
  });
  copyFileSync(buildCrate, path.join(artifactRoot, path.basename(buildCrate)));
  copyFileSync(packageListing, path.join(artifactRoot, "cargo-package-files.txt"));
}
