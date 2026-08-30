#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

const MUSL_LOADER = /(?:^|[/\\])(?:ld-musl-[^/\\]+[.]so[.]1|libc[.]musl-[^/\\]+[.]so[.]1)$/iu;

export function detectLinuxLibc({ report, versions } = {}) {
  const runtimeVersions = versions ?? process.versions;
  if (typeof runtimeVersions?.musl === "string" && runtimeVersions.musl.length > 0) {
    return "musl";
  }

  const diagnostic = report ?? process.report?.getReport?.();
  if (
    Array.isArray(diagnostic?.sharedObjects)
    && diagnostic.sharedObjects.some((member) =>
      typeof member === "string" && (MUSL_LOADER.test(member) || /(?:^|[/\\])ld-musl-/iu.test(member))
    )
  ) {
    return "musl";
  }
  if (
    typeof diagnostic?.header?.glibcVersionRuntime === "string"
    && diagnostic.header.glibcVersionRuntime.length > 0
  ) {
    return "glibc";
  }
  return "unknown";
}

function main() {
  process.stdout.write(`${detectLinuxLibc()}\n`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
