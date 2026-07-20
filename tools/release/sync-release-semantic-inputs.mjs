#!/usr/bin/env bun
import { loadGraph, ROOT } from "./release-graph.mjs";
import { syncReleaseSemanticInputFingerprints } from "./release-semantic-inputs.mjs";

const PREFIX = "sync-release-semantic-inputs.mjs";

function main(argv) {
  let write = false;
  for (const arg of argv) {
    if (arg === "--write") write = true;
    else if (arg === "--check") write = false;
    else if (arg === "--help" || arg === "-h") {
      console.log("usage: tools/release/sync-release-semantic-inputs.mjs [--check|--write]");
      return;
    } else {
      throw new Error(`${PREFIX}: unknown argument ${arg}`);
    }
  }
  const result = syncReleaseSemanticInputFingerprints(loadGraph(PREFIX), {
    root: ROOT,
    write,
    prefix: PREFIX,
  });
  if (result.changes.length === 0) {
    console.log("release-semantic input fingerprints are current");
    return;
  }
  for (const change of result.changes) {
    console.error(`${change.path}: ${change.product} release-semantic fingerprint is stale`);
  }
  if (!write) {
    throw new Error(`${PREFIX}: run with --write to refresh product-local Release Please inputs`);
  }
  console.log(`updated ${result.changes.length} release-semantic input fingerprint(s)`);
}

try {
  main(Bun.argv.slice(2));
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exit(1);
}
