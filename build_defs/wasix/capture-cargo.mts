/** Capture only the five declared final WASIX Cargo files for construction consumers. */
import {
  copyFileSync,
  lstatSync,
  mkdtempSync,
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
import type { NativeRoot } from '../../tools/release/native-publication-artifacts.mts';
import type { NativeCandidateCohort } from '../../tools/release/native-publication-candidate.mts';
import { captureNativePublicationOutputs } from '../../tools/release/native-publication-staging.mts';
import { loadPublicationCatalog } from '../../tools/release/publication-catalog.mts';
import { sourceIdentity } from '../../tools/release/publication-lock.mts';
import { ROOT } from '../../tools/release/release-graph.mts';
import { type CargoInput, writeWasixCargoConstructionReceipt } from './cargo-inputs.mts';

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
    products: [PRODUCT],
  });
  const carriers = new Map(
    catalog.carriers
      .filter((carrier) => carrier.ecosystem === 'cargo' && TARGETS.has(carrier.name))
      .map((carrier) => [carrier.name, carrier]),
  );
  if (carriers.size !== TARGETS.size || [...TARGETS.keys()].some((name) => !carriers.has(name)))
    throw new Error('WASIX Cargo capture must match the five canonical publication carriers');
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
        pkg.product !== PRODUCT ||
        pkg.ecosystem !== 'cargo' ||
        pkg.version !== carrier.version ||
        pkg.role !== carrier.role ||
        pkg.configuration !== TARGETS.get(pkg.name) ||
        pkg.outputs?.length !== 1 ||
        path.posix.basename(pkg.outputs[0].path) !== `${pkg.name}-${pkg.version}.crate`
      )
        throw new Error(`WASIX Cargo root differs from its canonical final carrier: ${root.label}`);
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
  const inputs: CargoInput[] = staged.map((file) => {
    if (!lstatSync(file).isFile())
      throw new Error('WASIX Cargo capture requires final regular Files');
    const name = [...carriers.keys()].find(
      (candidate) =>
        path.basename(file) === `${candidate}-${carriers.get(candidate)?.version}.crate`,
    );
    if (!name) throw new Error(`unexpected staged WASIX Cargo file: ${file}`);
    const target = TARGETS.get(name);
    if (!target) throw new Error(`staged WASIX Cargo file has no canonical target: ${file}`);
    return { file, name, target };
  });
  const receiptOptions = {
    sourceCommit: source.commit,
    sourceTree: source.tree,
    releaseManifest: path.join(ROOT, 'src/wasix/runtime/release.toml'),
    toolchainManifest: path.join(ROOT, 'src/wasix/runtime/toolchain.toml'),
    cargoLock: path.join(ROOT, 'Cargo.lock'),
    versionManifest: path.join(ROOT, 'src/wasix/runtime/crates/assets/Cargo.toml'),
  };
  const captured = writeWasixCargoConstructionReceipt(inputs, receiptOptions);
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
    const receipt = writeWasixCargoConstructionReceipt(copied, receiptOptions);
    if (
      JSON.stringify(receipt) !== JSON.stringify(captured) ||
      JSON.stringify(writeWasixCargoConstructionReceipt(inputs, receiptOptions)) !==
        JSON.stringify(captured)
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
