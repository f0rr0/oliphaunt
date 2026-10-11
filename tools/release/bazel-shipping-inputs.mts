/** Declared construction inputs, not a publication or compatibility certificate. */
import { createHash } from 'node:crypto';

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
}

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

export function buildShippingInputView(
  exportValue: unknown,
  aqueryValue: unknown,
): ShippingInputView {
  const exported = row(exportValue);
  if (exported.schema !== 'oliphaunt-bazel-shipping-v1')
    throw new Error('unsupported shipping export');
  if (exported.scope !== 'construction')
    throw new Error('shipping export must declare construction scope');
  const graph = row(aqueryValue);
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
  const producers = new Map<string, Row>();
  const inputsOf = (action: Row): Set<string> => {
    const result = new Set<string>();
    const visited = new Set<string>();
    const visit = (key: string, stack: Set<string>) => {
      if (stack.has(key)) throw new Error('cycle in aquery input dep sets');
      if (visited.has(key)) return;
      const item = required(depSets, key);
      const next = new Set(stack).add(key);
      for (const child of array(item.transitiveDepSetIds ?? [])) visit(id(child), next);
      for (const artifact of array(item.directArtifactIds ?? [])) {
        const artifactId = id(artifact);
        required(artifactPaths, artifactId);
        result.add(artifactId);
      }
      visited.add(key);
    };
    for (const key of array(action.inputDepSetIds ?? [])) visit(id(key), new Set());
    return result;
  };
  const products: ShippingInputView['products'] = {};
  const identities = new Set<string>();
  const visitedByProduct = new Map<string, Set<string>>();
  const actionDescriptions = new Map<Row, string>();
  const sharedDefinitions = new Map<Row, string>();
  const physicalInputs = new Set<string>();
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
    const paths = [...new Set([...inputs].map((input) => required(artifactPaths, input)))].sort();
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
    const visit = (key: string, stack: Set<string>) => {
      if (stack.has(key)) throw new Error('cycle in aquery producers');
      if (visited.has(key)) return;
      const action = producers.get(key);
      if (!action) {
        const inputPath = required(artifactPaths, key);
        if (inputPath.startsWith('bazel-out/'))
          throw new Error(`missing generated input producer: ${inputPath}`);
        leaves.add(inputPath);
      } else {
        const inputs = inputsOf(action);
        for (const input of inputs) visit(input, new Set(stack).add(key));
        // ActionKey describes action declarations, not consumed content or a remote-cache key.
        descriptions.add(actionDescription(action, inputs));
      }
      visited.add(key);
    };
    const outputs = array(pkg.outputs);
    if (!outputs.length) throw new Error(`empty shipping outputs for ${identity}`);
    for (const outputValue of outputs) {
      const output = row(outputValue);
      const keys = required(byPath, text(output.path));
      const key = keys.find((candidate) => {
        const action = producers.get(candidate);
        return (
          action &&
          canonicalShippingLabel(required(targets, id(action.targetId)).label) ===
            canonicalShippingLabel(output.owner)
        );
      });
      if (!key) throw new Error(`shipping output owner disagrees with aquery: ${output.path}`);
      visit(key, new Set());
    }
    view.packages.push(pkg);
    view.inputs = [...leaves].sort();
    view.actions = [...descriptions].sort();
  }
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
