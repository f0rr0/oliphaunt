import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  compareNativeMobileAbiReceipts,
  NATIVE_MOBILE_ABI_TARGETS_BY_DOMAIN,
} from '../../../src/native/runtime/tools/native-mobile-abi-contract.mts';
import { bindNativeRuntimeResourceManifest } from '../../../src/native/runtime/tools/native-runtime-carrier-contract.mts';
import { validateMavenCentralPublication } from '../../../tools/packaging/maven-central-contract.mts';
import { readPortableArchiveEntries } from '../../../tools/packaging/portable-archive.mts';
import { copyDeclaredTree } from '../carriers/payload.mts';

/** Consume final GH and Maven bytes, without claiming Android execution. */
export function checkAndroidRuntimeAssets(
  metadata,
  artifacts: Map<string, string>,
  maven: Map<string, string>,
) {
  assert.deepEqual(
    [...artifacts.keys()].sort(),
    metadata.artifacts.map((row) => row.target).sort(),
  );
  assert.deepEqual([...maven.keys()].sort(), metadata.carriers.map((row) => row.name).sort());
  const runtime = readPortableArchiveEntries(artifacts.get('android-datum64'), {
    format: 'tar.gz',
  });
  const manifest = runtime.get('oliphaunt/runtime/manifest.properties');
  assert(manifest?.isFile, 'Final Android runtime resources must contain their installed manifest');
  assert(
    manifest.data().equals(bindNativeRuntimeResourceManifest(manifest.data(), 'android-datum64')),
  );
  compareNativeMobileAbiReceipts(
    'android-datum64',
    NATIVE_MOBILE_ABI_TARGETS_BY_DOMAIN['android-datum64'].map((target) => {
      const receipt = runtime.get(`oliphaunt/provenance/native-mobile-abi/${target}.properties`);
      assert(receipt?.isFile, `Final Android runtime resources lost the actual ${target} receipt`);
      return { label: target, text: receipt.data().toString('utf8') };
    }),
  );
  for (const carrier of metadata.carriers) {
    const [group, artifact] = carrier.name.split(':');
    const directory = path.join(
      maven.get(carrier.name),
      ...group.split('.'),
      artifact,
      metadata.version,
    );
    const prefix = `${artifact}-${metadata.version}`;
    const names = readdirSync(directory).sort();
    const publication = validateMavenCentralPublication({
      context: `${carrier.name}:${metadata.version}`,
      files: names.map((name) => ({ name, size: statSync(path.join(directory, name)).size })),
      pomText: readFileSync(path.join(directory, `${prefix}.pom`), 'utf8'),
    });
    assert.equal(
      `${publication.groupId}:${publication.artifactId}:${publication.version}`,
      `${carrier.name}:${metadata.version}`,
    );
    const target = carrier.target ?? 'android-datum64';
    const github = artifacts.get(target);
    assert(github, 'Final Maven runtime must correspond to an actual canonical GH artifact');
    assert(
      readFileSync(path.join(directory, `${prefix}.tar.gz`)).equals(readFileSync(github)),
      `${carrier.name} Maven and GH runtime bytes diverged`,
    );
  }
}

if (import.meta.main) {
  const [metadataText, ...arguments_] = process.argv.slice(2);
  const metadata = JSON.parse(metadataText);
  const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-installed-android-runtime-'));
  try {
    const artifacts = new Map<string, string>();
    const maven = new Map<string, string>();
    for (let index = 0; index < arguments_.length; index += 4) {
      const [kind, identity, source, declaredPath] = arguments_.slice(index, index + 4);
      assert(
        identity && source && declaredPath,
        'Android runtime test requires complete declared final inputs',
      );
      const target = kind === 'asset' ? artifacts : maven;
      assert(['asset', 'maven'].includes(kind) && !target.has(identity));
      const destination = path.join(root, `input-${index}`);
      if (kind === 'asset') copyFileSync(source, destination);
      else copyDeclaredTree(source, destination, undefined, declaredPath);
      target.set(identity, destination);
    }
    checkAndroidRuntimeAssets(metadata, artifacts, maven);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
