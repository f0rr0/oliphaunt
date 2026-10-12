/** Typed configured supplier Files; this projection cannot admit a publication. */

import path from 'node:path';
import {
  buildShippingInputView,
  canonicalShippingLabel,
  isNativeAppleBaseInputRoot,
  type NativeShippingSupplier,
  validateNativeShippingSuppliers,
} from './bazel-shipping-inputs.mts';
import type { NativeBuildSource } from './native-build-qualification.mts';
import {
  captureCompletedNativePublicArtifacts,
  captureCompletedNativeRegistryCarriers,
  captureCompletedNativeSwiftSourceSuppliers,
  nativeArchiveDeliveryMembers,
} from './native-completed-delivery.mts';
import { fileIdentity } from './native-file-identity.mts';
import { captureCompletedNativeArchiveDelivery } from './native-publication-delivery.mts';
import type { observeNativePublicationConstruction } from './native-publication-observation.mts';
import { consumerDigest } from './publication-consumer-proof.mts';
import { resolveBuildBoundCompatibilityProducts } from './release-dependency-plan.mts';

export type { NativeShippingSupplier } from './bazel-shipping-inputs.mts';

type Observation = Awaited<ReturnType<typeof observeNativePublicationConstruction>>;
type CompletedInput =
  | Parameters<typeof captureCompletedNativeArchiveDelivery>[0]
  | Parameters<typeof captureCompletedNativePublicArtifacts>[0]
  | Parameters<typeof captureCompletedNativeRegistryCarriers>[0]
  | Parameters<typeof captureCompletedNativeSwiftSourceSuppliers>[0];
const authenticateCompletedSupplier = (input: CompletedInput) =>
  'sourceTags' in input
    ? captureCompletedNativeSwiftSourceSuppliers(input)
    : 'carriers' in input
      ? captureCompletedNativeRegistryCarriers(input)
      : Array.isArray(input.files)
        ? captureCompletedNativeArchiveDelivery(
            input as Parameters<typeof captureCompletedNativeArchiveDelivery>[0],
          )
        : captureCompletedNativePublicArtifacts(
            input as Parameters<typeof captureCompletedNativePublicArtifacts>[0],
          );

/** Only these canonical original Swift documents are data/ABI construction inputs. */
function swiftSourceDocument(root, member: string | undefined) {
  const pkg = root.package;
  if (
    pkg.product !== 'oliphaunt-swift' ||
    pkg.ecosystem !== 'github' ||
    pkg.role !== 'release-input' ||
    pkg.configuration !== 'portable' ||
    pkg.outputs.length !== 1 ||
    !pkg.outputs[0].path.startsWith('bazel-out/')
  )
    return false;
  const name = canonicalShippingLabel(root.label);
  return (
    (name === '//src/native/sdks/swift:shipping_oliphaunt-react-native-ios-carriers_json' &&
      pkg.name === 'oliphaunt-react-native-ios-carriers.json' &&
      pkg.outputs[0].path.endsWith('/source_package/release-tree') &&
      member === 'src/sdks/swift/Carriers/oliphaunt-react-native-ios-carriers.json') ||
    (name === '//src/native/sdks/swift:shipping_extension-owner-catalog_json' &&
      pkg.name === 'extension-owner-catalog.json' &&
      pkg.outputs[0].path.endsWith(
        '/source_package/extension-generator/extension-owner-catalog.json',
      ) &&
      member === undefined)
  );
}

function swiftSourceArchive(root, member: string | undefined) {
  const pkg = root.package;
  return (
    canonicalShippingLabel(root.label) ===
      '//src/native/sdks/swift:shipping_Oliphaunt-source_zip' &&
    pkg.product === 'oliphaunt-swift' &&
    pkg.ecosystem === 'github' &&
    pkg.role === 'release-input' &&
    pkg.configuration === 'portable' &&
    pkg.name === 'Oliphaunt-source.zip' &&
    member === undefined &&
    pkg.outputs.length === 1 &&
    pkg.outputs[0].path.startsWith('bazel-out/') &&
    pkg.outputs[0].path.endsWith('/source_package/Oliphaunt-source.zip')
  );
}

