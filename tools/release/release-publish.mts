import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readSelectedRemoteTagMap } from '../../.github/scripts/manage-release-drafts.mts';
import { stagedKotlinMavenRepo as validateStagedKotlinMavenRepo } from '../../src/sdks/kotlin/tools/kotlin-maven-staging.mts';
import {
  compareText,
  currentProductVersionSync,
} from '../../src/shared/product-metadata/release-artifact-targets.mts';
import { loadProducts, releaseOrder } from '../../src/shared/product-metadata/release-graph.mts';
import { loadBootstrapLedger } from './bootstrap-ledger.mts';
import { uploadCargoOnceAndReconcileExactVersion } from './cargo-upload-reconciliation.mts';
import { queryRegistryPackages } from './check_registry_publication.mts';
import {
  executeConcurrentGithubReleaseAssetUploadPlan,
  githubReleaseAssetUploadEnvironment,
  writeConcurrentGithubReleaseAssetUploadReport,
} from './concurrent-github-release-asset-upload.mts';
import {
  inspectCratesIoVersionState,
  parseRegistryMutationDeadline,
} from './crates-io-bootstrap-capacity.mts';
import { publishFrozenCargoCrate } from './frozen-cargo-publish.mts';
import { loadPreparedMavenBundle, publishFrozenMavenBundle } from './frozen-maven-publish.mts';
import {
  prepareFrozenNpmPublication,
  reconcileFrozenNpmPublication,
} from './frozen-npm-publish.mts';
import { concurrentGithubReleaseAssetUploadPlan } from './github-release-asset-upload-plan.mts';
import {
  collectNormalPublicationReceipts,
  executeCargoPublicationBatch,
  normalPublicationSchedule,
} from './normal-publication-executor.mts';
import { normalPublicationPlan } from './normal-publication-plan.mts';
import {
  assertLockedArtifactSet,
  assertLockedProductArtifacts,
  assertPublicationLockSource,
  DEFAULT_PUBLICATION_LOCK,
  discoverPublicationArtifacts,
  loadPublicationLock,
  lockedCarrierFile,
  lockedCarriers,
  lockedProductArtifactPaths,
} from './publication-lock.mts';
import {
  verifyLockedCarrierIntegrity,
  verifyLockedRegistryIntegrity,
  writeRegistryReceiptEvidence,
} from './registry-integrity.mts';
import {
  encodeRegistryPublicationDeferral,
  isRegistryPublicationDeferredError,
  REGISTRY_PUBLICATION_DEFERRAL_EXIT_CODE,
  requirePreMutationRegistryWindow,
} from './registry-publication-deferral.mts';
import { ROOT, uniqueValueFlag } from './release-cli-utils.mts';
import { frozenUploadPlan, uploadFrozenReleaseAssets } from './upload_github_release_assets.mts';

const TOOL = 'release-publish.mts';
const REGISTRY_DEADLINE_RESERVE_MS = 5_000;
const MAVEN_PUBLISH_MINIMUM_WINDOW_MS = 35 * 60_000;

function usage() {
  console.log(`usage: tools/release/release-publish.mts publish [publish args] [--publication-lock FILE]

Runs protected publication. Read-only validation uses bash tools/release/release-dry-run.sh.

Every real publish requires an exact-SHA frozen publication lock. Repeatable
identity bootstrap for newly generated Cargo/npm identities uses:
  bash .github/scripts/bootstrap-registry-identities.sh
Bootstrap mode cannot publish GitHub releases/assets or Maven.

Normal registry publication uses one lock-derived global topology:
  bash tools/release/publish-registries.sh --products-json JSON --head-ref SHA \
    --publication-lock FILE
`);
}

function fail(message, exitCode = 2) {
  console.error(`${TOOL}: ${message}`);
  process.exit(exitCode);
}

function exitTypedRegistryDeferral(cause) {
  console.error(encodeRegistryPublicationDeferral(cause));
  process.exit(REGISTRY_PUBLICATION_DEFERRAL_EXIT_CODE);
}

function removeValueFlag(args, name) {
  const output = [];
  let selected;
  try {
    selected = uniqueValueFlag(args, name);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === name) {
      index += 1;
    } else if (value.startsWith(`${name}=`)) {
      continue;
    } else {
      output.push(value);
    }
  }
  return { args: output, value: selected };
}

