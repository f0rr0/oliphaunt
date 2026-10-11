/** Historical declared carriers, never historical Bazel inputs or build provenance. */
import { deepStrictEqual } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CONTRIB_CARRIERS_PATH,
  loadContribCarriers,
} from '../../src/extensions/artifacts/packages/tools/contrib-carriers.mts';
import {
  nativeExtensionModuleHostTarget,
  validateExtensionTargetProfiles,
} from '../../src/extensions/contracts/extension-target-profiles.mts';
import {
  AOT_TARGET_TRIPLES,
  expectedExtensionAotTargets,
} from '../../src/wasix/runtime/tools/wasix-cargo-artifact-contract.mts';
import {
  type CompletedPublication,
  createCompletedPublicationChecker,
} from './completed-release-publication.mts';
import { requestGithubRepositoryJson } from './github-read.mts';
import { safeRelative } from './native-file-identity.mts';
import { PLATFORM_COMPATIBILITY_POLICY } from './platform-compatibility-policy.mts';
import {
  extensionRegistryPackageTargetSetsFromRows,
  registryPackageRows,
  runtimeExtensionTargetRowsFromConfigs,
  validateExtensionCatalogRows,
} from './release-artifact-targets.mts';

const prefix = 'completed contrib carrier context';
const profilesPath = 'src/extensions/contracts/extension-target-profiles.toml';
const catalogPath = 'src/extensions/generated/extensions.catalog.json';
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const object = (value, label: string) => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${prefix}: ${label} must be an object`);
  return value;
};
const string = (value, label: string): string => {
  if (typeof value !== 'string' || !value)
    throw new Error(`${prefix}: ${label} must be a nonempty string`);
  return value;
};

/**
 * Read only the canonical metadata at a completed publication's exact commit.
 * Source paths and declarations come from that commit, including renamed owner
 * directories. Transport overrides are controlled fixtures, not authentication.
 */
export async function readCompletedContribCarrierRows(
  publication: CompletedPublication,
  {
    repository = 'f0rr0/oliphaunt',
    assertCompleted = createCompletedPublicationChecker({ repository }),
    readJson = requestGithubRepositoryJson,
  } = {},
) {
  publication = structuredClone(publication);
  if (repository !== 'f0rr0/oliphaunt') throw new Error(`${prefix}: unsupported repository`);
  deepStrictEqual(await assertCompleted(publication), publication, 'completed contrib source');
  const sources = new Map<string, { text: string; sha: string }>();
  const read = async (file: string) => {
    safeRelative(file);
    if (!sources.has(file)) {
      const value = await readJson(
        `repos/${repository}/contents/${file}?ref=${publication.publicationSha}`,
      );
      if (
        value.type !== 'file' ||
        value.path !== file ||
        value.encoding !== 'base64' ||
        typeof value.content !== 'string' ||
        !/^[0-9a-f]{40}$/u.test(value.sha)
      )
        throw new Error(`${prefix}: missing exact historical file ${file}`);
      const bytes = Buffer.from(value.content, 'base64');
      if (
        createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !==
        value.sha
      )
        throw new Error(`${prefix}: historical Git blob differs for ${file}`);
      sources.set(file, { text: utf8.decode(bytes), sha: value.sha });
    }
    const source = sources.get(file);
    if (!source) throw new Error(`${prefix}: historical file was not captured ${file}`);
    return source.text;
  };
  const toml = async (file: string) => object(Bun.TOML.parse(await read(file)), file);
  const config = object(JSON.parse(await read('release-please-config.json')), 'release config');
  const versions = object(
    JSON.parse(await read('.release-please-manifest.json')),
    'release versions',
  );
  const owners = new Map<string, string>();
  for (const [ownerPath, value] of Object.entries(object(config.packages, 'release packages'))) {
    safeRelative(ownerPath);
    const owner = string(object(value, ownerPath).component, `${ownerPath}.component`);
    if (owners.has(owner)) throw new Error(`${prefix}: duplicate historical owner ${owner}`);
    owners.set(owner, ownerPath);
  }
  const carrierDescriptor = await toml(CONTRIB_CARRIERS_PATH);
  for (const field of ['logical_product', 'native_owner', 'wasix_owner'])
    string(carrierDescriptor[field], field);
  if (carrierDescriptor.native_owner === carrierDescriptor.wasix_owner)
    throw new Error(`${prefix}: native and WASIX ownership must be distinct`);
  if (
    ![carrierDescriptor.native_owner, carrierDescriptor.wasix_owner].includes(publication.product)
  )
    throw new Error(`${prefix}: publication is not a historical contrib owner`);
  const products = {};
  for (const owner of [carrierDescriptor.native_owner, carrierDescriptor.wasix_owner]) {
    const ownerPath = owners.get(owner);
    if (!ownerPath) throw new Error(`${prefix}: historical contrib owner ${owner} is unconfigured`);
    const descriptor = await toml(`${ownerPath}/release.toml`);
    const version = string(versions[ownerPath], `${ownerPath} version`);
    if (descriptor.id !== owner) throw new Error(`${prefix}: historical descriptor owner differs`);
    products[owner] = { ...descriptor, path: ownerPath, version };
  }
  if (products[publication.product].version !== publication.version)
    throw new Error(`${prefix}: completed product version differs from historical source`);
  for (const field of ['member_manifest', 'source', 'contract'])
    await read(safeRelative(string(carrierDescriptor[field], field)));
  const profiles = validateExtensionTargetProfiles(await toml(profilesPath)).targets;
  const catalog = validateExtensionCatalogRows(JSON.parse(await read(catalogPath)), prefix);
  for (const row of profiles) {
    if (
      (row.family === 'native' &&
        row.kind ===
          (nativeExtensionModuleHostTarget(row.target) === row.target
            ? 'native-dynamic'
            : 'native-static-registry') &&
        Object.hasOwn(PLATFORM_COMPATIBILITY_POLICY, row.target)) ||
      (row.family === 'wasix' &&
        row.kind === 'wasix-runtime' &&
        (row.target === 'wasix-portable' || Object.hasOwn(AOT_TARGET_TRIPLES, row.target)))
    )
      continue;
    throw new Error(
      `${prefix}: unsupported historical profile ${row.target}/${row.family}/${row.kind}`,
    );
  }

  // The old profile declaration is itself the carrier authority. Before the
  // release.toml migration, no runtime artifact_targets table existed here.
  // Validate a table when actually present; never substitute current defaults.
  const hasTargets = Object.values(products).map(
    (product: any) => product.artifact_targets !== undefined,
  );
  if (hasTargets.some(Boolean) && !hasTargets.every(Boolean))
    throw new Error(
      `${prefix}: mixed historical runtime artifact target declarations are unsupported`,
    );
  if (hasTargets.every(Boolean)) {
    const allowed = new Set(
      runtimeExtensionTargetRowsFromConfigs(products, prefix, {
        nativeOwner: carrierDescriptor.native_owner,
        wasixOwner: carrierDescriptor.wasix_owner,
      }).map((row) => `${row.target}\0${row.family}\0${row.kind}`),
    );
    for (const row of profiles)
      if (!allowed.has(`${row.target}\0${row.family}\0${row.kind}`))
        throw new Error(`${prefix}: profile is not backed by historical runtime targets`);
  }
  const directory = mkdtempSync(path.join(tmpdir(), 'oliphaunt-completed-contrib-'));
  try {
    // Reuse the exact existing descriptor/member loader on a disposable source
    // snapshot. This is not a persisted manifest, receipt or historical graph.
    for (const [file, { text }] of sources) {
      const destination = path.join(directory, file);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, text, { flag: 'wx' });
    }
    const contrib = loadContribCarriers(directory, prefix, {
      readText: (file) => {
        const source = sources.get(file);
        if (!source) throw new Error(`${prefix}: uncaptured historical contrib input ${file}`);
        return source.text;
      },
    });
    const names = contrib.members.map((member) => string(member['sql-name'], 'contrib SQL name'));
    if (!names.length || new Set(names).size !== names.length)
      throw new Error(`${prefix}: historical contrib SQL names must be nonempty and unique`);
    for (const name of names)
      if (!catalog.has(name)) throw new Error(`${prefix}: historical catalog omits ${name}`);
    const contribRegistryTargets = extensionRegistryPackageTargetSetsFromRows(
      contrib.artifactProduct,
      names,
      names.flatMap((sqlName) => profiles.map((row) => ({ ...row, sqlName }))),
      names.filter((name) => typeof catalog.get(name)['native-module-file'] === 'string'),
      prefix,
    );
    if (publication.product === contrib.wasixOwner) {
      if (!contribRegistryTargets.includeWasixNpm)
        throw new Error(`${prefix}: historical WASIX portable carrier profile is missing`);
      if (contribRegistryTargets.includeWasixAot) {
        const aotPrefix = `crates:${contrib.wasixOwner}-aot-`;
        const entries = products[contrib.wasixOwner].registry_packages;
        if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== 'string'))
          throw new Error(`${prefix}: historical WASIX registry packages must be a string list`);
        const aotTargets = entries
          .filter((entry) => entry.startsWith(aotPrefix))
          .map((entry) => entry.slice(aotPrefix.length))
          .sort();
        deepStrictEqual(
          aotTargets,
          expectedExtensionAotTargets(),
          'historical WASIX AOT carrier mapping',
        );
      }
    }
    const inputContext = { products, contrib, contribRegistryTargets };
    return {
      publication,
      descriptor: products[publication.product],
      registryRows: registryPackageRows({ product: publication.product, inputContext }, prefix),
      sourceFiles: [...sources].map(([file, { sha }]) => ({ path: file, sha })),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