function equal(actual: unknown, expected: unknown, context: string) {
  if (consumerDigest(actual) !== consumerDigest(expected))
    throw new Error(`native suppliers: ${context} mismatch`);
}
function exactSource(source: NativeBuildSource) {
  if (
    !source ||
    Object.keys(source).sort().join(',') !== 'commit,tree' ||
    ![source.commit, source.tree].every((value) => /^[a-f0-9]{40}$/u.test(value))
  )
    throw new Error('native suppliers require an exact source commit and tree');
}

/**
 * Consume an existing authenticated observation, never raw aquery as authority.
 * Each package explicitly reports its supplier Files through the producing
 * ShippingInfo manifest. Missing coverage returns no map. A completed supplier
 * is independently reauthenticated using the retained archive/completion reader;
 * historical labels or actions are neither required nor invented.
 *
 * This is a structural construction projection. The existing native admission
 * guard and complete product-specific qualification policy remain external.
 */
export async function projectNativeBuildBoundSuppliers(
  {
    products,
    source,
    observation,
    completed = [],
  }: {
    products: Record<string, { version: string }>;
    source: NativeBuildSource;
    observation: Observation;
    completed?: CompletedInput[];
  },
  { authenticateCompleted = authenticateCompletedSupplier } = {},
) {
  exactSource(source);
  const ids = Object.keys(products).sort();
  if (!ids.length) throw new Error('native suppliers require explicit product inventory');
  equal(
    observation.products.map(({ product }) => product.id).sort(),
    ids,
    'observed product inventory',
  );
  const unknowns = new Set<string>();
  if (!observation.coverage.completeProductInventory)
    unknowns.add('incomplete configured product inventory');
  if (!observation.authenticated.length) unknowns.add('missing authenticated producing builds');
  const covered = new Set<string>();
  const records: (NativeShippingSupplier & {
    consumer: string;
    root: string;
    consumerConfiguration: string;
    rootConfiguration: string;
  })[] = [];
  const pending: {
    supplier: NativeShippingSupplier;
    files: { declaration: NativeShippingSupplier['files'][number]; member: any }[];
  }[] = [];
  const imported: typeof pending = [];
  for (const build of observation.authenticated) {
    equal(build.evidence.source, source, 'producing evidence source');
    equal(build.qualification.source, source, 'qualified source');
    equal(build.origin.github, build.qualification.github, 'authenticated producing context');
    if (
      build.qualification.testQualification !== 'passed' ||
      !build.qualification.requiredTests.length ||
      build.qualification.shippingAnalysis !== 'bound'
    )
      unknowns.add('unbound producing analysis or configured qualification');
    for (const cohort of build.evidence.cohorts) {
      const rootConfigurations = new Map(
        cohort.rootConfigurations.map(({ label, configuration }) => [
          canonicalShippingLabel(label),
          configuration,
        ]),
      );
      const captures = new Map(cohort.inputs.map((capture) => [capture.path, capture]));
      const roots = new Map(cohort.roots.map((root) => [root.package, root]));
      const producerRoots: {
        product: string;
        configuration: string;
        outputs: Set<string>;
        consumes: (path: string) => boolean;
      }[] = [];
      const currentSuppliers: NativeShippingSupplier[] = [];
      buildShippingInputView(
        {
          schema: 'oliphaunt-bazel-shipping-v1',
          scope: 'construction',
          packages: cohort.roots.map((root) => root.package),
        },
        cohort.aquery,
        {
          inspectPackageInputs(pkg, consumes) {
            const root = roots.get(pkg as any)!;
            const consumer = root.package.product;
            const label = canonicalShippingLabel(root.label);
            if (!Object.hasOwn(products, consumer) || !rootConfigurations.has(label))
              throw new Error('native supplier root has unknown product/configuration');
            equal(root.package.version, products[consumer].version, 'consumer version');
            covered.add(consumer);
            // Candidate control/metadata Files are not the core's delivery roots.
            if (
              !isNativeAppleBaseInputRoot(root) &&
              root.package.role !== 'release-input' &&
              (root.package.ecosystem !== 'github' || root.package.role === 'github-release-asset')
            )
              producerRoots.push({
                product: consumer,
                configuration: root.package.configuration,
                outputs: new Set(root.package.outputs.map(({ path }) => path)),
                consumes,
              });
            const supplied = (pkg as any).supplierInputs;
            if (supplied === undefined) {
              unknowns.add(`missing supplier coverage: ${label}@${rootConfigurations.get(label)}`);
              return;
            }
            if (!Array.isArray(supplied))
              throw new Error('native supplier coverage must be an explicit array');
            for (const supplier of validateNativeShippingSuppliers(supplied)) {
              if (!Object.hasOwn(products, supplier.product))
                throw new Error('native supplier has unknown product');
              const files = supplier.files.map((declaration) => {
                const name = declaration.path;
                if (!consumes(name))
                  throw new Error(`native supplier File is not consumed by ${label}: ${name}`);
                const capture = captures.get(name);
                const member = capture?.members[0];
                if (
                  capture?.members.length !== 1 ||
                  member?.path !== '' ||
                  member.type !== 'file' ||
                  !/^[a-f0-9]{64}$/u.test(member.sha256) ||
                  !Number.isSafeInteger(member.size) ||
                  member.size < 0
                )
                  throw new Error('native supplier must be an exact captured regular File');
                return { declaration, member: structuredClone(member) };
              });
              if (supplier.origin?.kind === 'current-source') {
                // Current Files belong to the authenticated producing cohort.
                // Putting its Git SHA in analysis metadata would add a false input.
                equal(
                  supplier.version,
                  products[supplier.product].version,
                  'current supplier version',
                );
                if (supplier.origin.producer) imported.push({ supplier, files });
                else if (supplier.binding === 'compiled-input')
                  for (const { path } of supplier.files)
                    if (path.startsWith('external/'))
                      unknowns.add('unverified current supplier producer transport');
                    else if (!path.startsWith('bazel-out/'))
                      throw new Error(
                        'current compiled supplier requires an actual generated File',
                      );
                currentSuppliers.push(supplier);
              } else if (supplier.origin?.kind === 'completed-publication') {
                pending.push({ supplier, files });
              } else throw new Error('native supplier requires an explicit physical origin');
              records.push({
                ...supplier,
                consumer,
                root: label,
                consumerConfiguration: root.package.configuration,
                rootConfiguration: rootConfigurations.get(label)!,
              });
            }
          },
        },
      );
      for (const supplier of currentSuppliers) {
        if (supplier.origin.kind === 'current-source' && supplier.origin.producer) continue;
        const configured = producerRoots.filter(
          (root) =>
            root.product === supplier.product && root.configuration === supplier.configuration,
        );
        for (const file of supplier.files) {
          if (supplier.binding === 'compiled-input' && file.path.startsWith('external/')) continue;
          if (!configured.length)
            throw new Error('current supplier lacks its own configured shipping producer');
          if (
            supplier.binding === 'compiled-input' &&
            !configured.some((root) => root.outputs.has(file.path) || root.consumes(file.path))
          )
            throw new Error('current supplier File lacks its own configured shipping producer');
        }
      }
    }
  }
  for (const id of ids) if (!covered.has(id)) unknowns.add(`missing configured consumer: ${id}`);
  for (const { supplier, files } of imported) {
    if (supplier.origin.kind !== 'current-source' || !supplier.origin.producer) continue;
    const producer = supplier.origin.producer;
    const builds = observation.authenticated.filter(
      ({ origin }) => origin.evidenceDigest === producer.evidenceDigest,
    );
    if (!builds.length) {
      unknowns.add('missing authenticated original current supplier producer');
      continue;
    }
    if (builds.length !== 1) throw new Error('ambiguous original current supplier producer');
    const original = builds[0];
    const cohorts = original.evidence.cohorts
      .map((cohort, index) => ({ cohort, index }))
      .filter(
        ({ index }) =>
          original.qualification.cohorts?.[index]?.invocationId === producer.invocationId,
      );
    if (cohorts.length !== 1) throw new Error('current supplier original invocation mismatch');
    const { cohort, index } = cohorts[0];
    const roots = cohort.roots.filter(
      ({ label }) => canonicalShippingLabel(label) === canonicalShippingLabel(producer.root),
    );
    if (roots.length !== 1) throw new Error('current supplier original root mismatch');
    const root = roots[0];
    const configurations = cohort.rootConfigurations.filter(
      ({ label }) => canonicalShippingLabel(label) === canonicalShippingLabel(root.label),
    );
    if (configurations.length !== 1 || configurations[0].configuration !== producer.configuration)
      throw new Error('current supplier original configured root mismatch');
    equal(
      {
        product: root.package.product,
        version: root.package.version,
        configuration: root.package.configuration,
      },
      {
        product: supplier.product,
        version: supplier.version,
        configuration: supplier.configuration,
      },
      'original current supplier identity',
    );
    const appleBase = isNativeAppleBaseInputRoot(root);
    const document = appleBase || swiftSourceDocument(root, producer.member);
    const sourceArchive = swiftSourceArchive(root, producer.member);
    const dataInput = document || sourceArchive;
    if (
      (canonicalShippingLabel(root.label) ===
        '//src/native/sdks/swift:shipping_Oliphaunt-source_zip' &&
        !sourceArchive) ||
      (!dataInput &&
        (!['cargo', 'npm', 'github'].includes(root.package.ecosystem) ||
          (root.package.ecosystem === 'github' && root.package.role !== 'github-release-asset'))) ||
      (dataInput &&
        (supplier.binding !== 'abi-contract' ||
          (appleBase && producer.member !== undefined) ||
          files.some(({ declaration }) => declaration.member !== undefined))) ||
      root.package.outputs.filter(({ path }) => path === producer.output).length !== 1
    )
      throw new Error('current supplier requires its original public final archive');
    const outputs = cohort.outputs.filter(({ path }) => path === producer.output);
    const outputRoot = outputs[0]?.members[0];
    const membersAtPath =
      producer.member === undefined
        ? outputs[0]?.members
        : outputs[0]?.members.filter(({ path }) => path === producer.member);
    const output = membersAtPath?.[0];
    if (
      outputs.length !== 1 ||
      membersAtPath?.length !== 1 ||
      output?.type !== 'file' ||
      (producer.member === undefined
        ? output.path !== ''
        : outputRoot?.path !== '' || outputRoot.type !== 'directory')
    )
      throw new Error('current supplier original output must be a captured regular archive');
    if (
      producer.member !== undefined &&
      root.package.ecosystem === 'github' &&
      path.posix.basename(producer.member) !== root.package.name
    )
      throw new Error(
        'current supplier original Tree leaf differs from its canonical GitHub identity',
      );
    const outputPath =
      producer.member === undefined ? producer.output : `${producer.output}/${producer.member}`;
    const transport = original.origin.finalFiles;
    if (!transport || !('artifactRoots' in transport)) {
      unknowns.add('missing authenticated original current supplier transport');
      continue;
    }
    const captured = transport.files.filter(
      (file) => file.cohort === index && file.path === outputPath,
    );
    if (captured.length !== 1)
      throw new Error('current supplier original transported output mismatch');
    equal(
      { size: captured[0].size, sha256: captured[0].sha256 },
      { size: output.size, sha256: output.sha256 },
      'original current supplier output bytes',
    );
    const suffix = `/${index}/${outputPath}`;
    const archives = transport.artifactRoots.filter((file) =>
      path.resolve(file).split(path.sep).join('/').endsWith(suffix),
    );
    if (archives.length !== 1)
      throw new Error('current supplier original archive transport mismatch');
    transport.assertUnchanged?.();
    const before = fileIdentity(archives[0]);
    equal(
      { size: before.size, sha256: before.sha256 },
      { size: output.size, sha256: output.sha256 },
      'original current supplier physical archive',
    );
    const members = document ? [] : nativeArchiveDeliveryMembers(archives[0]);
    equal(fileIdentity(archives[0]), before, 'original current supplier archive after read');
    transport.assertUnchanged?.();
    for (const { declaration, member } of files) {
      if (supplier.binding === 'abi-contract' && declaration.member === undefined) {
        equal(
          { sha256: member.sha256, size: member.size },
          { sha256: output.sha256, size: output.size },
          'captured supplier/original current outer archive bytes',
        );
        continue;
      }
      const published = members.filter((value) => value.path === declaration.member);
      if (published.length !== 1 || published[0].type !== 'file')
        throw new Error('current supplier requires its exact original regular archive member');
      equal(
        { sha256: member.sha256, size: member.size },
        { sha256: published[0].sha256, size: published[0].size },
        'captured supplier/original current member bytes',
      );
    }
  }
  const origins = new Map<string, ReturnType<typeof authenticateCompleted>>();
  for (const { supplier, files } of pending) {
    if (supplier.origin.kind !== 'completed-publication') continue;
    const publication = supplier.origin.publication;
    const matches = completed.filter((input) => {
      if (consumerDigest(input.publication) !== consumerDigest(publication)) return false;
      const artifact = supplier.origin.artifact;
      if (
        'sourceTags' in input &&
        input.sourceTags.some(
          (row) =>
            row.artifact === artifact &&
            consumerDigest(row.publication) === consumerDigest(publication),
        )
      )
        return true;
      if ('carriers' in input && input.carriers && Object.hasOwn(input.carriers, artifact))
        return true;
      if (!('files' in input)) return false;
      if (!Array.isArray(input.files))
        return (
          Object.hasOwn(input.files, artifact) ||
          Object.hasOwn(input.files, `github-release:${artifact}`)
        );
      return input.files.some(
        ({ target, file }) =>
          target === supplier.configuration &&
          [path.basename(file), `github-release:${path.basename(file)}`].includes(artifact),
      );
    });
    if (matches.length > 1) throw new Error('ambiguous completed supplier archive input');
    if (!matches.length) {
      unknowns.add(`missing completed supplier bytes: ${supplier.product}@${supplier.version}`);
      continue;
    }
    if (
      'files' in matches[0] &&
      Array.isArray(matches[0].files) &&
      !['liboliphaunt-native', 'postgres-tools-native'].includes(supplier.product)
    ) {
      unknowns.add(`unsupported completed supplier contract: ${supplier.product}`);
      continue;
    }
    const key = consumerDigest(matches[0]);
    if (!origins.has(key)) origins.set(key, authenticateCompleted(structuredClone(matches[0])));
    const origin = await origins.get(key)!;
    equal(origin.publication, publication, 'authenticated completed supplier');
    if ('unknowns' in origin)
      // Unconsumed target Files are not required for this supplier binding.
      // A historical declaration/inventory mismatch remains genuinely unknown.
      for (const unknown of origin.unknowns)
        if (!unknown.startsWith('completed-public-artifact-missing:'))
          unknowns.add(`completed supplier origin: ${unknown}`);
    const archives = origin.archives.filter(
      (archive) =>
        (archive.id === supplier.origin.artifact || archive.name === supplier.origin.artifact) &&
        archive.target === supplier.configuration,
    );
    if (archives.length !== 1)
      throw new Error('completed supplier requires its exact configured public archive');
    for (const { declaration, member } of files) {
      if (supplier.binding === 'abi-contract' && declaration.member === undefined) {
        const archive = archives[0];
        const identity =
          archive.size !== undefined && archive.sha256 !== undefined
            ? { size: archive.size, sha256: archive.sha256 }
            : archive.artifacts?.length === 1
              ? { size: archive.artifacts[0].size, sha256: archive.artifacts[0].sha256 }
              : undefined;
        if (!identity)
          throw new Error('whole archive ABI supplier requires its authenticated outer bytes');
        equal(
          { size: member.size, sha256: member.sha256 },
          identity,
          'captured ABI supplier/published outer archive bytes',
        );
        continue;
      }
      const published = archives[0].members.filter((row) => row.path === declaration.member);
      if (published.length !== 1 || published[0].type !== 'file')
        throw new Error('completed supplier requires its exact regular archive member');
      equal(
        { sha256: member.sha256, size: member.size },
        { sha256: published[0].sha256, size: published[0].size },
        'captured supplier/published member bytes',
      );
    }
  }
  const buildBound = new Map(ids.map((id) => [id, new Set<string>()]));
  const decisions = new Map<string, string>();
  for (const supplier of records) {
    if (supplier.binding !== 'compiled-input' || supplier.product === supplier.consumer) continue;
    const key = `${supplier.consumer}:${supplier.product}`;
    const decision = consumerDigest({
      version: supplier.version,
      origin:
        supplier.origin.kind === 'current-source'
          ? { kind: 'current-source' }
          : { kind: supplier.origin.kind, publication: supplier.origin.publication },
    });
    const previous = decisions.get(key);
    // The existing conventional compatibility field applies to the entire
    // product; this Map cannot truthfully retarget only some configurations.
    if (previous && previous !== decision)
      throw new Error('conflicting current/held compiled suppliers across consumer configurations');
    decisions.set(key, decision);
    if (supplier.origin.kind === 'current-source')
      buildBound.get(supplier.consumer)!.add(supplier.product);
  }
  return {
    scope: 'construction' as const,
    source: structuredClone(source),
    suppliers: records,
    unknowns: [...unknowns].sort(),
    buildBound: unknowns.size
      ? undefined
      : resolveBuildBoundCompatibilityProducts(products, { buildBound }),
  };
}
