/** Capture final WASIX core and bounded host-smoke Cargo inputs from one invocation. */
import {
  copyFileSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  AOT_PACKAGES,
  RUNTIME_PACKAGE,
} from '../../src/wasix/runtime/tools/wasix-cargo-artifact-contract.mts';
import { requireSafeDirectoryChain } from '../../tools/packaging/release-directory-safety.mts';
import { buildShippingInputView } from '../../tools/release/bazel-shipping-inputs.mts';
import {
  type NativeRoot,
  nativeOutputPath,
} from '../../tools/release/native-publication-artifacts.mts';
import type { NativeCandidateCohort } from '../../tools/release/native-publication-candidate.mts';
import { captureNativePublicationOutputs } from '../../tools/release/native-publication-staging.mts';
import {
  loadPublicationCatalog,
  resolveActualCarrier,
} from '../../tools/release/publication-catalog.mts';
import { sourceIdentity } from '../../tools/release/publication-lock.mts';
import { ROOT } from '../../tools/release/release-graph.mts';
import {
  type CargoInput,
  wasixHostSmokeCargoIdentities,
  wasixRuntimeCargoParent,
  writeWasixCargoConstructionReceipt,
} from './cargo-inputs.mts';

const PRODUCT = 'liboliphaunt-wasix';
const TARGETS = new Map([
  [RUNTIME_PACKAGE, 'portable'],
  ...Object.entries(AOT_PACKAGES).map(([target, name]) => [name, target]),
]);

