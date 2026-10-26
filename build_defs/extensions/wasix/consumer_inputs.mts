/** Normalize producer or imported final Files into one installed-consumer input. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { extensionControlDefaultVersion } from '../../../src/extensions/artifacts/packages/tools/extension-artifact-inventory.mts';
import {
  extensionManifestMembers,
  frozenExtensionCompatibility,
  frozenExtensionMemberInventory,
} from '../../../src/extensions/artifacts/packages/tools/package-extension-release-carriers.mts';
import { assertWasixExtensionMemberInstall } from '../../../src/extensions/contracts/wasix-extension-install.mts';
import { extensionControlRequires } from '../../../src/native/sdks/ts/src/native/extension-contract.ts';
import { readPortableTarZstdBufferEntries } from '../../../tools/packaging/portable-archive.mts';

export function prepareWasixConsumerInput({
  frozen,
  sqlName,
  portable,
  addonName,
  packageJson,
  aotPackageJson,
  fixturePath,
  hostManifestPath,
  readDependency,
}) {
  const members = extensionManifestMembers(frozen).filter((member) => member.sqlName === sqlName);
  assert.equal(members.length, 1, 'consumer requires one selected frozen member');
  const member = members[0];
  const inventory = frozenExtensionMemberInventory(member, {
    product: frozen.product,
    version: frozen.version,
  });
  const compatibility = frozenExtensionCompatibility(frozen.compatibility, frozen.product);
  const install = assertWasixExtensionMemberInstall(member, {
    label: `${frozen.product}/${sqlName}`,
  });
  assert(install, 'selected member lacks its frozen WASIX installation contract');
  const controls = new Map<string, { sqlName: string; version: string; requires: string[] }>();
  const prefix = 'share/postgresql/extension/';
  const addControls = (entries) => {
    const names = [];
    for (const [file, entry] of entries) {
      if (!entry.isFile || !file.startsWith(prefix) || !file.endsWith('.control')) continue;
      const name = file.slice(prefix.length, -'.control'.length);
      assert(!name.includes('/') && !controls.has(name), 'delivered controls repeat or escape');
      const text = entry.data().toString();
      controls.set(name, {
        sqlName: name,
        version: extensionControlDefaultVersion(text, name, file),
        requires: extensionControlRequires(text, file),
      });
      names.push(name);
    }
    return names.sort();
  };
  const own = addControls(portable);
  assert.deepEqual(
    own,
    inventory.sqlMembers ?? (inventory.createsExtension ? [sqlName] : []),
    'delivered controls differ from the original frozen member closure',
  );
  const dependencies = [];
  const pending = [...own, ...install.dependencies];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (name: string) => {
    if (name === 'plpgsql' || visited.has(name)) return;
    assert(!visiting.has(name), 'delivered extension dependency cycle');
    visiting.add(name);
    if (!controls.has(name)) {
      const input = readDependency(name);
      assert(input, `executing addon lacks original dependency ${name}`);
      const bytes = Buffer.from(input.bytes);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), input.sha256);
      if (input.size !== undefined) assert.equal(bytes.length, input.size);
      const entries = readPortableTarZstdBufferEntries(bytes);
      const names = addControls(entries);
      assert(names.includes(name), 'dependency archive lacks its own control');
      dependencies.push({
        sqlName: name,
        sha256: input.sha256,
        size: bytes.length,
        modules: [...entries]
          .filter(([file, entry]) => entry.isFile && file.startsWith('lib/postgresql/'))
          .map(([file]) => file)
          .sort(),
      });
      pending.push(...names);
    }
    const control = controls.get(name);
    assert(control, `dependency archive lacks its control ${name}`);
    for (const dependency of control.requires) visit(dependency);
    visiting.delete(name);
    visited.add(name);
  };
  for (const name of pending) visit(name);
  assert(
    !install.lifecycle.createExtension || controls.has(sqlName),
    'created member lacks its delivered control',
  );
  assert.equal(Boolean(aotPackageJson), install.nativeModules.length > 0);
  const asset = member.assets.filter((asset) => asset.target === 'wasix-portable');
  assert.equal(asset.length, 1, 'selected frozen member lacks one portable asset');
  return {
    addonName,
    product: frozen.product,
    version: frozen.version,
    sqlName,
    runtimeVersion: compatibility.wasixRuntimeVersion,
    lifecycle: install.lifecycle,
    defaultVersion: controls.get(sqlName)?.version ?? null,
    fixturePath,
    hostManifestPath,
    extensionPackage: {
      sqlName,
      product: frozen.product,
      version: frozen.version,
      packageJson,
      archiveSha256: asset[0].sha256,
      archiveSize: asset[0].bytes,
      ...(aotPackageJson ? { aotPackageJson } : {}),
    },
    dependencies: dependencies.sort((left, right) => left.sqlName.localeCompare(right.sqlName)),
    sqlMembers: [...controls.values()]
      .map(({ sqlName, version }) => ({ sqlName, version }))
      .sort((left, right) => left.sqlName.localeCompare(right.sqlName)),
    modules: [
      ...new Set([
        ...install.nativeModules.map((module) => module.path),
        ...dependencies.flatMap((dependency) => dependency.modules),
      ]),
    ].sort(),
  };
}
