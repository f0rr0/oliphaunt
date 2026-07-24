import { copyFileSync } from "node:fs";
import path from "node:path";

import {
  BUN,
  ROOT,
  requireCommand,
  requireFile,
  run,
} from "./shared.mjs";

export function stageArtifacts(artifactRoot) {
  requireCommand("cargo");
  const packageListing = path.join(ROOT, "target/oliphaunt-wasix-rust/package/oliphaunt-wasix.package-files.txt");
  requireFile(packageListing);
  run(BUN, ["tools/release/package_oliphaunt_wasix_sdk_crate.mjs", "--output-dir", artifactRoot], {
    label: "package oliphaunt-wasix SDK crate",
  });
  copyFileSync(packageListing, path.join(artifactRoot, "cargo-package-files.txt"));
}
