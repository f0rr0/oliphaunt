#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { stageBrokerDependencyLicenses } from '../release/broker-dependency-license-contract.mjs';
import { stageReleaseNotices } from '../release/release-notices.mjs';

import {
  elfFixture,
  machoFixture,
  parseCommonArgs,
  windowsPeFixture,
  writeChecksumManifest,
  writeEntriesArchive,
} from './release-fixture-utils.mjs';

function brokerBinary(target) {
  if (target === 'macos-arm64') {
    return machoFixture({ platform: 1, minos: [11, 0, 0] });
  }
  if (target === 'linux-x64-gnu') {
    return elfFixture({ machine: 62, requiredVersions: ['GLIBC_2.17'] });
  }
  if (target === 'linux-arm64-gnu') {
    return elfFixture({ machine: 183, requiredVersions: ['GLIBC_2.17'] });
  }
  throw new Error(`unsupported broker release fixture target ${target}`);
}

async function carrierLegalEntries(target) {
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'oliphaunt-broker-fixture-legal-'));
  await fs.chmod(stage, 0o755);
  try {
    stageReleaseNotices(stage, { profile: 'broker' });
    stageBrokerDependencyLicenses(stage, target);
    const entries = {};
    async function walk(directory, relative = '') {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const member = relative ? `${relative}/${entry.name}` : entry.name;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(file, member);
        } else if (entry.isFile()) {
          entries[member] = await fs.readFile(file);
        } else {
          throw new Error(`unexpected broker legal fixture entry ${file}`);
        }
      }
    }
    await walk(stage);
    return entries;
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

async function brokerEntries(target, executable) {
  return {
    ...await carrierLegalEntries(target),
    [executable]: brokerBinary(target),
    'manifest.properties': [
      'schema=oliphaunt-broker-release-assets-v1',
      'product=oliphaunt-broker',
      `target=${target}`,
      `binary=${executable}`,
      '',
    ].join('\n'),
  };
}

async function windowsBrokerEntries() {
  const runtimeName = 'vcruntime140.dll';
  const executable = windowsPeFixture({ imports: ['VCRUNTIME140.dll'] });
  const runtime = windowsPeFixture({ imports: ['KERNEL32.dll'] });
  const digest = createHash('sha256').update(runtime).digest('hex');
  return {
    ...await carrierLegalEntries('windows-x64-msvc'),
    'bin/oliphaunt-broker.exe': executable,
    [`bin/${runtimeName}`]: runtime,
    'bin/windows-vc-runtime.sha256': `${digest}  ${runtimeName}\n`,
    'manifest.properties': [
      'schema=oliphaunt-broker-release-assets-v1',
      'product=oliphaunt-broker',
      'target=windows-x64-msvc',
      'binary=bin/oliphaunt-broker.exe',
      `windowsVcRuntimeDlls=${runtimeName}`,
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
      await brokerEntries(target, 'bin/oliphaunt-broker'),
      executableModes,
    );
  }

  await writeEntriesArchive(
    path.join(assetDir, `oliphaunt-broker-${version}-windows-x64-msvc.zip`),
    await windowsBrokerEntries(),
    executableModes,
  );
  await writeChecksumManifest(assetDir, `oliphaunt-broker-${version}-release-assets.sha256`);
}

const { assetDir, version } = parseCommonArgs(
  Bun.argv.slice(2),
  'Create small oliphaunt-broker release-shaped assets for SDK checks.',
);
await writeFixtureAssets(assetDir, version);
