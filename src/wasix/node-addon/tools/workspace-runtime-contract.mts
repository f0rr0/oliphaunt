import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

export function workspaceRuntimeVersion(root = ROOT) {
  const version = readFileSync(path.join(root, 'src/wasix/runtime/VERSION'), 'utf8').trim();
  if (!/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(version)) {
    throw new Error('workspace WASIX runtime must have a stable version');
  }
  return version;
}

export function resolvedAdapterRuntimeContract(root = ROOT) {
  const lock = Bun.TOML.parse(
    readFileSync(path.join(root, 'src/wasix/node-addon/Cargo.lock'), 'utf8'),
  );
  const version = (name) => {
    const rows = (lock.package ?? []).filter((pkg) => pkg.name === name);
    if (
      rows.length !== 1 ||
      rows[0].source !== 'registry+https://github.com/rust-lang/crates.io-index' ||
      !/^[0-9a-f]{64}$/u.test(rows[0].checksum ?? '') ||
      !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(rows[0].version ?? '')
    ) {
      throw new Error(`WASIX adapter must resolve one checksum-pinned registry ${name}`);
    }
    return rows[0].version;
  };
  return {
    runtimeVersion: version('liboliphaunt-wasix-portable'),
    rustBindingVersion: version('oliphaunt-wasix'),
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
      qualificationOnly: true,
    },
  };
}
