import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export type TypeScriptPackageMetadata = {
  oliphaunt?: {
    liboliphauntVersion?: string;
    icuPackage?: string;
    icuVersion?: string;
    brokerVersion?: string;
    nodeDirectAddon?: string;
    nodeDirectAddonVersion?: string;
    brokerHelper?: string;
  };
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

export type TypeScriptPackageVersions = {
  liboliphauntVersion: string;
  icuVersion: string;
  brokerVersion: string;
  nodeDirectAddonVersion: string;
};

export async function readTypeScriptPackageJson(): Promise<TypeScriptPackageMetadata> {
  return JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as TypeScriptPackageMetadata;
}

export async function readTypeScriptPackageVersions(): Promise<TypeScriptPackageVersions> {
  const packageJson = await readTypeScriptPackageJson();
  return {
    liboliphauntVersion: packageMetadataVersion(packageJson, 'liboliphauntVersion'),
    icuVersion: packageMetadataVersion(packageJson, 'icuVersion'),
    brokerVersion: packageMetadataVersion(packageJson, 'brokerVersion'),
    nodeDirectAddonVersion: packageMetadataVersion(packageJson, 'nodeDirectAddonVersion'),
  };
}

export function packageMetadataVersion(
  packageJson: TypeScriptPackageMetadata,
  key: 'liboliphauntVersion' | 'icuVersion' | 'brokerVersion' | 'nodeDirectAddonVersion',
): string {
  const version = packageJson.oliphaunt?.[key];
  if (typeof version !== 'string' || version.length === 0) {
    assert.fail(`package.json oliphaunt.${key} must be set`);
  }
  return version;
}
