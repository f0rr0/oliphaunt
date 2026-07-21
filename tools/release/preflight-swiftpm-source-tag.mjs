#!/usr/bin/env bun
import path from "node:path";

import {
  assertPublicationLockSource,
  loadPublicationLock,
  lockedProductArtifactPaths,
} from "./publication-lock.mjs";
import { ensureTag } from "./publish_swiftpm_source_tag.mjs";

function error(message) {
  return new Error(`preflight-swiftpm-source-tag: ${message}`);
}
export function parseSwiftpmPreflightArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!["--publication-lock", "--release-commit"].includes(flag)) throw error(`unknown argument ${flag}`);
    if (values.has(flag)) throw error(`${flag} may be supplied only once`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw error(`${flag} requires a value`);
    values.set(flag, value);
    index += 1;
  }
  const publicationLock = values.get("--publication-lock")?.trim() ?? "";
  const releaseCommit = values.get("--release-commit")?.trim() ?? "";
  if (publicationLock.length === 0) throw error("--publication-lock is required");
  if (!/^[0-9a-f]{40}$/iu.test(releaseCommit)) {
    throw error("--release-commit must be a full 40-character Git SHA");
  }
  return { publicationLock: path.resolve(publicationLock), releaseCommit: releaseCommit.toLowerCase() };
}

export async function preflightLockedSwiftpmSourceTag({ lock, releaseCommit, ensureTagImpl = ensureTag }) {
  assertPublicationLockSource(lock, releaseCommit);
  const inputs = lockedProductArtifactPaths(lock, "oliphaunt-swift");
  const manifests = inputs.filter(({ artifact, type }) => artifact.kind === "swiftpm-release-manifest" && type === "file");
  const trees = inputs.filter(({ artifact, type }) => artifact.kind === "swiftpm-release-tree" && type === "directory");
  if (manifests.length !== 1 || trees.length !== 1) {
    throw error(`publication lock must contain exactly one SwiftPM release manifest and tree, found ${manifests.length}/${trees.length}`);
  }
  return await ensureTagImpl({
    target: releaseCommit,
    manifest: manifests[0].path,
    includeTrees: [trees[0].path],
    preflight: true,
  });
}

if (import.meta.main) {
  try {
    const args = parseSwiftpmPreflightArgs(process.argv.slice(2));
    await preflightLockedSwiftpmSourceTag({
      lock: loadPublicationLock(args.publicationLock),
      releaseCommit: args.releaseCommit,
    });
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  }
}