const lockArgs = removeValueFlag(Bun.argv.slice(2), '--publication-lock');
const ledgerArgs = removeValueFlag(lockArgs.args, '--bootstrap-ledger');
const argv = ledgerArgs.args.filter((arg) => arg !== '--bootstrap-identities');
const command = argv[0];
const BOOTSTRAP_IDENTITIES = ledgerArgs.args.includes('--bootstrap-identities');
const PUBLICATION_LOCK_PATH = path.resolve(
  ROOT,
  lockArgs.value ?? process.env.OLIPHAUNT_PUBLICATION_LOCK ?? DEFAULT_PUBLICATION_LOCK,
);
const BOOTSTRAP_LEDGER_PATH = path.resolve(
  ROOT,
  ledgerArgs.value ?? process.env.OLIPHAUNT_BOOTSTRAP_LEDGER ?? 'target/release/bootstrap-ledger',
);
const REGISTRY_RECEIPT_EVIDENCE_PATH = path.resolve(
  ROOT,
  process.env.OLIPHAUNT_REGISTRY_RECEIPTS ?? 'target/release/registry-integrity-receipts.json',
);
let ACTIVE_PUBLICATION_LOCK = null;
function activePublicationSourceRef(environment = process.env) {
  const configured = environment.RELEASE_HEAD_SHA?.trim();
  if (configured === undefined || configured === '') return 'HEAD';
  if (!/^[0-9a-f]{40}$/u.test(configured)) {
    fail('RELEASE_HEAD_SHA must be a full lowercase commit SHA when provided');
  }
  return configured;
}

if (command === '-h' || command === '--help') {
  usage();
  process.exit(0);
}

const registryPhases = new Set([
  'registry-prepare',
  'registry-cargo',
  'registry-npm-before',
  'registry-npm-after',
  'registry-maven',
  'registry-finish',
]);
const bootstrapPhases = new Set(['bootstrap-cargo', 'bootstrap-npm-before', 'bootstrap-npm-after']);
if (registryPhases.has(command) && BOOTSTRAP_IDENTITIES)
  fail('normal registry phases are forbidden during identity bootstrap');
if (command !== 'publish' && !registryPhases.has(command) && !bootstrapPhases.has(command)) {
  usage();
  fail(`expected publish (read-only checks use release-dry-run.sh), got ${command ?? '<missing>'}`);
}

for (const valueFlag of ['--carrier-id', '--head-ref', '--product', '--products-json', '--step']) {
  flagValue(argv.slice(1), valueFlag);
}

if (
  !argv.slice(1).includes('--registry-plan') &&
  new Set(['crates-io', 'npm', 'maven-central']).has(flagValue(argv.slice(1), '--step'))
) {
  fail(
    'normal product/ecosystem registry steps are disabled; use bash tools/release/publish-registries.sh',
  );
}

