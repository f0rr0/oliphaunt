#!/usr/bin/env bun
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  parseCommonArgs,
  writeChecksumManifest,
  writeEntriesArchive,
} from './release-fixture-utils.mjs';

function brokerEntries(target, executable) {
  return {
    [executable]: '#!/bin/sh\necho oliphaunt-broker release fixture\n',
    'manifest.properties': [
      'schema=oliphaunt-broker-release-assets-v1',
      'product=oliphaunt-broker',
      `target=${target}`,
      `binary=${executable}`,
      '',
    ].join('\n'),
  };
}

async function writeFixtureAssets(assetDir, version) {
  await fs.mkdir(assetDir, { recursive: true });
  const executableModes = {
    'bin/oliphaunt-broker': 0o755,
    'bin/oliphaunt-broker.exe': 0o755,
  };

  for (const target of ['macos-arm64', 'linux-x64-gnu', 'linux-arm64-gnu']) {
    await writeEntriesArchive(
      path.join(assetDir, `oliphaunt-broker-${version}-${target}.tar.gz`),
      brokerEntries(target, 'bin/oliphaunt-broker'),
      executableModes,
    );
  }

  await writeEntriesArchive(
    path.join(assetDir, `oliphaunt-broker-${version}-windows-x64-msvc.zip`),
    brokerEntries('windows-x64-msvc', 'bin/oliphaunt-broker.exe'),
    executableModes,
  );
  await writeChecksumManifest(assetDir, `oliphaunt-broker-${version}-release-assets.sha256`);
}

const { assetDir, version } = parseCommonArgs(
  Bun.argv.slice(2),
  'Create small oliphaunt-broker release-shaped assets for SDK checks.',
);
await writeFixtureAssets(assetDir, version);
