import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseProfilePackageLicense } from '../../../../tools/packaging/release-notices.mts';
import { readCargoPackageNameVersion } from '../../../../tools/packaging/cargo-source-package.mts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

export function wasixNapiNoticeProfile(target) {
  return target === 'windows-x64-msvc' ? 'wasix-napi-addon-windows' : 'wasix-napi-addon';
}

export function workspaceRuntimeVersion(root = ROOT) {
  const version = readFileSync(path.join(root, 'src/wasix/runtime/VERSION'), 'utf8').trim();
  if (!/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(version)) {
    throw new Error('workspace WASIX runtime must have a stable version');
  }
  return version;
}

// A source checkout compiles its local runtime. Preserve committed release
// pins, and identify a carrier built against different workspace dependencies
// so publication cannot mistake it for the immutable released package.
export function workspaceCarrierManifest(manifest, declaredContract, root = ROOT) {
  const runtimeVersion = workspaceRuntimeVersion(root);
  const rustBindingVersion = readCargoPackageNameVersion(
    path.join(root, 'src/wasix/sdks/rust/Cargo.toml'),
  ).version;
  return {
    ...manifest,
    license: releaseProfilePackageLicense(wasixNapiNoticeProfile(manifest.oliphaunt.target)).spdx,
    oliphaunt: {
      ...manifest.oliphaunt,
      runtimeVersion,
      ...(runtimeVersion !== declaredContract.runtimeVersion ||
      rustBindingVersion !== declaredContract.rustBindingVersion
        ? { qualificationOnly: true }
        : {}),
    },
  };
}
