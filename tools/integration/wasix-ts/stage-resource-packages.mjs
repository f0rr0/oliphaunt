#!/usr/bin/env bun
import path from 'node:path';
import { stageExtensionWasixNpmPackages } from '../../release/package-extension-release-carriers.mjs';
import {
  stageWasixToolsNpmCarrier,
  stageWasixToolsAotNpmCarrier,
} from '../../release/wasix-tools-npm-carrier.mjs';
import { AOT_TARGET_TRIPLES } from '../../release/wasix-cargo-artifact-contract.mjs';

// Release metadata uses Bun. Keep the Node/Bun/Deno consumer harness host-neutral.
const { kind, ...options } = JSON.parse(Bun.argv[2]);
if (kind === 'tools') stageWasixToolsNpmCarrier(options);
else if (kind === 'tools-aot')
  stageWasixToolsAotNpmCarrier({
    ...options,
    aotArtifactDirectory: path.join(
      options.aotArtifactDirectory,
      AOT_TARGET_TRIPLES[options.target],
    ),
  });
else if (kind === 'extensions') {
  stageExtensionWasixNpmPackages([options.artifactRoot], options.stagingRoot, {
    staged: [],
    skipped: [],
  });
} else throw new Error(`unknown WASIX resource package kind: ${kind}`);