function targetDirectory(relative: string) {
  if (
    typeof relative !== 'string' ||
    !relative.startsWith('target/') ||
    relative.includes('\\') ||
    /[\u0000-\u001f\u007f]/u.test(relative) ||
    relative.normalize('NFC') !== relative ||
    relative.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('WASIX Cargo capture destination must be a safe path under target/');
  return path.join(ROOT, relative);
}

function cargoFiles(file: string): string[] {
  const stat = lstatSync(file);
  if (stat.isSymbolicLink()) throw new Error('WASIX Cargo output cannot contain symbolic links');
  if (stat.isDirectory())
    return readdirSync(file)
      .sort()
      .flatMap((name) => cargoFiles(path.join(file, name)));
  if (!stat.isFile() || !file.endsWith('.crate'))
    throw new Error(`WASIX Cargo output must contain only regular .crate files: ${file}`);
  return [file];
}

/**
 * The caller captures cquery roots, their complete aquery closure, and execroot
 * from one source/configuration. This copies observed final files; it does not
 * certify qualification, completed-publication equivalence, or a release lock.
 */
export function captureWasixCargoConstructionInputs({
  cohorts,
  outputDirectory,
  headRef = 'HEAD',
}: {
  cohorts: NativeCandidateCohort[];
  outputDirectory: string;
  headRef?: string;
}) {
  const source = sourceIdentity(headRef);
  const catalog = loadPublicationCatalog('WASIX Cargo construction capture', {
    products: [PRODUCT, 'postgres-tools-wasix'],
  });
  const runtimeVersion = Bun.TOML.parse(
    readFileSync(path.join(ROOT, 'src/wasix/runtime/crates/assets/Cargo.toml'), 'utf8'),
  ).package.version;
  const targets = new Map([
    ...TARGETS,
    ...wasixHostSmokeCargoIdentities(ROOT, runtimeVersion).map(
      (row) => [row.name, row.target] as const,
    ),
  ]);
  const carriers = new Map(
    catalog.carriers
      .filter((carrier) => carrier.ecosystem === 'cargo' && targets.has(carrier.name))
      .map((carrier) => [carrier.name, carrier]),
  );
  if (carriers.size !== targets.size || [...targets.keys()].some((name) => !carriers.has(name)))
    throw new Error(
      'WASIX Cargo capture must match the core and contrib/tools publication carriers',
    );
  const identify = (file: string) => {
    for (const parent of carriers.values()) {
      const suffix = `-${parent.version}.crate`;
      if (!path.basename(file).endsWith(suffix)) continue;
      const name = path.basename(file).slice(0, -suffix.length);
      if (name !== parent.name && !name.startsWith(`${parent.name}-part-`)) continue;
      if (name !== parent.name && wasixRuntimeCargoParent(name) !== parent.name) continue;
      const actual = resolveActualCarrier(catalog, 'cargo', name, 'WASIX Cargo capture');
      if (actual.id !== parent.id && actual.parentCarrier !== parent.id) continue;
      return { file, name, target: targets.get(parent.name)!, parent: parent.name };
    }
    throw new Error(`unexpected WASIX Cargo file: ${file}`);
  };
  if (!Array.isArray(cohorts) || !cohorts.length)
    throw new Error('WASIX Cargo capture requires actual configured physical cohorts');
  const seen = new Set<string>();
  for (const cohort of cohorts) {
    if (cohort.source?.commit !== source.commit || cohort.source?.tree !== source.tree)
      throw new Error('WASIX Cargo cohort differs from the exact captured source');
    if (!Array.isArray(cohort.roots) || !cohort.roots.length)
      throw new Error('WASIX Cargo cohort requires actual shipping roots');
    for (const root of cohort.roots as NativeRoot[]) {
      const pkg = root.package;
      const carrier = carriers.get(pkg?.name);
      if (
        !carrier ||
        seen.has(pkg.name) ||
        pkg.product !== carrier.product ||
        pkg.ecosystem !== 'cargo' ||
        pkg.version !== carrier.version ||
        pkg.role !== carrier.role ||
        pkg.configuration !== targets.get(pkg.name) ||
        pkg.outputs?.length !== 1
      )
        throw new Error(`WASIX Cargo root differs from its canonical final carrier: ${root.label}`);
      const files = cargoFiles(nativeOutputPath(cohort.executionRoot, pkg.outputs[0].path)).map(
        identify,
      );
      if (
        !files.some((file) => file.name === pkg.name) ||
        files.some((file) => file.parent !== pkg.name)
      )
        throw new Error(`WASIX Cargo root contains an unrelated or missing parent: ${root.label}`);
      seen.add(pkg.name);
    }
    buildShippingInputView(
      {
        schema: 'oliphaunt-bazel-shipping-v1',
        scope: 'construction',
        packages: (cohort.roots as NativeRoot[]).map((root) => root.package),
      },
      cohort.aquery,
    );
  }
  if (seen.size !== carriers.size)
    throw new Error('WASIX Cargo capture is missing a canonical final carrier');

  const staged = captureNativePublicationOutputs(cohorts, { sourceCommit: source.commit }).stage();
  const inputs: CargoInput[] = staged
    .flatMap(cargoFiles)
    .map(identify)
    .map(({ file, name, target }) => ({ file, name, target }));
  const receiptOptions = {
    sourceCommit: source.commit,
    sourceTree: source.tree,
    releaseManifest: path.join(ROOT, 'src/wasix/runtime/release.toml'),
    toolchainManifest: path.join(ROOT, 'src/wasix/runtime/toolchain.toml'),
    cargoLock: path.join(ROOT, 'Cargo.lock'),
    versionManifest: path.join(ROOT, 'src/wasix/runtime/crates/assets/Cargo.toml'),
    sourceRoot: ROOT,
  };
  const receiptFor = (values: CargoInput[]) =>
    writeWasixCargoConstructionReceipt(
      values.filter((row) => wasixRuntimeCargoParent(row.name) !== undefined),
      {
        ...receiptOptions,
        hostSmokeInputs: values.filter((row) => wasixRuntimeCargoParent(row.name) === undefined),
      },
    );
  const captured = receiptFor(inputs);
  const destination = targetDirectory(outputDirectory);
  const parent = requireSafeDirectoryChain(path.dirname(destination), {
    create: true,
    label: 'WASIX Cargo capture',
  });
  const temporary = mkdtempSync(path.join(parent, '.wasix-cargo-capture-'));
  try {
    const copied = inputs.map((input) => {
      const file = path.join(temporary, path.basename(input.file));
      copyFileSync(input.file, file);
      return { ...input, file };
    });
    const receipt = receiptFor(copied);
    if (
      JSON.stringify(receipt) !== JSON.stringify(captured) ||
      JSON.stringify(receiptFor(inputs)) !== JSON.stringify(captured)
    )
      throw new Error('WASIX Cargo files changed while copying captured construction inputs');
    writeFileSync(path.join(temporary, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
    // A prior receipt directory is never overwritten by a new construction.
    try {
      lstatSync(destination);
      throw new Error('WASIX Cargo capture destination already exists');
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
    }
    renameSync(temporary, destination);
    return { directory: destination, receipt };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [cohortsFile, outputDirectory, headRef = 'HEAD', ...extra] = process.argv.slice(2);
  if (!cohortsFile || !outputDirectory || extra.length)
    throw new Error('usage: capture-cargo.mts COHORTS_JSON target/OUTPUT_DIRECTORY [HEAD_REF]');
  const result = captureWasixCargoConstructionInputs({
    cohorts: JSON.parse(readFileSync(cohortsFile, 'utf8')),
    outputDirectory,
    headRef,
  });
  console.log(JSON.stringify(result));
}
