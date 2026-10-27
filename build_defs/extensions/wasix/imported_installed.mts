/** Consume the checked imported File map on its actual addon host. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { extensionManifestMembers } from '../../../src/extensions/artifacts/packages/tools/package-extension-release-carriers.mts';
import {
  extractPortableArchiveTree,
  readPortableArchiveEntries,
} from '../../../tools/packaging/portable-archive.mts';
import { stageDeclaredExtensionReleaseFiles } from '../../../tools/release/native-extension-release-files.mts';
import { fileIdentity } from '../../../tools/release/native-file-identity.mts';
import { prepareWasixConsumerInput } from './consumer_inputs.mts';

export function runImportedWasixInstalled({
  contract,
  runfiles,
  addonInputs,
  addonManifest,
  addonProvenance,
  root,
  node,
  consumer,
  environment,
}) {
  const resolve = (file: string) => {
    const location = contract.locations[file];
    assert(location && !path.isAbsolute(location) && !location.split('/').includes('..'));
    return path.join(runfiles, location);
  };
  const leaf = contract.leaf;
  assert(leaf.originalFiles, 'host consumption requires the checked original File map');
  const record = JSON.parse(readFileSync(resolve(leaf.originalFiles), 'utf8'));
  for (const key of ['product', 'owner', 'version', 'family', 'target'])
    assert.equal(record[key], leaf[key]);
  assert.equal(record.family, 'wasix');
  assert.equal(record.target, 'wasix-portable');
  const original = (file) => {
    const bytes = readFileSync(resolve(file.path));
    assert.equal(bytes.length, file.size);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
    return bytes;
  };
  const frozen = JSON.parse(original(record.frozen).toString());
  assert.equal(frozen.product, record.product);
  assert.equal(frozen.version, record.version);
  assert(addonManifest.os.includes(process.platform) && addonManifest.cpu.includes(process.arch));
  const hostTarget = addonManifest.oliphaunt.target;
  const work = path.join(root, record.product);
  mkdirSync(work);
  // This existing helper handles direct v1 assets and v2 closed-bundle members.
  const staged = stageDeclaredExtensionReleaseFiles(
    frozen,
    record.github.map((file) => resolve(file.path)),
    work,
    root,
    (source, destination) => {
      copyFileSync(source, destination);
      return fileIdentity(destination);
    },
  );
  const members = extensionManifestMembers(staged.manifest);
  assert.equal(members.length, 1, 'external host qualification requires one selected owner member');
  const member = members[0];
  const portableAsset = member.assets.filter((asset) => asset.target === 'wasix-portable');
  assert.equal(portableAsset.length, 1);
  const portable = readPortableArchiveEntries(path.join(root, portableAsset[0].path));
  const packageJsons = new Map<string, string>();
  const suffixes = [
    'wasix',
    ...(member.wasixInstall.nativeModules.length ? [`wasix-${hostTarget}`] : []),
  ];
  for (const suffix of suffixes) {
    const matches = record.npm.filter((file) =>
      path.basename(file.path).endsWith(`-${suffix}-${record.version}.tgz`),
    );
    assert.equal(matches.length, 1, `missing original ${suffix} npm File`);
    const file = matches[0];
    original(file);
    const entries = readPortableArchiveEntries(resolve(file.path));
    const packageManifest = entries.get('package/package.json');
    assert(packageManifest?.isFile, 'original npm File lacks package.json');
    const manifest = JSON.parse(packageManifest.data().toString());
    assert.equal(manifest.version, record.version);
    assert.equal(manifest.oliphaunt.product, record.product);
    if (suffix === 'wasix') {
      assert.equal(manifest.oliphaunt.kind, 'exact-extension-wasix');
      const payload = entries.get(`package/extensions/${member.sqlName}/extension.tar.zst`);
      assert(payload?.isFile, 'original portable npm File lacks its member archive');
      assert.deepEqual(payload.data(), readFileSync(path.join(root, portableAsset[0].path)));
    } else assert.equal(manifest.oliphaunt.target, hostTarget);
    const destination = path.join(root, 'node_modules', manifest.name);
    extractPortableArchiveTree(resolve(file.path), destination, 'package');
    packageJsons.set(suffix, path.join(destination, 'package.json'));
  }
  const manifestFact = addonProvenance.buildInputs.inputs.portableManifest;
  const hostManifest = path.join(addonInputs, manifestFact.path);
  const hostBytes = readFileSync(hostManifest);
  assert.equal(createHash('sha256').update(hostBytes).digest('hex'), manifestFact.sha256);
  assert.equal(hostBytes.length, manifestFact.size);
  const declared = new Map<string, any>(
    addonProvenance.buildInputs.inputs.extensionArtifacts.flatMap((owner) =>
      owner.portableArchives.map((member) => [member.sqlName, member]),
    ),
  );
  const prepared = prepareWasixConsumerInput({
    frozen,
    sqlName: member.sqlName,
    portable,
    addonName: addonManifest.name,
    packageJson: packageJsons.get('wasix'),
    aotPackageJson: packageJsons.get(`wasix-${hostTarget}`),
    fixturePath: resolve(contract.fixture),
    hostManifestPath: hostManifest,
    readDependency: (name) => {
      const file = declared.get(name);
      assert(file, `executing addon has no original dependency ${name}`);
      assert(!path.isAbsolute(file.path) && !file.path.split('/').includes('..'));
      return { ...file, bytes: readFileSync(path.join(addonInputs, file.path)) };
    },
  });
  const preparedPath = path.join(work, 'consumer-input.json');
  writeFileSync(preparedPath, JSON.stringify(prepared));
  const result = Bun.spawnSync(
    [node, '--experimental-strip-types', '--preserve-symlinks-main', consumer, preparedPath],
    { cwd: work, env: environment, stdout: 'pipe', stderr: 'pipe', timeout: 240_000 },
  );
  assert.equal(result.exitCode, 0, `${result.stderr.toString()}\n${result.stdout.toString()}`);
  console.log(result.stdout.toString().trim());
}
