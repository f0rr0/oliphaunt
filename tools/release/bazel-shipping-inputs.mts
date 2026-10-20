/** Declared construction inputs, not a publication or compatibility certificate. */
import { createHash } from 'node:crypto';
import type { CompletedPublication } from './completed-release-publication.mts';

export type NativeShippingSupplier = {
  product: string;
  version: string;
  /** The supplier's delivery slot, independent of its consumer's configuration. */
  configuration: string;
  binding: 'compiled-input' | 'abi-contract';
  origin:
    | {
        kind: 'current-source';
        /** Original authenticated final archive, for a consumed imported File. */
        producer?: {
          evidenceDigest: string;
          invocationId: string;
          root: string;
          configuration: string;
          output: string;
          /** Original archive's leaf path when its producer output is a Tree. */
          member?: string;
        };
      }
    | { kind: 'completed-publication'; publication: CompletedPublication; artifact: string };
  /** Imported Files bind the authenticated outer File, or one of its archive members. */
  files: { path: string; member?: string }[];
};

export interface ShippingProductInputs {
  version: string;
  packages: Record<string, unknown>[];
  inputs: string[];
  actions: string[];
}

export interface ShippingInputView {
  schema: 'oliphaunt-bazel-construction-inputs-v2';
  products: Record<string, ShippingProductInputs>;
  /** Complete reached action inputs, excluding only declared virtual Middleman outputs. */
  physicalInputs: string[];
  /** Source leaves and explicit consumed supplier values; intermediates remain in the DAG. */
  captureInputs: string[];
}

export type ConfiguredFileWriteCheck = (
  output: { path: string; owner: string },
  configuration: string,
  context: string,
) => void;

