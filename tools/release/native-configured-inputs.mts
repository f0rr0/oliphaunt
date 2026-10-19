import assert from 'node:assert/strict';
import { canonicalShippingLabel } from './bazel-shipping-inputs.mts';

export function nativeConfiguredWorkspaceLabel(value: string): string {
  value = canonicalShippingLabel(value);
  if (!/^\/\/[A-Za-z0-9_./+-]*:[A-Za-z0-9_./+-]+$/u.test(value))
    throw new Error(`shipping qualification requires an explicit workspace target: ${value}`);
  return value;
}

export type RecipeRoot = { label: string; configuration: string };
export type RecipeGraph = {
  labels: string[];
  packages: { package: string; label: string }[];
  roots: { label: string; packages: string[] }[];
  sourceRoots?: { label: string; configuration: string; labels: string[] }[];
};

/** Index Bazel's configured edges once; do not expand selects in the loading graph. */
export function configuredRecipeGraph(
  raw: any,
  roots: RecipeRoot[],
  unionOnly = false,
  rootSourceFilter?: (label: string) => boolean,
): RecipeGraph {
  assert(
    Array.isArray(raw?.results) && Array.isArray(raw.configurations),
    'configured recipe graph is missing',
  );
  const configurations = new Map<string, string>();
  for (const config of raw.configurations) {
    assert(/^[a-f0-9]{64}$/u.test(config.checksum), 'configured recipe checksum is invalid');
    assert(!configurations.has(String(config.id)), 'duplicate configured recipe ID');
    configurations.set(String(config.id), config.checksum);
  }
  const checksum = (value: any) => {
    const id = value.configurationId;
    const declared = value.configurationChecksum ?? value.configuration?.checksum;
    if (id === undefined || id === 0) {
      assert(
        declared === undefined || declared === 'null',
        'configured recipe reference lacks an ID',
      );
      return 'null';
    }
    const result = configurations.get(String(id));
    assert(result, 'configured recipe reference is missing');
    assert(declared === undefined || declared === result, 'configured recipe checksum differs');
    return result;
  };
  const targetLabel = (value: unknown) => {
    assert(
      typeof value === 'string' && !/[\u0000-\u001f\u007f]/u.test(value),
      'configured recipe label is invalid',
    );
    const result = canonicalShippingLabel(value);
    assert(/^(?:@@?[^/]+)?\/\/[^:]*:.+$/u.test(result), 'configured recipe label is not explicit');
    return result;
  };
  const key = (name: string, config: string) => `${name}\0${config}`;
  const nodes = new Map<
    string,
    { label: string; kind: string; ruleClass?: string; edges: string[] }
  >();
  for (const result of raw.results) {
    const target = result.target;
    const config = checksum(result);
    const name = targetLabel(
      target?.rule?.name ??
        target?.sourceFile?.name ??
        target?.generatedFile?.name ??
        target?.packageGroup?.name,
    );
    const id = key(name, config);
    const kind = target.rule
      ? 'rule'
      : target.sourceFile
        ? 'source-file'
        : target.generatedFile
          ? 'generated-file'
          : 'package-group';
    const edges = (target.rule?.configuredRuleInput ?? []).map((dep: any) =>
      key(targetLabel(dep.label), checksum(dep)),
    );
    if (target.generatedFile)
      edges.push(key(targetLabel(target.generatedFile.generatingRule), config));
    if (target.packageGroup)
      edges.push(
        ...(target.packageGroup.includedPackageGroup ?? []).map((name: string) =>
          key(targetLabel(name), 'null'),
        ),
      );
    // The stock cquery stream can repeat a node; only an identical definition is unambiguous.
    const node = {
      label: name,
      kind,
      ruleClass: target.rule?.ruleClass,
      edges: [...new Set<string>(edges)].sort(),
    };
    const previous = nodes.get(id);
    if (previous) assert.deepEqual(previous, node, 'conflicting configured recipe target');
    else nodes.set(id, node);
  }
  const labels = new Set<string>();
  const names = new Set<string>();
  const unionVisited = new Set<string>();
  const unionActive = new Set<string>();
  const sourceRoots: NonNullable<RecipeGraph['sourceRoots']> = [];
  const mapped = roots.map((root) => {
    const name = targetLabel(root.label);
    const rootId = key(name, root.configuration);
    assert(
      !names.has(rootId) && /^[a-f0-9]{64}$/u.test(root.configuration),
      'configured recipe roots are ambiguous',
    );
    names.add(rootId);
    const visited = unionOnly && !rootSourceFilter ? unionVisited : new Set<string>();
    const active = unionOnly && !rootSourceFilter ? unionActive : new Set<string>();
    const packages = new Set<string>();
    const sourceLabels = new Set<string>();
    const pending = [{ id: key(name, root.configuration), exit: false }];
    while (pending.length) {
      const current = pending.pop();
      assert(current);
      if (current.exit) {
        active.delete(current.id);
        visited.add(current.id);
        continue;
      }
      if (visited.has(current.id)) continue;
      assert(!active.has(current.id), 'cycle in configured recipe dependencies');
      const node = nodes.get(current.id);
      assert(node, 'configured recipe dependency is missing');
      active.add(current.id);
      labels.add(node.label);
      if (node.kind === 'source-file' && rootSourceFilter?.(node.label))
        sourceLabels.add(node.label);
      packages.add(node.label.slice(0, node.label.indexOf(':')));
      pending.push(
        { id: current.id, exit: true },
        ...node.edges.map((id) => ({ id, exit: false })),
      );
    }
    if (rootSourceFilter)
      sourceRoots.push({
        label: name,
        configuration: root.configuration,
        labels: [...sourceLabels].sort(),
      });
    return { label: name, packages: [...packages].sort() };
  });
  const ordered = [...labels].sort();
  const packages = new Map<string, string>();
  for (const name of ordered) {
    const pkg = name.slice(0, name.indexOf(':'));
    if (!packages.has(pkg)) packages.set(pkg, name);
  }
  return {
    labels: ordered,
    packages: [...packages].map(([pkg, name]) => ({ package: pkg, label: name })),
    roots: unionOnly ? [] : mapped,
    ...(rootSourceFilter ? { sourceRoots } : {}),
  };
}

