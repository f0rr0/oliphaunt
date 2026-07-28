#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { discoverExtensionManifests } from "./extension-registry-carrier-materializer.mjs";

const TOOL = "extension-manifest-discovery-proof.mjs";
export const WINDOWS_STANDARD_USER_EXTENSION_DISCOVERY_PROOF =
  "OLIPHAUNT_WINDOWS_STANDARD_USER_EXTENSION_DISCOVERY_OK";

function fail(message) {
  throw new Error(`${TOOL}: ${message}`);
}

export function proveWindowsStandardUserExtensionDiscovery({
  root,
  expectedManifest,
  expectedSha256,
}) {
  if (
    typeof root !== "string"
    || typeof expectedManifest !== "string"
    || typeof expectedSha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(expectedSha256)
  ) {
    fail("Windows standard-user discovery proof arguments are malformed");
  }
  const absoluteRoot = path.resolve(root);
  const resolvedRoot = realpathSync(absoluteRoot);
  const resolvedExpectedManifest = realpathSync(path.resolve(expectedManifest));
  if (!statSync(resolvedRoot).isDirectory()) {
    fail("Windows standard-user discovery proof root is not a directory");
  }
  if (
    path.basename(resolvedExpectedManifest) !== "extension-artifacts.json"
    || !statSync(resolvedExpectedManifest).isFile()
  ) {
    fail("Windows standard-user discovery proof expected path is not an extension manifest");
  }
  const relativeExpected = path.relative(resolvedRoot, resolvedExpectedManifest);
  if (
    relativeExpected === ""
    || relativeExpected === ".."
    || relativeExpected.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeExpected)
  ) {
    fail("Windows standard-user discovery proof expected manifest escaped its root");
  }

  // Preserve the caller-supplied root for discovery so the production scanner
  // exercises and enforces its top-level symlink/junction rejection. Compare
  // canonical paths only after discovery to tolerate Windows path aliases.
  const discovered = discoverExtensionManifests([absoluteRoot]).map((manifest) =>
    realpathSync(manifest)
  );
  if (
    discovered.length !== 1
    || discovered[0] !== resolvedExpectedManifest
  ) {
    fail("Windows standard-user discovery proof did not find exactly the expected nested manifest");
  }
  const observedSha256 = createHash("sha256")
    .update(readFileSync(resolvedExpectedManifest))
    .digest("hex");
  if (observedSha256 !== expectedSha256) {
    fail("Windows standard-user discovery proof manifest digest disagrees with its contract");
  }
  return Object.freeze({
    manifest: resolvedExpectedManifest,
    relativeManifest: relativeExpected.split(path.sep).join("/"),
    sha256: observedSha256,
  });
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (
      args.length !== 4
      || args[0] !== "--windows-standard-user-discovery-proof"
    ) {
      fail("unsupported direct invocation");
    }
    const proof = proveWindowsStandardUserExtensionDiscovery({
      root: args[1],
      expectedManifest: args[2],
      expectedSha256: args[3],
    });
    process.stdout.write(
      `${WINDOWS_STANDARD_USER_EXTENSION_DISCOVERY_PROOF}`
        + `\t${proof.relativeManifest}\t${proof.sha256}\n`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