type Row = Record<string, unknown>;
function row(value: unknown): Row {
  if (!value || Array.isArray(value) || typeof value !== 'object')
    throw new Error('expected an object');
  return value as Row;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('expected an array');
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('expected a nonempty string');
  return value;
}
function id(value: unknown): string {
  if (typeof value !== 'number' && typeof value !== 'string') throw new Error('missing aquery id');
  return String(value);
}
function index(value: unknown): Map<string, Row> {
  const result = new Map<string, Row>();
  for (const valueRow of array(value ?? [])) {
    const item = row(valueRow);
    const key = id(item.id);
    if (result.has(key)) throw new Error(`duplicate aquery id ${key}`);
    result.set(key, item);
  }
  return result;
}
function required<T>(map: Map<string, T>, key: string): T {
  const value = map.get(key);
  if (value === undefined) throw new Error(`incomplete aquery graph: missing ${key}`);
  return value;
}
/** Bazel prints the main repository as //, @// or @@// across its query/event APIs. */
export function canonicalShippingLabel(value: unknown): string {
  return text(value).replace(/^@@?\/\//, '//');
}

/** The one declared private Apple document needed by foreign final construction. */
export function isNativeAppleBaseInputRoot(root: {
  label: string;
  package: {
    product: string;
    ecosystem: string;
    configuration: string;
    name: string;
    role: string;
    outputs: { path: string }[];
  };
}) {
  const pkg = root.package;
  return (
    canonicalShippingLabel(root.label) === '//src/native/runtime:apple_ios_manifest_shipping' &&
    pkg.product === 'liboliphaunt-native' &&
    pkg.ecosystem === 'internal' &&
    pkg.configuration === 'ios-xcframework' &&
    pkg.name === 'ios.json' &&
    pkg.role === 'apple-base-ios-manifest-input' &&
    pkg.outputs.length === 1 &&
    pkg.outputs[0].path.startsWith('bazel-out/') &&
    pkg.outputs[0].path.endsWith('/apple_release_assets/ios.json')
  );
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Structural completed-origin facts only; the controller authenticates their public bytes. */
export function validateNativeSupplierPublications(value: unknown): CompletedPublication[] {
  const seen = new Set<string>();
  return array(value).map((raw) => {
    const publication = row(raw);
    if (
      Object.keys(publication).sort().join(',') !==
        'product,publicationSha,publicationTree,releaseSha,tagName,version' ||
      publication.tagName !== `${text(publication.product)}-v${text(publication.version)}` ||
      ![publication.publicationSha, publication.publicationTree, publication.releaseSha].every(
        (sha) => typeof sha === 'string' && /^[a-f0-9]{40}$/u.test(sha),
      )
    )
      throw new Error('native suppliers require an exact canonical completed publication');
    const key = `${publication.product}@${publication.version}`;
    if (seen.has(key)) throw new Error('duplicate completed supplier publication');
    seen.add(key);
    return structuredClone(publication) as unknown as CompletedPublication;
  });
}

/** Structural provider contract only; actual File/origin binding is checked separately. */
export function validateNativeShippingSuppliers(value: unknown): NativeShippingSupplier[] {
  const exactFields = (value: unknown, names: string[]) => {
    const object = row(value);
    if (Object.keys(object).sort().join(',') !== names.sort().join(','))
      throw new Error('native suppliers require exact typed fields');
    return object;
  };
  const relative = (value: unknown) => {
    const path = text(value);
    if (
      path.startsWith('/') ||
      /[\\\u0000-\u001f\u007f]/u.test(path) ||
      path.normalize('NFC') !== path ||
      path.split('/').some((part) => !part || part === '.' || part === '..')
    )
      throw new Error('native suppliers require safe declared File/member paths');
    return path;
  };
  const seen = new Set<string>();
  return array(value).map((raw) => {
    const supplier = exactFields(raw, [
      'product',
      'version',
      'configuration',
      'binding',
      'origin',
      'files',
    ]);
    for (const key of ['product', 'version', 'configuration']) text(supplier[key]);
    if (!['compiled-input', 'abi-contract'].includes(text(supplier.binding)))
      throw new Error('native supplier has invalid binding');
    const origin = row(supplier.origin);
    if (origin.kind === 'current-source') {
      exactFields(origin, Object.hasOwn(origin, 'producer') ? ['kind', 'producer'] : ['kind']);
      if (Object.hasOwn(origin, 'producer')) {
        const producerFields = [
          'evidenceDigest',
          'invocationId',
          'root',
          'configuration',
          'output',
        ];
        if (Object.hasOwn(row(origin.producer), 'member')) producerFields.push('member');
        const producer = exactFields(origin.producer, producerFields);
        if (!/^sha256:[a-f0-9]{64}$/u.test(text(producer.evidenceDigest)))
          throw new Error('current supplier requires the authenticated evidence digest');
        for (const name of ['invocationId', 'root', 'configuration']) text(producer[name]);
        relative(producer.output);
        if (Object.hasOwn(producer, 'member')) relative(producer.member);
      }
    } else if (origin.kind === 'completed-publication') {
      exactFields(origin, ['kind', 'publication', 'artifact']);
      const publication = validateNativeSupplierPublications([origin.publication])[0];
      if (publication.product !== supplier.product || publication.version !== supplier.version)
        throw new Error('native suppliers require an exact canonical completed publication');
      relative(origin.artifact);
    } else throw new Error('native supplier requires an explicit physical origin');
    const key = canonical({
      product: supplier.product,
      binding: supplier.binding,
      configuration: supplier.configuration,
      origin,
    });
    if (seen.has(key)) throw new Error('duplicate native supplier binding');
    seen.add(key);
    const files = array(supplier.files);
    if (!files.length) throw new Error('native supplier requires actual consumed Files');
    const names = new Set<string>();
    for (const rawFile of files) {
      const archiveMember =
        (origin.kind === 'completed-publication' || Object.hasOwn(origin, 'producer')) &&
        Object.hasOwn(row(rawFile), 'member');
      const file = exactFields(rawFile, archiveMember ? ['path', 'member'] : ['path']);
      const path = relative(file.path);
      if (names.has(path)) throw new Error('duplicate native supplier File');
      names.add(path);
      if (archiveMember) relative(file.member);
    }
    return structuredClone(supplier) as NativeShippingSupplier;
  });
}

function aqueryFileGraph(raw: unknown) {
  const graph = row(raw);
  const fragments = index(graph.pathFragments);
  const artifacts = index(graph.artifacts);
  const targets = index(graph.targets);
  const depSets = index(graph.depSetOfFiles);
  const configurations = index(graph.configuration);
  const artifactPaths = new Map<string, string>();
  const fragmentPath = (key: string, visiting = new Set<string>()): string => {
    if (visiting.has(key)) throw new Error('cycle in aquery paths');
    visiting.add(key);
    const fragment = required(fragments, key);
    const segment = text(fragment.label);
    if (segment.includes('/') || segment === '..' || segment === '.')
      throw new Error('invalid aquery path segment');
    return fragment.parentId
      ? `${fragmentPath(id(fragment.parentId), visiting)}/${segment}`
      : segment;
  };
  for (const [key, artifact] of artifacts)
    artifactPaths.set(key, fragmentPath(id(artifact.pathFragmentId)));
  // Reuse each depset's own validated IDs, without retaining expanded input closures.
  const directInputs = new Map<string, string[]>();
  const inputsOf = (action: Row): Set<string> => {
    const result = new Set<string>();
    const visited = new Set<string>();
    const visit = (key: string, stack: Set<string>) => {
      if (stack.has(key)) throw new Error('cycle in aquery input dep sets');
      if (visited.has(key)) return;
      const item = required(depSets, key);
      stack.add(key);
      for (const child of array(item.transitiveDepSetIds ?? [])) visit(id(child), stack);
      let direct = directInputs.get(key);
      if (direct === undefined) {
        direct = [];
        for (const artifact of array(item.directArtifactIds ?? [])) {
          const artifactId = id(artifact);
          required(artifactPaths, artifactId);
          direct.push(artifactId);
        }
        directInputs.set(key, direct);
      }
      for (const artifact of direct) result.add(artifact);
      stack.delete(key);
      visited.add(key);
    };
    for (const key of array(action.inputDepSetIds ?? [])) visit(id(key), new Set());
    return result;
  };
  return { graph, targets, configurations, artifactPaths, depSets, directInputs, inputsOf };
}

/** Actual TestRunner input closure and input-free FileWrite outputs of its configured target. */
export function configuredAqueryTargetInputs(raw: unknown, label: string, configuration: string) {
  const { graph, targets, configurations, artifactPaths, inputsOf } = aqueryFileGraph(raw);
  const inputs = new Set<string>();
  const written = new Set<string>();
  const producers = new Map<string, Row>();
  const tests: Row[] = [];
  for (const rawAction of array(graph.actions ?? [])) {
    const action = row(rawAction);
    for (const output of array(action.outputIds ?? [])) {
      const key = id(output);
      required(artifactPaths, key);
      const previous = producers.get(key);
      if (previous && canonical(previous) !== canonical(action))
        throw new Error('native qualification has conflicting aquery producers');
      producers.set(key, action);
    }
    if (
      canonicalShippingLabel(required(targets, id(action.targetId)).label) !==
      canonicalShippingLabel(label)
    )
      continue;
    if (text(required(configurations, id(action.configurationId)).checksum) !== configuration)
      continue;
    if (action.mnemonic === 'TestRunner') tests.push(action);
    if (action.mnemonic === 'FileWrite' && inputsOf(action).size === 0)
      for (const output of array(action.outputIds ?? []))
        written.add(required(artifactPaths, id(output)));
  }
  if (!tests.length)
    throw new Error('native qualification requires its actual configured TestRunner action');
  const visited = new Set<string>();
  const visit = (key: string, stack: Set<string>) => {
    if (stack.has(key)) throw new Error('cycle in native qualification TestRunner inputs');
    if (visited.has(key)) return;
    const file = required(artifactPaths, key);
    inputs.add(file);
    const producer = producers.get(key);
    // Runfiles infrastructure expands runtime Files. An APK or package producer
    // belongs to construction; its compiler inputs are not installed-test inputs.
    if (
      producer &&
      ['Middleman', 'SourceSymlinkManifest', 'SymlinkTree'].includes(text(producer.mnemonic))
    )
      for (const input of inputsOf(producer)) visit(input, new Set(stack).add(key));
    visited.add(key);
  };
  for (const test of tests) for (const input of inputsOf(test)) visit(input, new Set());
  return { inputs, written };
}

export function buildShippingInputView(
  exportValue: unknown,
  aqueryValue: unknown,
  {
    configurationByOutput,
    inspectPackageInputs,
    inspectFileWrites,
  }: {
    configurationByOutput?: ReadonlyMap<string, string>;
    /** Check declared supplier Files against this package, never sibling roots. */
    inspectPackageInputs?: (pkg: Row, consumes: (path: string) => boolean) => void;
    /** Check metadata against this call's validated graph without deriving another view. */
    inspectFileWrites?: (check: ConfiguredFileWriteCheck) => void;
  } = {},
): ShippingInputView {
  const exported = row(exportValue);
  if (exported.schema !== 'oliphaunt-bazel-shipping-v1')
    throw new Error('unsupported shipping export');
  if (exported.scope !== 'construction')
    throw new Error('shipping export must declare construction scope');
  const { graph, targets, configurations, artifactPaths, depSets, directInputs, inputsOf } =
    aqueryFileGraph(aqueryValue);
  // Compare long shared SDK prefixes once; each action retains the same lexical path order.
  const rankedPaths = [...new Set(artifactPaths.values())].sort();
  const pathRanks = new Map(rankedPaths.map((file, rank) => [file, rank]));
  const producers = new Map<string, Row>();
  const products: ShippingInputView['products'] = {};
  const identities = new Set<string>();
  const visitedByProduct = new Map<string, Set<string>>();
  const visitedActionsByProduct = new Map<string, Set<Row>>();
  const visitedDepSetsByProduct = new Map<string, Set<string>>();
  const actionDescriptions = new Map<Row, string>();
  const sharedDefinitions = new Map<Row, string>();
  const physicalInputs = new Set<string>();
  const captureInputs = new Set<string>();
  const virtualOutputs = new Set<string>();
  const describeAction = (action: Row) => ({
    ...Object.fromEntries(
      Object.entries(action).filter(
        ([name]) =>
          ![
            'targetId',
            'configurationId',
            'inputDepSetIds',
            'outputIds',
            'primaryOutputId',
            'aspectDescriptorIds',
          ].includes(name),
      ),
    ),
    outputs: array(action.outputIds ?? [])
      .map((output) => required(artifactPaths, id(output)))
      .sort(),
    ...(action.primaryOutputId === undefined
      ? {}
      : { primaryOutput: required(artifactPaths, id(action.primaryOutputId)) }),
  });
  const actionDescription = (action: Row, inputs: Set<string>) => {
    const cached = actionDescriptions.get(action);
    if (cached !== undefined) return cached;
    const paths = [
      ...new Set([...inputs].map((input) => required(pathRanks, required(artifactPaths, input)))),
    ]
      .sort((left, right) => left - right)
      .map((rank) => rankedPaths[rank]!);
    for (const path of paths) physicalInputs.add(path);
    if (action.mnemonic === 'Middleman')
      for (const output of array(action.outputIds ?? []))
        virtualOutputs.add(required(artifactPaths, id(output)));
    const description = canonical({
      ...describeAction(action),
      // Shared compiler headers are hashed once per action, never retained in every description.
      inputs: {
        count: paths.length,
        sha256: createHash('sha256').update(JSON.stringify(paths)).digest('hex'),
      },
      target: canonicalShippingLabel(required(targets, id(action.targetId)).label),
    });
    actionDescriptions.set(action, description);
    return description;
  };
  const sharedActionDefinition = (action: Row, artifactPath: string) => {
    const cached = sharedDefinitions.get(action);
    if (cached !== undefined) return cached;
    text(action.actionKey);
    required(configurations, id(action.configurationId));
    const outputs = array(action.outputIds).map(id);
    const primary = id(action.primaryOutputId);
    if (!outputs.includes(primary))
      throw new Error(`primary output is missing from outputs for ${artifactPath}`);
    const inputs = inputsOf(action);
    const definition = canonical({
      ...describeAction(action),
      configurationId: action.configurationId,
      inputs: [...inputs].map((input) => required(artifactPaths, input)),
      outputs: outputs.map((output) => required(artifactPaths, output)),
    });
    sharedDefinitions.set(action, definition);
    return definition;
  };
  for (const value of array(graph.actions ?? [])) {
    const action = row(value);
    required(targets, id(action.targetId));
    for (const output of array(action.outputIds ?? [])) {
      const key = id(output);
      const artifactPath = required(artifactPaths, key);
      const previous = producers.get(key);
      if (previous) {
        // Bazel can repeat the same complete action record for one artifact ID.
        // Ingest it idempotently without changing its producer or owner.
        if (canonical(previous) !== canonical(action))
          throw new Error(`multiple producers for ${artifactPath}`);
        sharedActionDefinition(action, artifactPath);
      } else producers.set(key, action);
    }
  }
  const byPath = new Map<string, string[]>();
  for (const [key, artifactPath] of artifactPaths)
    byPath.set(artifactPath, [...(byPath.get(artifactPath) ?? []), key]);
  for (const [artifactPath, keys] of byPath) {
    if (keys.length < 2) continue;
    // Native rules may share identical copy actions across target owners. IDs
    // differ, but keys, configuration and ordered physical inputs/outputs must
    // agree. Incomplete declarations cannot prove Bazel action sharing.
    const definitions = keys.map((key) => {
      const action = producers.get(key);
      if (!action) return 'source';
      return sharedActionDefinition(action, artifactPath);
    });
    if (new Set(definitions).size !== 1)
      throw new Error(`ambiguous artifact producers for ${artifactPath}`);
  }
  const configuredOutput = (output: Row, configurationsByOutput?: ReadonlyMap<string, string>) => {
    const keys = required(byPath, text(output.path));
    const key = keys.find((candidate) => {
      const action = producers.get(candidate);
      return (
        action &&
        canonicalShippingLabel(required(targets, id(action.targetId)).label) ===
          canonicalShippingLabel(output.owner) &&
        (configurationsByOutput?.has(text(output.path)) !== true ||
          required(configurations, id(action.configurationId)).checksum ===
            configurationsByOutput.get(text(output.path)))
      );
    });
    if (!key) throw new Error(`shipping output owner disagrees with aquery: ${output.path}`);
    return key;
  };
  // Scalar reachability is shared for requested supplier Files only. Retaining
  // transitive header sets or walking the full graph per package is unnecessary.
  const supplierReachability = new Map<
    string,
    { artifacts: Map<string, boolean>; depSets: Map<string, boolean> }
  >();
  const consumes = (output: string, path: string): boolean => {
    if (!byPath.has(path) || virtualOutputs.has(path)) return false;
    let memo = supplierReachability.get(path);
    if (!memo) {
      memo = { artifacts: new Map(), depSets: new Map() };
      supplierReachability.set(path, memo);
    }
    const fromArtifact = (key: string): boolean => {
      const cached = memo.artifacts.get(key);
      if (cached !== undefined) return cached;
      const action = producers.get(key);
      const reached =
        !!action && array(action.inputDepSetIds ?? []).some((input) => fromDepSet(id(input)));
      memo.artifacts.set(key, reached);
      return reached;
    };
    const fromDepSet = (key: string): boolean => {
      const cached = memo.depSets.get(key);
      if (cached !== undefined) return cached;
      const item = required(depSets, key);
      const reached =
        array(item.directArtifactIds ?? []).some(
          (input) => required(artifactPaths, id(input)) === path || fromArtifact(id(input)),
        ) || array(item.transitiveDepSetIds ?? []).some((input) => fromDepSet(id(input)));
      memo.depSets.set(key, reached);
      return reached;
    };
    return fromArtifact(output);
  };
  for (const value of array(exported.packages)) {
    const pkg = row(value);
    const product = text(pkg.product);
    const version = text(pkg.version);
    const ecosystem = text(pkg.ecosystem);
    const identity = `${ecosystem === 'github' ? `${product}:` : ''}${ecosystem}:${text(pkg.name)}${ecosystem === 'internal' ? `:${text(pkg.configuration)}` : ''}`;
    if (identities.has(identity)) throw new Error(`duplicate shipping identity ${identity}`);
    identities.add(identity);
    if (products[product] && products[product].version !== version)
      throw new Error(`inconsistent version for ${product}`);
    const view = products[product] ?? { version, packages: [], inputs: [], actions: [] };
    products[product] = view;
    const leaves = new Set(view.inputs);
    const descriptions = new Set(view.actions);
    const visited = visitedByProduct.get(product) ?? new Set<string>();
    visitedByProduct.set(product, visited);
    const visitedActions = visitedActionsByProduct.get(product) ?? new Set<Row>();
    visitedActionsByProduct.set(product, visitedActions);
    const visitedDepSets = visitedDepSetsByProduct.get(product) ?? new Set<string>();
    visitedDepSetsByProduct.set(product, visitedDepSets);
    const visit = (key: string, stack: Set<string>) => {
      if (stack.has(key)) throw new Error('cycle in aquery producers');
      if (visited.has(key)) return;
      const action = producers.get(key);
      if (!action) {
        const inputPath = required(artifactPaths, key);
        if (inputPath.startsWith('bazel-out/'))
          throw new Error(`missing generated input producer: ${inputPath}`);
        leaves.add(inputPath);
        captureInputs.add(inputPath);
      } else if (!visitedActions.has(action)) {
        const cached = actionDescriptions.get(action);
        if (cached === undefined) {
          const inputs = inputsOf(action);
          stack.add(key);
          for (const input of inputs) visit(input, stack);
          // ActionKey describes action declarations, not consumed content or a remote-cache key.
          descriptions.add(actionDescription(action, inputs));
        } else {
          stack.add(key);
          const visitDepSet = (input: string) => {
            if (visitedDepSets.has(input)) return;
            const item = required(depSets, input);
            for (const child of array(item.transitiveDepSetIds ?? [])) visitDepSet(id(child));
            for (const artifact of required(directInputs, input)) visit(artifact, stack);
            visitedDepSets.add(input);
          };
          for (const input of array(action.inputDepSetIds ?? [])) visitDepSet(id(input));
          descriptions.add(cached);
        }
        stack.delete(key);
        visitedActions.add(action);
      }
      visited.add(key);
    };
    const outputs = array(pkg.outputs);
    const outputKeys: string[] = [];
    if (!outputs.length) throw new Error(`empty shipping outputs for ${identity}`);
    for (const outputValue of outputs) {
      const output = row(outputValue);
      const key = configuredOutput(output, configurationByOutput);
      outputKeys.push(key);
      visit(key, new Set());
    }
    view.packages.push(pkg);
    view.inputs = [...leaves].sort();
    view.actions = [...descriptions].sort();
    if (pkg.supplierInputs !== undefined)
      for (const supplier of validateNativeShippingSuppliers(pkg.supplierInputs))
        for (const file of supplier.files) {
          if (outputKeys.some((key) => consumes(key, file.path))) captureInputs.add(file.path);
        }
    inspectPackageInputs?.(pkg, (path) => outputKeys.some((key) => consumes(key, path)));
  }
  inspectFileWrites?.((output, configuration, context) => {
    const key = configuredOutput(output, new Map([[output.path, configuration]]));
    const action = required(producers, key);
    const definition = row(JSON.parse(actionDescription(action, inputsOf(action))));
    if (definition.mnemonic !== 'FileWrite' || row(definition.inputs).count !== 0)
      throw new Error(context);
  });
  for (const view of Object.values(products))
    view.packages.sort((a, b) => {
      const left = canonical(a);
      const right = canonical(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });
  return {
    schema: 'oliphaunt-bazel-construction-inputs-v2',
    products,
    physicalInputs: [...physicalInputs].filter((path) => !virtualOutputs.has(path)).sort(),
    captureInputs: [...captureInputs].sort(),
  };
}

/** Each product uses its own completed baseline; unclassified paths require policy evidence. */
export function selectShippingChanges(
  beforeByProduct: Record<string, ShippingProductInputs>,
  after: ShippingInputView,
  changedPathsByProduct: Record<string, string[]>,
) {
  if (after.schema !== 'oliphaunt-bazel-construction-inputs-v2')
    throw new Error('unsupported construction input view');
  const affectedProducts: string[] = [];
  const unclassified = new Set<string>();
  const knownInputs = new Set([
    ...Object.values(beforeByProduct).flatMap((product) => product.inputs),
    ...Object.values(after.products).flatMap((product) => product.inputs),
  ]);
  for (const product of [
    ...new Set([...Object.keys(beforeByProduct), ...Object.keys(after.products)]),
  ].sort()) {
    const before = beforeByProduct[product];
    const current = after.products[product];
    const changedPaths = changedPathsByProduct[product];
    if (before && !Array.isArray(changedPaths))
      throw new Error(`missing product baseline delta for ${product}`);
    const paths = new Set([...(before?.inputs ?? []), ...(current?.inputs ?? [])]);
    let touched = false;
    for (const file of changedPaths ?? [])
      if (paths.has(file)) {
        touched = true;
      } else if (!knownInputs.has(file)) unclassified.add(file);
    if (!before || !current || touched || canonical(before) !== canonical(current))
      affectedProducts.push(product);
  }
  return {
    affectedProducts,
    unclassifiedPaths: [...unclassified].sort(),
  };
}

type ObservedShippingProduct = {
  product: { id: string; version: string };
  construction: readonly Row[];
};

/** Project existing captured facts; this cannot authenticate a historical baseline.
 * Shipping affectedness requests construction checks. Bazel independently schedules
 * each action and test from its own declared inputs, including test-only changes.
 */
export function selectObservedShippingChanges(
  current: readonly ObservedShippingProduct[],
  baselines: Readonly<Record<string, ObservedShippingProduct>>,
  deliveries: readonly { product: string; deliveryStatus: string }[] = [],
) {
  const project = ({ product, construction }: ObservedShippingProduct) => {
    if (
      !construction.length ||
      construction.some(
        (view) =>
          !Array.isArray(view.leafInputPaths) ||
          !Array.isArray(view.analysisInputPaths) ||
          !Array.isArray(view.analysisInputs),
      )
    )
      return undefined;
    const content = new Map<string, Set<string>>();
    const packages: Row[] = [];
    const actions = new Set<string>();
    for (const view of construction) {
      const roots = array(view.roots).map(row);
      const context = createHash('sha256')
        .update(
          canonical(
            roots
              .map((root) => canonical({ label: root.label, configuration: root.configuration }))
              .sort(),
          ),
        )
        .digest('hex');
      packages.push(...roots.map((root) => row(root.package)));
      for (const action of array(view.actions)) actions.add(text(action));
      const paths = new Set([
        ...array(view.leafInputPaths).map(text),
        ...array(view.analysisInputPaths).map(text),
      ]);
      const captures = new Map<string, Row[]>();
      for (const raw of [...array(view.inputs), ...array(view.analysisInputs)]) {
        const file = row(raw);
        const path = text(file.path);
        captures.set(path, [...(captures.get(path) ?? []), file]);
      }
      for (const path of paths) {
        const capture = captures.get(path);
        if (!capture?.length) throw new Error(`shipping causal File was not captured: ${path}`);
        const identities = content.get(path) ?? new Set<string>();
        for (const file of capture)
          identities.add(
            createHash('sha256')
              .update(canonical({ context, members: file.members }))
              .digest('hex'),
          );
        content.set(path, identities);
      }
    }
    packages.sort((left, right) => {
      const a = canonical(left);
      const b = canonical(right);
      return a < b ? -1 : a > b ? 1 : 0;
    });
    return {
      view: {
        version: product.version,
        packages,
        inputs: [...content.keys()].sort(),
        actions: [...actions].sort(),
      },
      content: new Map(
        [...content].map(([path, identities]) => [path, canonical([...identities].sort())]),
      ),
    };
  };
  const before: Record<string, ShippingProductInputs> = {};
  const after: ShippingInputView = {
    schema: 'oliphaunt-bazel-construction-inputs-v2',
    products: {},
    physicalInputs: [],
    captureInputs: [],
  };
  const deltas: Record<string, string[]> = {};
  const unknownProducts: string[] = [];
  for (const product of current) {
    const id = text(product.product.id);
    if (Object.hasOwn(after.products, id)) throw new Error('duplicate observed shipping product');
    const baseline = baselines[id];
    if (baseline && baseline.product.id !== id)
      throw new Error('shipping baseline owner differs from its lookup');
    const previous = baseline && project(baseline);
    const observed = project(product);
    if (!previous || !observed) unknownProducts.push(id);
    if (previous) before[id] = previous.view;
    after.products[id] = observed?.view ?? {
      version: product.product.version,
      packages: [],
      inputs: [],
      actions: [],
    };
    deltas[id] = previous
      ? [...new Set([...previous.content.keys(), ...(observed?.content.keys() ?? [])])]
          .filter((path) => previous.content.get(path) !== observed?.content.get(path))
          .sort()
      : [];
  }
  const selection = selectShippingChanges(before, after, deltas);
  const affectedProducts = [...new Set([...selection.affectedProducts, ...unknownProducts])].sort();
  for (const delivery of deliveries) {
    if (!Object.hasOwn(after.products, delivery.product))
      throw new Error('shipping delivery exceeds the observed product inventory');
    if (delivery.deliveryStatus === 'different' && !affectedProducts.includes(delivery.product))
      throw new Error(`unchanged shipping inputs produced different delivery: ${delivery.product}`);
  }
  return { ...selection, affectedProducts, unknownProducts: unknownProducts.sort() };
}