/** Publication roots retain their stronger unique workspace identity contract. */
export function nativeConfiguredRecipeGraph(raw: any, roots: RecipeRoot[]): RecipeGraph {
  const names = roots.map((root) => nativeConfiguredWorkspaceLabel(root.label));
  assert(new Set(names).size === names.length, 'configured recipe roots are ambiguous');
  return configuredRecipeGraph(raw, roots);
}

/** Use real buildfiles label results: Bazel 8 omits BUILD.bazel subinclude in proto output. */
export function nativeRecipeInputPaths(
  graph: RecipeGraph,
  queries: { packages: string[]; labels: string[] }[],
) {
  const key = (packages: string[]) => JSON.stringify(packages);
  const expected = new Set(graph.roots.map((root) => key(root.packages)));
  const loaded = new Map<string, string[]>();
  const workspacePath = (name: string) => {
    assert(
      typeof name === 'string' && !/[\u0000-\u001f\u007f]/u.test(name),
      'recipe source label is invalid',
    );
    name = canonicalShippingLabel(name);
    assert(/^(?:@@?[^/]+)?\/\/[^:]*:.+$/u.test(name), 'recipe source label is not explicit');
    if (!name.startsWith('//')) return undefined;
    const separator = name.indexOf(':');
    const result = [name.slice(2, separator), name.slice(separator + 1)].filter(Boolean).join('/');
    assert(
      result &&
        !name.includes('\\') &&
        !result.split('/').some((part) => part === '..' || part === '.' || !part),
      'recipe source path escapes',
    );
    return result;
  };
  for (const query of queries) {
    assert(Array.isArray(query.packages), 'recipe package set is missing');
    const id = key(query.packages);
    assert(expected.has(id) && !loaded.has(id), 'recipe package-set query is ambiguous');
    assert(Array.isArray(query.labels), 'recipe package sources are missing');
    const names = query.labels.map((name) => canonicalShippingLabel(name));
    assert(new Set(names).size === names.length, 'duplicate recipe source File');
    for (const pkg of query.packages.filter((pkg) => pkg.startsWith('//'))) {
      const buildNames = names.filter(
        (name) => name === `${pkg}:BUILD` || name === `${pkg}:BUILD.bazel`,
      );
      assert(buildNames.length === 1, 'configured package BUILD File is missing or ambiguous');
    }
    loaded.set(
      id,
      names.flatMap((name) => {
        const file = workspacePath(name);
        return file === undefined ? [] : [file];
      }),
    );
  }
  assert(loaded.size === expected.size, 'configured package-set recipe query is missing');
  return graph.roots.map((root) => {
    const files = loaded.get(key(root.packages));
    assert(files, 'configured package-set recipe query is missing');
    const paths = new Set(files);
    assert(paths.size, 'shipping analysis has no loaded workspace recipe sources');
    return { label: root.label, paths: [...paths].sort() };
  });
}
