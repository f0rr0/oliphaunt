import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { arch, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeTarget, type NativeExtensionPackage } from './native-addon.js';
import type { SerializedOpenOptions } from './rpc.js';
import type { WasixToolProcessOptions } from './tool-runtime.js';

export async function nativeToolPackage(tool: WasixToolProcessOptions['tool']): Promise<{
  packageJson: string;
  aotPackageJson: string;
}> {
  if (typeof tool.source !== 'string' || !tool.source.startsWith('file:')) {
    throw new Error('WASIX native tools require an installed package file URL');
  }
  const modulePath = await realpath(fileURLToPath(tool.source));
  const packageJson = join(dirname(dirname(modulePath)), 'package.json');
  const manifest = JSON.parse(await readFile(packageJson, 'utf8'));
  const name = '@oliphaunt/liboliphaunt-wasix-tools';
  const payload = manifest.oliphaunt?.tools?.[tool.name];
  if (
    manifest.name !== name ||
    manifest.oliphaunt?.kind !== 'wasix-tools' ||
    payload?.path !== `assets/${tool.name}.wasix.wasm` ||
    payload.sha256 !== tool.sha256 ||
    payload.size !== tool.size
  ) {
    throw new Error('WASIX tool descriptor does not match its installed package');
  }
  const aotName = `${name}-${nativeTarget(platform(), arch()).id}`;
  if (manifest.optionalDependencies?.[aotName] !== manifest.version) {
    throw new Error('WASIX tools package has no exact host AOT dependency');
  }
  return {
    packageJson,
    aotPackageJson: createRequire(packageJson).resolve(`${aotName}/package.json`),
  };
}

/** Installed native dependencies have the same trust as the application's imports. */
export async function nativeExtensionPackages(
  options: SerializedOpenOptions,
): Promise<NativeExtensionPackage[]> {
  return Promise.all(
    Object.values(options.extensionCarriers)
      .filter((carrier) => carrier.product !== 'oliphaunt-extension-contrib-pg18')
      .map(async (carrier) => {
        if (typeof carrier.source !== 'string' || !carrier.source.startsWith('file:')) {
          throw new Error(
            `WASIX native extension ${carrier.sqlName} requires an installed package file URL`,
          );
        }
        const archive = await realpath(fileURLToPath(carrier.source));
        const root = dirname(dirname(dirname(archive)));
        const packageJson = join(root, 'package.json');
        const manifest = JSON.parse(await readFile(packageJson, 'utf8'));
        const packageName = `@oliphaunt/${carrier.product.slice('oliphaunt-'.length)}-wasix`;
        const payload = manifest.oliphaunt?.carriers?.[carrier.sqlName];
        if (
          manifest.name !== packageName ||
          manifest.version !== carrier.version ||
          manifest.oliphaunt?.product !== carrier.product ||
          manifest.oliphaunt?.kind !== 'exact-extension-wasix' ||
          manifest.oliphaunt?.wasixRuntimeVersion !== options.runtime.version ||
          payload?.path !== `extensions/${carrier.sqlName}/extension.tar.zst` ||
          payload.sha256 !== carrier.sha256 ||
          payload.size !== carrier.size ||
          typeof payload.requiresAot !== 'boolean' ||
          archive !== (await realpath(join(root, payload.path)))
        ) {
          throw new Error(
            `WASIX extension ${carrier.sqlName} descriptor does not match its installed package`,
          );
        }
        let aotPackageJson: string | undefined;
        if (payload.requiresAot) {
          const target = nativeTarget(platform(), arch());
          const aotName = `${packageName}-${target.id}`;
          if (manifest.optionalDependencies?.[aotName] !== carrier.version) {
            throw new Error(`WASIX extension ${carrier.sqlName} has no exact host AOT dependency`);
          }
          aotPackageJson = createRequire(packageJson).resolve(`${aotName}/package.json`);
        }
        return {
          sqlName: carrier.sqlName,
          product: carrier.product,
          version: carrier.version,
          packageJson,
          ...(aotPackageJson === undefined ? {} : { aotPackageJson }),
        };
      }),
  );
}
