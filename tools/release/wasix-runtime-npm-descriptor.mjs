import {
  WASIX_STANDARD_SEED_ARCHIVE_PATH,
  WASIX_RUNTIME_ARCHIVE_PATH,
  WASIX_RUNTIME_NPM_ASSET_PATHS,
  WASIX_RUNTIME_NPM_DESCRIPTOR_SCHEMA,
  WASIX_RUNTIME_PRODUCT,
} from './wasix-runtime-npm-contract.mjs';

const TOOL = 'wasix-runtime-npm-carrier.mjs';
const LOWER_SHA256 = /^[0-9a-f]{64}$/u;

function checkedDescriptorInput({ version, runtimeArchive, standardSeedArchive, standardSeedManifest, manifest }) {
  if (typeof version !== 'string' || version.length === 0) {
    throw new TypeError(`${TOOL}: runtime descriptor version must be a non-empty string`);
  }
  for (const [name, value] of Object.entries({ runtimeArchive, standardSeedArchive, standardSeedManifest, manifest })) {
    if (
      value === null ||
      Array.isArray(value) ||
      typeof value !== 'object' ||
      typeof value.sha256 !== 'string' ||
      !LOWER_SHA256.test(value.sha256) ||
      !Number.isSafeInteger(value.size) ||
      value.size <= 0
    ) {
      throw new TypeError(`${TOOL}: invalid ${name} descriptor input`);
    }
  }
  if (runtimeArchive.archive !== WASIX_RUNTIME_ARCHIVE_PATH) {
    throw new TypeError(`${TOOL}: invalid runtime archive descriptor path`);
  }
  if (standardSeedArchive.archive !== WASIX_STANDARD_SEED_ARCHIVE_PATH) {
    throw new TypeError(`${TOOL}: invalid standard cluster seed archive descriptor path`);
  }
}

export function renderWasixRuntimeDescriptorModule(input) {
  checkedDescriptorInput(input);
  const { version, runtimeArchive, standardSeedArchive, standardSeedManifest, manifest } = input;
  const asset = (value, sourcePath, includeArchive) =>
    [
      '  Object.freeze({',
      ...(includeArchive ? [`    archive: ${JSON.stringify(value.archive)},`] : []),
      `    sha256: ${JSON.stringify(value.sha256)},`,
      `    size: ${value.size},`,
      `    source: new URL(${JSON.stringify(`./${sourcePath}`)}, import.meta.url),`,
      '  })',
    ].join('\n');
  return [
    'export const POSTGRES_MAJOR = 18;',
    'export const PHYSICAL_FORMAT = "wasix-pg18-v1";',
    '',
    'const runtimeArchive =',
    `${asset(runtimeArchive, WASIX_RUNTIME_NPM_ASSET_PATHS.runtimeArchive, true)};`,
    'const standardSeedArchive =',
    `${asset(standardSeedArchive, WASIX_RUNTIME_NPM_ASSET_PATHS.standardSeedArchive, true)};`,
    'const standardSeedManifest =',
    `${asset(standardSeedManifest, WASIX_RUNTIME_NPM_ASSET_PATHS.standardSeedManifest, false)};`,
    'const manifest =',
    `${asset(manifest, WASIX_RUNTIME_NPM_ASSET_PATHS.manifest, false)};`,
    '',
    'const descriptor = Object.freeze({',
    `  schema: ${JSON.stringify(WASIX_RUNTIME_NPM_DESCRIPTOR_SCHEMA)},`,
    '  runtime: "wasix",',
    `  product: ${JSON.stringify(WASIX_RUNTIME_PRODUCT)},`,
    `  version: ${JSON.stringify(version)},`,
    '  runtimeArchive,',
    '  standardSeedArchive,',
    '  standardSeedManifest,',
    '  manifest,',
    '});',
    '',
    'export { descriptor };',
    'export default descriptor;',
    '',
  ].join('\n');
}

export function renderWasixRuntimeDescriptorTypes() {
  return `export declare const POSTGRES_MAJOR: 18;
export declare const PHYSICAL_FORMAT: "wasix-pg18-v1";

export type OliphauntWasixRuntimeAsset = Readonly<{
  archive: string;
  sha256: string;
  size: number;
  source: URL;
}>;

export type OliphauntWasixRuntimeManifest = Readonly<{
  sha256: string;
  size: number;
  source: URL;
}>;

export type OliphauntWasixRuntimeDescriptor = Readonly<{
  schema: "${WASIX_RUNTIME_NPM_DESCRIPTOR_SCHEMA}";
  runtime: "wasix";
  product: "${WASIX_RUNTIME_PRODUCT}";
  version: string;
  runtimeArchive: OliphauntWasixRuntimeAsset;
  standardSeedArchive: OliphauntWasixRuntimeAsset;
  standardSeedManifest: OliphauntWasixRuntimeManifest;
  manifest: OliphauntWasixRuntimeManifest;
}>;

declare const descriptor: OliphauntWasixRuntimeDescriptor;
export { descriptor };
export default descriptor;
`;
}