try {
  ACTIVE_PUBLICATION_LOCK = loadPublicationLock(PUBLICATION_LOCK_PATH);
  assertPublicationLockSource(ACTIVE_PUBLICATION_LOCK, activePublicationSourceRef());
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
process.env.OLIPHAUNT_PUBLICATION_LOCK = PUBLICATION_LOCK_PATH;

function flagValue(args, flag) {
  try {
    return uniqueValueFlag(args, flag);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function unexpectedValueFlagArguments(args, allowed) {
  const unexpected = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    const exact = allowed.has(value);
    const inline = [...allowed].some((flag) => value.startsWith(`${flag}=`));
    if (inline) continue;
    if (!exact) {
      unexpected.push(value);
      continue;
    }
    if (index + 1 >= args.length) {
      unexpected.push(value);
      continue;
    }
    index += 1;
  }
  return unexpected;
}

function rel(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function stagedKotlinMavenRepo() {
  return validateStagedKotlinMavenRepo({
    version: currentProductVersionSync('oliphaunt-kotlin', TOOL),
  });
}

function parseProductsJson(args) {
  const productsJson = flagValue(args, '--products-json');
  if (productsJson === null) {
    return null;
  }
  let requested;
  try {
    requested = JSON.parse(productsJson);
  } catch (error) {
    fail(`--products-json must be valid JSON: ${error.message}`);
  }
  if (
    !Array.isArray(requested) ||
    requested.length === 0 ||
    !requested.every((item) => typeof item === 'string')
  ) {
    fail('--products-json must be a non-empty JSON string array');
  }
  return requested;
}

function releaseOrderedProducts(requested) {
  return releaseOrder(loadProducts(TOOL), undefined, requested, TOOL);
}

function publishProductStepPlan(args) {
  const product = flagValue(args, '--product');
  const step = flagValue(args, '--step');
  if (product === null && step === null) {
    return null;
  }
  if (product === null || step === null) {
    return null;
  }
  return {
    headRef: flagValue(args, '--head-ref') ?? 'HEAD',
    product,
    step,
  };
}

async function verifyReleaseTags(products, headRef) {
  const source = assertPublicationLockSource(ACTIVE_PUBLICATION_LOCK, headRef);
  if (BOOTSTRAP_IDENTITIES || products.length === 0) return;
  const repo = process.env.GITHUB_REPOSITORY?.trim() ?? '';
  const productMetadata = loadProducts('release-publish-github-release-assets');
  const lockedProducts = new Map(ACTIVE_PUBLICATION_LOCK.products.map((row) => [row.id, row]));
  const selectedTags = products.map((product) => {
    const config = productMetadata[product];
    const locked = lockedProducts.get(product);
    if (config === undefined || locked === undefined || config.version !== locked.version) {
      throw new Error(`${product} cannot derive an exact frozen remote tag identity`);
    }
    return { product, tag: `${config.tag_prefix}${locked.version}` };
  });
  const remoteTags = await readSelectedRemoteTagMap(repo, selectedTags, {
    environment: process.env,
  });
  for (const { product, tag } of selectedTags) {
    const remote = remoteTags.get(tag);
    if (remote?.type !== 'commit' || remote.sha !== source.commit) {
      throw new Error(`${product} tag ${tag} is not bound to exact release commit ${headRef}`);
    }
  }
}

function requireFrozenArtifacts(roots, { products, ecosystem }) {
  let actual;
  try {
    actual = discoverPublicationArtifacts(roots).filter(
      (artifact) => artifact.ecosystem === ecosystem,
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  try {
    assertLockedArtifactSet(ACTIVE_PUBLICATION_LOCK, actual, { products, ecosystem });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function requireFrozenProductArtifacts(product, roots) {
  try {
    assertLockedProductArtifacts(ACTIVE_PUBLICATION_LOCK, product, roots);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

async function publishSelectedGithubReleaseAssetSets(products, headRef) {
  const selected = [...new Set(products)].sort(compareText);
  if (selected.length === 0 || selected.length !== products.length) {
    fail(
      'concurrent GitHub release asset publication requires a non-empty unique product selection',
    );
  }
  await verifyReleaseTags(selected, headRef);
  const repo = process.env.GITHUB_REPOSITORY?.trim() ?? '';
  const rows = new Map();
  const uploadPlans = new Map();
  for (const product of selected) {
    const assets = lockedProductArtifactPaths(ACTIVE_PUBLICATION_LOCK, product).filter(
      ({ artifact }) =>
        artifact.role === 'github-release-asset' || artifact.role === 'github-release-metadata',
    );
    if (assets.some(({ type }) => type !== 'file')) {
      fail(`${product} publication lock contains a non-file GitHub release asset`);
    }
    rows.set(product, assets.length);
    uploadPlans.set(
      product,
      frozenUploadPlan({
        product,
        assets: assets.map(({ path: file }) => rel(file)),
        publicationLock: PUBLICATION_LOCK_PATH,
        repo,
      }),
    );
  }
  let plan;
  try {
    plan = concurrentGithubReleaseAssetUploadPlan(rows);
  } catch (cause) {
    fail(cause instanceof Error ? cause.message : String(cause));
  }
  console.log(
    `Publishing ${plan.assetCount} exact frozen GitHub release assets for ${plan.productCount} ` +
      `asset-backed products in ${plan.waves.length} bounded concurrent wave(s); ` +
      `${selected.length - plan.productCount} exact empty product asset sets are receipt-proven.`,
  );
  const coordinationRoot = mkdtempSync(path.join(tmpdir(), 'oliphaunt-github-release-asset-wave-'));
  const abortPath = path.join(coordinationRoot, 'abort.json');
  const reportPath =
    process.env.GITHUB_RELEASE_ASSET_UPLOAD_REPORT_PATH ??
    path.join(coordinationRoot, 'report.json');
  try {
    let execution;
    try {
      execution = await executeConcurrentGithubReleaseAssetUploadPlan(plan, {
        abort: (outcome) => {
          writeFileSync(
            abortPath,
            `${JSON.stringify({
              product: outcome.product,
              reason: 'peer product lane failed',
            })}\n`,
            { flag: 'wx', mode: 0o600 },
          );
        },
        uploadProduct: ({ product }, { wave, waveIndex }) => {
          console.log(
            `Starting ${product} in GitHub release asset wave ${waveIndex + 1}/${plan.waves.length} ` +
              `(${wave.assetCount} assets, ${wave.windowMs}ms bound).`,
          );
          return uploadFrozenReleaseAssets(uploadPlans.get(product), {
            environment: githubReleaseAssetUploadEnvironment(process.env, {
              abortPath,
              windowMs: wave.windowMs,
            }),
          });
        },
      });
    } catch (cause) {
      if (cause?.report !== undefined) {
        writeConcurrentGithubReleaseAssetUploadReport(reportPath, {
          execution: cause.report,
          plan,
          sourceCommit: ACTIVE_PUBLICATION_LOCK.source.commit,
        });
      }
      throw cause;
    }
    writeConcurrentGithubReleaseAssetUploadReport(reportPath, {
      execution,
      plan,
      sourceCommit: ACTIVE_PUBLICATION_LOCK.source.commit,
    });
  } catch (cause) {
    fail(cause instanceof Error ? cause.message : String(cause));
  } finally {
    rmSync(coordinationRoot, { force: true, recursive: true });
  }
}

function releaseEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function publishLockedMavenProducts(products) {
  const prepared = loadPreparedMavenBundle({
    lock: ACTIVE_PUBLICATION_LOCK,
    products,
    outputRoot: path.join(ROOT, 'target/release/maven-central/normal-registry-plan'),
  });
  const deadlineEpochSeconds = registryMutationDeadlineSeconds();
  requirePreMutationRegistryWindow({
    deadlineEpochSeconds,
    minimumMilliseconds: MAVEN_PUBLISH_MINIMUM_WINDOW_MS,
    reserveMilliseconds: REGISTRY_DEADLINE_RESERVE_MS,
    context: `Maven Central atomic deployment for ${products.slice().sort(compareText).join(',')}`,
  });
  const result = await publishFrozenMavenBundle({
    bundle: prepared.bundle,
    lockDigest: ACTIVE_PUBLICATION_LOCK.lockDigest,
    deploymentScope: products.slice().sort(compareText).join(','),
    namespace: releaseEnvironment('MAVEN_CENTRAL_NAMESPACE'),
    username: releaseEnvironment('ORG_GRADLE_PROJECT_mavenCentralUsername'),
    password: releaseEnvironment('ORG_GRADLE_PROJECT_mavenCentralPassword'),
    deadlineEpochSeconds,
  });
  console.log(
    `Maven Central deployment ${result.deploymentId} published exact frozen payloads for ${products.join(', ')}.`,
  );
}

function registryMutationDeadlineSeconds() {
  const raw = process.env.REGISTRY_MUTATION_DEADLINE_EPOCH?.trim();
  if (!raw) {
    throw new Error('REGISTRY_MUTATION_DEADLINE_EPOCH is required for protected registry mutation');
  }
  return parseRegistryMutationDeadline(raw);
}

function registryMutationRemainingMilliseconds(context, minimum = 1) {
  const remaining =
    registryMutationDeadlineSeconds() * 1000 - Date.now() - REGISTRY_DEADLINE_RESERVE_MS;
  if (remaining < minimum) {
    throw new Error(
      `${context} refused with ${Math.max(0, Math.floor(remaining / 1000))}s remaining before the shared registry mutation deadline`,
    );
  }
  return remaining;
}

async function boundedRegistrySleep(milliseconds, context) {
  const remaining = registryMutationRemainingMilliseconds(context);
  if (milliseconds >= remaining) {
    throw new Error(
      `${context} cannot wait ${Math.ceil(milliseconds / 1000)}s before the shared registry mutation deadline`,
    );
  }
  await Bun.sleep(milliseconds);
}

async function exactCargoVersionPublished(
  crateName,
  version,
  { allowMissingIdentity = false, identityCreationOnly = false } = {},
) {
  const inventory = await inspectCratesIoVersionState({
    plan: [{ ecosystem: 'cargo', name: crateName, version }],
    deadlineEpochSeconds: registryMutationDeadlineSeconds(),
  });
  if (inventory.publishedIdentities.length === 1) return true;
  if (identityCreationOnly && inventory.pendingVersions.length > 0) {
    throw new Error(
      `identity bootstrap cannot publish ${crateName} ${version}: Cargo name ${crateName} already exists while the locked exact version is absent`,
    );
  }
  if (inventory.missingNames.length > 0) {
    if (allowMissingIdentity) return false;
    throw new Error(
      `normal trusted publication cannot create missing Cargo identity ${crateName}; run the protected identity bootstrap first`,
    );
  }
  return false;
}

async function cargoPublishLockedCrateExact(
  crateName,
  version,
  suppliedCratePath = undefined,
  {
    alreadyPublished = undefined,
    allowMissingIdentity = false,
    identityCreationOnly = false,
    token = process.env.CARGO_REGISTRY_TOKEN,
    tokenDeadlineEpochMs = undefined,
  } = {},
) {
  let locked;
  locked = lockedCarrierFile(ACTIVE_PUBLICATION_LOCK, 'cargo', crateName, suppliedCratePath);
  if (locked.carrier.version !== version) {
    throw new Error(
      `frozen cargo:${crateName} version ${locked.carrier.version} does not match requested ${version}`,
    );
  }
  const present =
    alreadyPublished ??
    (await exactCargoVersionPublished(crateName, version, {
      allowMissingIdentity,
      identityCreationOnly,
    }));
  if (present) {
    const receipt = await verifyLockedCarrierIntegrity(
      ACTIVE_PUBLICATION_LOCK,
      `cargo:${crateName}`,
    );
    console.log(
      `${crateName} ${version} is already published on crates.io with lock-matching bytes; skipping frozen upload.`,
    );
    return receipt;
  }
  const globalDeadlineEpochMs = registryMutationDeadlineSeconds() * 1000;
  const deadlineEpochMs =
    tokenDeadlineEpochMs === undefined
      ? globalDeadlineEpochMs
      : Math.min(globalDeadlineEpochMs, tokenDeadlineEpochMs);
  const result = await uploadCargoOnceAndReconcileExactVersion({
    crateName,
    version,
    upload: () =>
      publishFrozenCargoCrate({
        cratePath: locked.file,
        expectedName: crateName,
        expectedVersion: version,
        token,
        deadlineEpochMs,
      }),
    // identityCreationOnly protects the pre-mutation TOCTOU check above. Once
    // crates.io has received the immutable upload, the name can legitimately
    // precede its exact version in registry views while indexing converges.
    exactVersionPublished: () =>
      exactCargoVersionPublished(crateName, version, {
        allowMissingIdentity,
        identityCreationOnly: false,
      }),
    waitBeforeNextProbe: () =>
      boundedRegistrySleep(
        10_000,
        `crates.io exact-version visibility wait for ${crateName}@${version}`,
      ),
  });
  const receipt = await verifyLockedCarrierIntegrity(ACTIVE_PUBLICATION_LOCK, `cargo:${crateName}`);
  if (result.reconciledMutationFailure) {
    console.log(
      `${crateName} ${version} became available after an ambiguous upload response; registry bytes match the lock.`,
    );
  }
  return receipt;
}

function lockedCarrierById(carrierId) {
  const matches = lockedCarriers(ACTIVE_PUBLICATION_LOCK).filter(({ id }) => id === carrierId);
  if (matches.length !== 1) {
    throw new Error(`publication lock contains ${matches.length} carriers for ${carrierId}`);
  }
  return matches[0];
}

async function mavenProductPublicationState(product) {
  const result = await queryRegistryPackages(
    lockedCarriers(ACTIVE_PUBLICATION_LOCK, { product, ecosystem: 'maven' }).map(
      ({ name, version }) => ({ kind: 'maven', name, version }),
    ),
  );
  if (result.packages.length === 0) throw new Error('no frozen Maven coordinates for ' + product);
  if (result.missing.length > 0 && result.published.length > 0) {
    throw new Error(
      `${product} has a partial Maven Central publication; refusing to upload a bundle that would overwrite immutable coordinates`,
    );
  }
  return result.missing.length === 0 ? 'published' : 'pending';
}

async function publishNormalMavenOperation(operation) {
  const expected = new Set(operation.carrierIds);
  const actual = lockedCarriers(ACTIVE_PUBLICATION_LOCK, {
    products: operation.products,
    ecosystem: 'maven',
  });
  if (actual.length !== expected.size || actual.some(({ id }) => !expected.has(id))) {
    throw new Error('normal Maven operation does not contain every selected frozen Maven carrier');
  }
  const states = new Map();
  for (const product of operation.products) {
    states.set(product, await mavenProductPublicationState(product));
  }
  const pendingProducts = operation.products.filter((product) => states.get(product) === 'pending');
  if (pendingProducts.length === 0) {
    const receipts = await verifyLockedRegistryIntegrity(ACTIVE_PUBLICATION_LOCK, {
      carrierIds: operation.carrierIds,
    });
    console.log(
      'Every selected Maven coordinate is already published with lock-matching bytes; skipping Maven Central upload.',
    );
    return receipts;
  }
  if (pendingProducts.length !== operation.products.length) {
    const published = operation.products.filter((product) => states.get(product) === 'published');
    throw new Error(
      `selected Maven topology is partially public across products (published: ${published.join(', ')}; pending: ${pendingProducts.join(', ')}); ` +
        'refusing to replace the one atomic exact-lock deployment with product-specific phases',
    );
  }
  await publishLockedMavenProducts(operation.products);
  const visible = await queryRegistryPackages(
    actual.map(({ name, version }) => ({ kind: 'maven', name, version })),
    { retries: 12, retryDelay: 10 },
  );
  if (visible.missing.length > 0) {
    throw new Error(
      'Maven Central publication is not visible: ' +
        visible.missing.map(({ name }) => name).join(', '),
    );
  }
  return await verifyLockedRegistryIntegrity(ACTIVE_PUBLICATION_LOCK, {
    carrierIds: operation.carrierIds,
  });
}

async function publishNormalCarrier(operation, headRef, context, provenReceipts) {
  const carrier = lockedCarrierById(operation.carrierId);
  if (carrier.product !== operation.product || carrier.ecosystem !== operation.ecosystem) {
    throw new Error(`${operation.id} no longer matches its exact frozen carrier`);
  }
  if (provenReceipts.has(carrier.id)) {
    console.log(
      `${carrier.id}@${carrier.version} is covered by the complete immutable bootstrap ledger; skipping redundant registry reconciliation.`,
    );
    return;
  }
  if (carrier.ecosystem === 'cargo') {
    const locked = lockedCarrierFile(ACTIVE_PUBLICATION_LOCK, 'cargo', carrier.name);
    return await cargoPublishLockedCrateExact(carrier.name, carrier.version, locked.file, {
      alreadyPublished: context.alreadyPublished,
      token: context.cargoToken,
      tokenDeadlineEpochMs: context.tokenDeadlineEpochMs,
    });
  }
  throw new Error(`normal registry plan cannot publish unsupported carrier ${carrier.id}`);
}

function requireNormalRegistryProductInputs(products) {
  if (products.includes('oliphaunt-react-native')) {
    requireFrozenProductArtifacts('oliphaunt-react-native', [
      path.join(ROOT, 'target/sdk-artifacts/oliphaunt-react-native'),
      path.join(ROOT, 'target/release/ios-carriers'),
    ]);
  }
  if (products.includes('oliphaunt-kotlin')) {
    requireFrozenArtifacts([stagedKotlinMavenRepo()], {
      products: ['oliphaunt-kotlin'],
      ecosystem: 'maven',
    });
  }
}

async function prepareNormalRegistryPlan(products, headRef) {
  assertPublicationLockSource(ACTIVE_PUBLICATION_LOCK, headRef);
  const plan = normalPublicationPlan(ACTIVE_PUBLICATION_LOCK, products);
  if (plan.carrierCount === 0) {
    writeRegistryReceiptEvidence(REGISTRY_RECEIPT_EVIDENCE_PATH, ACTIVE_PUBLICATION_LOCK, {
      products,
      ecosystems: ['cargo', 'npm', 'maven'],
      receipts: [],
    });
    console.log(
      'Selected release contains no registry carriers; preserved exact empty registry receipt evidence and skipped registry mutation.',
    );
    return;
  }
  requireNormalRegistryProductInputs(products);
  const carrierProducts = [
    ...new Set(plan.operations.flatMap((operation) => operation.products)),
  ].sort(compareText);
  await verifyReleaseTags(carrierProducts, headRef);
  const bootstrapLedger = loadBootstrapLedger(
    BOOTSTRAP_LEDGER_PATH,
    ACTIVE_PUBLICATION_LOCK,
    products,
    {
      allowEmpty: true,
      requireComplete: true,
    },
  );
  const provenReceipts = new Map(
    (bootstrapLedger?.receipts ?? []).map((receipt) => [receipt.id, receipt]),
  );
  const selectedCarrierIds = new Set(
    plan.operations.flatMap((operation) =>
      operation.kind === 'carrier' ? [operation.carrierId] : operation.carrierIds,
    ),
  );
  for (const id of provenReceipts.keys()) {
    if (!selectedCarrierIds.has(id)) {
      throw new Error(
        `complete bootstrap ledger contains ${id}, which is absent from the exact normal publication plan`,
      );
    }
  }
  console.log(
    `Reconciling all ${plan.operations.length} dependency-ordered registry operations ` +
      `for ${plan.carrierCount} exact frozen carriers.`,
  );
  if (provenReceipts.size > 0) {
    console.log(
      `Reusing ${provenReceipts.size} lock-bound Cargo/npm receipts from the complete, preverified bootstrap ledger.`,
    );
  }
  return {
    plan,
    products,
    headRef,
    lockDigest: ACTIVE_PUBLICATION_LOCK.lockDigest,
    initialReceipts: [...provenReceipts.values()],
    schedule: normalPublicationSchedule(plan, process.env.CRATES_IO_TRUSTED_PUBLISH_BATCH_SIZE),
  };
}

function registryOperationResult(directory, operation, result) {
  const file = path.join(directory, 'operation-' + operation.operationOrder + '.json');
  writeFileSync(file + '.tmp', JSON.stringify(result === undefined ? [] : result), {
    flag: 'wx',
    mode: 0o600,
  });
  renameSync(file + '.tmp', file);
}

async function registryPhase() {
  const directory = path.resolve(argv[1]);
  const contextFile = path.join(directory, 'context.json');
  if (command === 'registry-prepare') {
    const unexpected = unexpectedValueFlagArguments(
      argv.slice(2),
      new Set(['--products-json', '--head-ref']),
    );
    if (unexpected.length)
      throw new Error('unsupported registry arguments: ' + unexpected.join(', '));
    const products = parseProductsJson(argv.slice(2));
    const headRef = flagValue(argv.slice(2), '--head-ref') ?? 'HEAD';
    const context = await prepareNormalRegistryPlan(products, headRef);
    // Empty selections still leave a complete plan for the Shell entry point.
    writeFileSync(
      contextFile,
      JSON.stringify(
        context ?? {
          plan: { operations: [], carrierCount: 0 },
          products,
          headRef,
          lockDigest: ACTIVE_PUBLICATION_LOCK.lockDigest,
          initialReceipts: [],
          schedule: { cargoBatches: [], dependencies: [] },
        },
      ),
      { flag: 'wx', mode: 0o600 },
    );
    return;
  }
  const context = JSON.parse(readFileSync(contextFile, 'utf8'));
  if (context.lockDigest !== ACTIVE_PUBLICATION_LOCK.lockDigest)
    throw new Error('registry state belongs to a different publication lock');
  const { plan, products, headRef } = context;
  const proven = new Map(context.initialReceipts.map((receipt) => [receipt.id, receipt]));
  if (command === 'registry-finish') {
    const receipts = collectNormalPublicationReceipts({
      plan,
      initialReceipts: context.initialReceipts,
      operationResults: plan.operations.map((operation) =>
        JSON.parse(
          readFileSync(
            path.join(directory, 'operation-' + operation.operationOrder + '.json'),
            'utf8',
          ),
        ),
      ),
    });
    writeRegistryReceiptEvidence(REGISTRY_RECEIPT_EVIDENCE_PATH, ACTIVE_PUBLICATION_LOCK, {
      products,
      ecosystems: ['cargo', 'npm', 'maven'],
      receipts: [...receipts.values()],
    });
    return;
  }
  const index = Number(argv[2]);
  if (!Number.isSafeInteger(index) || index < 0)
    throw new Error('registry operation index must be a nonnegative integer');
  if (command !== 'registry-npm-after' && existsSync(path.join(directory, 'abort')))
    throw new Error('peer registry lane failed; stopping admission');
  if (command === 'registry-cargo') {
    const batch = context.schedule.cargoBatches[index];
    if (!batch) throw new Error('unknown Cargo batch');
    await executeCargoPublicationBatch({
      operations: batch.map((order) => plan.operations[order]),
      isAborted: () => existsSync(path.join(directory, 'abort')),
      cargoVersionPublished: async (operation) => {
        if (proven.has(operation.carrierId)) return true;
        const carrier = lockedCarrierById(operation.carrierId);
        return await exactCargoVersionPublished(carrier.name, carrier.version);
      },
      publishCarrier: async (operation, tokenContext) =>
        registryOperationResult(
          directory,
          operation,
          await publishNormalCarrier(operation, headRef, tokenContext, proven),
        ),
    });
    return;
  }
  const operation = plan.operations[index];
  if (!operation) throw new Error('unknown registry operation');
  if (command === 'registry-maven') {
    if (operation.ecosystem !== 'maven') throw new Error('expected a Maven operation');
    registryOperationResult(directory, operation, await publishNormalMavenOperation(operation));
    return;
  }
  if (operation.ecosystem !== 'npm') throw new Error('expected an npm operation');
  const carrier = lockedCarrierById(operation.carrierId);
  const admissionFile = path.join(directory, 'npm-' + index + '.json');
  if (command === 'registry-npm-before') {
    if (proven.has(carrier.id)) {
      registryOperationResult(directory, operation);
      return;
    }
    const locked = lockedCarrierFile(ACTIVE_PUBLICATION_LOCK, 'npm', carrier.name);
    const prepared = await prepareFrozenNpmPublication({
      packageName: carrier.name,
      version: carrier.version,
      tarball: locked.file,
      deadlineEpochSeconds: registryMutationDeadlineSeconds(),
    });
    if (prepared.skipped)
      registryOperationResult(
        directory,
        operation,
        await verifyLockedCarrierIntegrity(ACTIVE_PUBLICATION_LOCK, carrier.id),
      );
    else writeFileSync(admissionFile, JSON.stringify(prepared), { flag: 'wx', mode: 0o600 });
  } else {
    // Reconciliation is mandatory even if npm returned an ambiguous failure.
    const prepared = JSON.parse(readFileSync(admissionFile, 'utf8'));
    await reconcileFrozenNpmPublication(prepared);
    registryOperationResult(
      directory,
      operation,
      await verifyLockedCarrierIntegrity(ACTIVE_PUBLICATION_LOCK, carrier.id),
    );
  }
}

if (registryPhases.has(command)) {
  try {
    await registryPhase();
  } catch (cause) {
    if (isRegistryPublicationDeferredError(cause)) exitTypedRegistryDeferral(cause);
    throw cause;
  }
  process.exit(0);
}

async function bootstrapPhase() {
  if (!BOOTSTRAP_IDENTITIES)
    throw new Error('bootstrap phases require explicit identity bootstrap mode');
  const directory = path.resolve(argv[1]);
  const context = JSON.parse(readFileSync(path.join(directory, 'context.json'), 'utf8'));
  if (context.lockDigest !== ACTIVE_PUBLICATION_LOCK.lockDigest)
    throw new Error('bootstrap state belongs to another publication lock');
  const index = Number(argv[2]);
  if (!Number.isSafeInteger(index) || index < 0 || !context.admittedPlan[index])
    throw new Error('unknown bootstrap operation');
  if (command !== 'bootstrap-npm-after' && existsSync(path.join(directory, 'abort')))
    throw new Error('peer bootstrap lane stopped admission');
  const carrier = lockedCarrierById(context.admittedPlan[index].id);
  const operation = { operationOrder: index };
  if (command === 'bootstrap-cargo') {
    if (carrier.ecosystem !== 'cargo') throw new Error('expected a Cargo bootstrap operation');
    registryOperationResult(
      directory,
      operation,
      await cargoPublishLockedCrateExact(carrier.name, carrier.version, undefined, {
        allowMissingIdentity: true,
        identityCreationOnly: true,
      }),
    );
    return;
  }
  if (carrier.ecosystem !== 'npm') throw new Error('expected an npm bootstrap operation');
  const admission = path.join(directory, 'npm-' + index + '.json');
  if (command === 'bootstrap-npm-before') {
    const locked = lockedCarrierFile(ACTIVE_PUBLICATION_LOCK, 'npm', carrier.name);
    const prepared = await prepareFrozenNpmPublication({
      packageName: carrier.name,
      version: carrier.version,
      tarball: locked.file,
      deadlineEpochSeconds: registryMutationDeadlineSeconds(),
      identityCreationOnly: true,
    });
    if (prepared.skipped)
      registryOperationResult(
        directory,
        operation,
        await verifyLockedCarrierIntegrity(ACTIVE_PUBLICATION_LOCK, carrier.id),
      );
    else writeFileSync(admission, JSON.stringify(prepared), { flag: 'wx', mode: 0o600 });
  } else {
    await reconcileFrozenNpmPublication(JSON.parse(readFileSync(admission, 'utf8')));
    registryOperationResult(
      directory,
      operation,
      await verifyLockedCarrierIntegrity(ACTIVE_PUBLICATION_LOCK, carrier.id),
    );
  }
}

if (bootstrapPhases.has(command)) {
  try {
    await bootstrapPhase();
  } catch (cause) {
    if (isRegistryPublicationDeferredError(cause)) exitTypedRegistryDeferral(cause);
    throw cause;
  }
  process.exit(0);
}

const publishProductStep = publishProductStepPlan(argv.slice(1));
const normalRegistryPlanSelected = argv.slice(1).includes('--registry-plan');
if (BOOTSTRAP_IDENTITIES)
  fail('use bash .github/scripts/bootstrap-registry-identities.sh for bootstrap');
if (normalRegistryPlanSelected) {
  fail('use bash tools/release/publish-registries.sh for registry publication');
}
if (
  command === 'publish' &&
  flagValue(argv.slice(1), '--step') === 'github-release-assets' &&
  flagValue(argv.slice(1), '--product') === null
) {
  const requested = parseProductsJson(argv.slice(1));
  if (requested !== null) {
    await publishSelectedGithubReleaseAssetSets(
      releaseOrderedProducts(requested),
      flagValue(argv.slice(1), '--head-ref') ?? 'HEAD',
    );
    process.exit(0);
  }
}

fail(`unsupported publish arguments: ${argv.slice(1).join(' ') || '<none>'}`);
