import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cargoSatisfies } from '../../../../tools/packaging/cargo-manifest.mts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

export function workspaceRuntimeVersion(root = ROOT) {
  const version = readFileSync(path.join(root, 'src/wasix/runtime/VERSION'), 'utf8').trim();
  if (!/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(version)) {
    throw new Error('workspace WASIX runtime must have a stable version');
  }
  return version;
}

export function resolvedAdapterRuntimeContract(root = ROOT) {
  const manifest = (relative) =>
    Bun.TOML.parse(readFileSync(path.join(root, relative, 'Cargo.toml'), 'utf8'));
  const lock = Bun.TOML.parse(readFileSync(path.join(root, 'Cargo.lock'), 'utf8'));
  const workspace = manifest('').workspace;
  const version = (owner, name, destination) => {
    let dependency = manifest(owner).dependencies?.[name];
    let base = path.join(root, owner);
    if (dependency?.workspace === true) {
      dependency = workspace.dependencies?.[name];
      base = root;
    }
    const declared = manifest(destination).package;
    const rows = (lock.package ?? []).filter((pkg) => pkg.name === name && !pkg.source);
    if (
      rows.length !== 1 ||
      rows[0].checksum !== undefined ||
      declared.name !== name ||
      rows[0].version !== declared.version ||
      !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(declared.version ?? '') ||
      typeof dependency?.path !== 'string' ||
      path.resolve(base, dependency.path) !== path.resolve(root, destination) ||
      typeof dependency.version !== 'string' ||
      !cargoSatisfies(declared.version, dependency.version)
    ) {
      throw new Error(
        `WASIX adapter must resolve local ${name} with its declared path and version`,
      );
    }
    return rows[0].version;
  };
  const addon = 'src/wasix/node-addon';
  const sdk = 'src/wasix/sdks/rust';
  const portable = 'src/wasix/runtime/crates/assets';
  const rustBindingVersion = version(addon, 'oliphaunt-wasix', sdk);
  const runtimeVersion = version(addon, 'liboliphaunt-wasix-portable', portable);
  version(sdk, 'liboliphaunt-wasix-portable', portable);
  return {
    runtimeVersion,
    rustBindingVersion,
  };
}

// Current-folder inventory cannot attest to registry payload bytes, even when
// its version matches. Publication requires the native File-bound carrier.
export function workspaceCarrierManifest(manifest, _declaredContract, root = ROOT) {
  const resolved = resolvedAdapterRuntimeContract(root);
  return {
    ...manifest,
    oliphaunt: {
      ...manifest.oliphaunt,
      runtimeVersion: resolved.runtimeVersion,
      rustBindingVersion: resolved.rustBindingVersion,
      qualificationOnly: true,
    },
  };
}
