import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

type Manifest = {
  name: string;
  version: string;
  type?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
type Lock = {
  lockfileVersion: number;
  configVersion: number;
  catalog?: Record<string, string>;
  overrides?: Record<string, string>;
  workspaces: Record<string, Manifest>;
  packages: Record<
    string,
    [
      string,
      string,
      {
        dependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
        optionalPeers?: string[];
        os?: string;
        cpu?: string;
      },
      string,
    ]
  >;
};
type CompilerInputs = {
  workspaces?: Record<string, string[]>;
  overrideTools?: string[];
};

/** Import exact compiler, type, and external runtime closures from the conventional lock. */
export function importJavascriptMetadata(
  root: { workspaces: { catalog?: Record<string, string> }; overrides?: Record<string, string> },
  lock: Lock,
  manifests: Record<string, Manifest>,
  consumerTools: Record<string, string[]> = {},
  compilerInputs: CompilerInputs = {},
) {
  if (lock.lockfileVersion !== 2 || lock.configVersion !== 1)
    throw new Error('Unsupported Bun lockfile schema');
  const packages: Record<
    string,
    {
      package: string;
      version: string;
      integrity: string;
      dependencies: Record<string, string>;
    }
  > = {};
  const consumerPackages: typeof packages = {};
  const compilerPackages: typeof packages & Record<string, { os?: string; cpu?: string }> = {};
  const consumerRoots: Record<string, Record<string, string>> = {};
  const compilerRoots: typeof consumerRoots = {};
  const compilerToolRoots: Record<string, string> = {};
  const ids = new Map<string, string>();
  const visiting = new Set<string>();
  const resolutionKey = (name: string, parent: string) => {
    for (
      let context = parent;
      context;
      context = context.replace(/(?:^|\/)(?:@[^/]+\/)?[^/]+$/u, '')
    )
      if (Object.hasOwn(lock.packages, `${context}/${name}`)) return `${context}/${name}`;
    return name;
  };
  const record = (
    name: string,
    parent: string,
    requirement: string,
    consumer = false,
    compiler = false,
  ): string => {
    const override = root.overrides?.[name];
    if (override) {
      if (!consumer && !compiler) throw new Error(`Unsupported JavaScript override for ${name}`);
      if (lock.overrides?.[name] !== override || !/^\d+\.\d+\.\d+$/.test(override))
        throw new Error(`bun.lock has a stale or unsupported JavaScript override for ${name}`);
      requirement = override;
    }
    const key = resolutionKey(name, parent);
    const entry = lock.packages[key];
    if (
      !entry?.[0].startsWith(`${name}@`) ||
      entry[1] !== '' ||
      !/^sha512-[A-Za-z0-9+/]+=*$/.test(entry[3] ?? '')
    )
      throw new Error(`Missing integrity-bearing lock entry for ${key}`);
    const version = entry[0].slice(name.length + 1);
    if (!Bun.semver.satisfies(version, requirement))
      throw new Error(`Locked ${key}@${version} does not satisfy ${requirement}`);
    const identity = `${consumer ? 'consumer:' : compiler ? 'compiler:' : ''}${key}`;
    const result = consumer ? consumerPackages : compiler ? compilerPackages : packages;
    const existing = ids.get(identity);
    if (existing) return existing;
    if (visiting.has(identity)) throw new Error(`Cycle in JavaScript type dependencies at ${key}`);
    const id = `p_${createHash('sha256').update(`${name}@${version}`).digest('hex').slice(0, 16)}`;
    if (compiler) ids.set(identity, id);
    visiting.add(identity);
    const dependencies: Record<string, string> = {};
    const requirements = consumer
      ? {
          ...entry[2].dependencies,
          ...entry[2].optionalDependencies,
          ...entry[2].peerDependencies,
        }
      : compiler
        ? {
            ...entry[2].dependencies,
            ...entry[2].optionalDependencies,
            ...Object.fromEntries(
              Object.entries(entry[2].peerDependencies ?? {}).filter(([name]) =>
                name.startsWith('@types/'),
              ),
            ),
          }
        : (entry[2].dependencies ?? {});
    for (const [dependency, range] of Object.entries(requirements)) {
      if (consumer) {
        const optional =
          Object.hasOwn(entry[2].optionalDependencies ?? {}, dependency) ||
          entry[2].optionalPeers?.includes(dependency);
        const child = lock.packages[resolutionKey(dependency, key)];
        if (
          !child ||
          (child[2].os && child[2].os !== 'linux') ||
          (child[2].cpu && child[2].cpu !== 'x64')
        ) {
          if (optional) continue;
          throw new Error(`Missing Linux x64 consumer tool dependency ${key} -> ${dependency}`);
        }
      }
      dependencies[dependency] = record(dependency, key, range, consumer, compiler);
    }
    const resolved = {
      package: name,
      version,
      integrity: entry[3],
      dependencies,
      ...(compiler && entry[2].os ? { os: entry[2].os } : {}),
      ...(compiler && entry[2].cpu ? { cpu: entry[2].cpu } : {}),
    };
    if (result[id] && JSON.stringify(result[id]) !== JSON.stringify(resolved))
      throw new Error(`Conflicting acquisition closure for ${name}@${version}`);
    result[id] = resolved;
    ids.set(identity, id);
    visiting.delete(identity);
    return id;
  };
  const workspaces: Record<
    string,
    {
      name: string;
      version: string;
      type: string;
      dependencies: Record<string, string>;
      types: Record<string, string>;
      packages?: Record<string, string>;
    }
  > = {};
  let typescript: { package: string; version: string; integrity: string } | undefined;
  for (const [path, manifest] of Object.entries(manifests).sort(([a], [b]) => a.localeCompare(b))) {
    const workspace = lock.workspaces[path];
    if (workspace?.name !== manifest.name || workspace.version !== manifest.version)
      throw new Error(`bun.lock has a stale workspace identity for ${path}`);
    const types: Record<string, string> = {};
    for (const name of [
      'typescript',
      ...Object.keys(manifest.devDependencies ?? {}).filter((name) => name.startsWith('@types/')),
    ]) {
      let requirement = manifest.devDependencies?.[name];
      if (workspace.devDependencies?.[name] !== requirement || !requirement)
        throw new Error(`bun.lock has a stale workspace declaration for ${path}/${name}`);
      if (requirement === 'catalog:') {
        requirement = root.workspaces.catalog?.[name];
        if (!requirement || lock.catalog?.[name] !== requirement)
          throw new Error(`bun.lock has a stale catalog declaration for ${name}`);
      }
      // Test-only types are not compiler inputs unless selected by tsconfig's types contract.
      if (!['typescript', '@types/node', '@types/bun'].includes(name)) continue;
      const id = record(name, manifest.name, requirement);
      if (name === 'typescript') {
        const { package: packageName, version, integrity } = packages[id];
        const compiler = { package: packageName, version, integrity };
        if (typescript && JSON.stringify(typescript) !== JSON.stringify(compiler))
          throw new Error('Selected JavaScript workspaces require different TypeScript compilers');
        typescript = compiler;
      } else types[name] = id;
    }
    const dependencies = manifest.dependencies ?? {};
    const runtimePackages: Record<string, string> = {};
    for (const [name, requirement] of Object.entries(dependencies)) {
      if (workspace.dependencies?.[name] !== requirement)
        throw new Error(`bun.lock has a stale workspace dependency for ${path}/${name}`);
      const target = Object.values(manifests).find((row) => row.name === name);
      if (target && !Bun.semver.satisfies(target.version, requirement))
        throw new Error(
          `Native JavaScript dependency ${name} must match its conventional workspace version`,
        );
      if (!target) {
        if (Object.values(lock.workspaces).some((row) => row.name === name))
          throw new Error(
            `JavaScript workspace dependency ${name} requires its selected source package`,
          );
        runtimePackages[name] = record(name, manifest.name, requirement);
      }
    }
    if (workspaces[manifest.name])
      throw new Error(`Duplicate JavaScript workspace ${manifest.name}`);
    workspaces[manifest.name] = {
      name: manifest.name,
      version: manifest.version,
      type: manifest.type ?? 'commonjs',
      dependencies,
      types,
    };
    if (Object.keys(runtimePackages).length) workspaces[manifest.name].packages = runtimePackages;
  }
  if (!typescript) throw new Error('Selected workspaces have no TypeScript compiler');
  // The compiler is acquired by aspect_rules_ts from the same lock-derived facts.
  for (const id of Object.keys(packages))
    if (packages[id].package === 'typescript') delete packages[id];
  for (const [workspace, tools] of Object.entries(consumerTools)) {
    const member = Object.entries(manifests).find(([, manifest]) => manifest.name === workspace);
    if (!member || !tools.length || new Set(tools).size !== tools.length)
      throw new Error(`Consumer tools require one selected conventional workspace ${workspace}`);
    const [path, manifest] = member;
    consumerRoots[workspace] = {};
    for (const name of tools) {
      const requirement = manifest.devDependencies?.[name];
      if (!requirement || lock.workspaces[path].devDependencies?.[name] !== requirement)
        throw new Error(`bun.lock has a stale consumer tool declaration ${workspace}/${name}`);
      consumerRoots[workspace][name] = record(name, workspace, requirement, true);
    }
  }
  for (const [workspace, inputs] of Object.entries(compilerInputs.workspaces ?? {})) {
    const member = Object.entries(manifests).find(([, manifest]) => manifest.name === workspace);
    if (!member || !inputs.length || new Set(inputs).size !== inputs.length)
      throw new Error(`Compiler inputs require one selected conventional workspace ${workspace}`);
    const [path, manifest] = member;
    compilerRoots[workspace] = {};
    for (const name of inputs) {
      let requirement = manifest.devDependencies?.[name];
      if (!requirement || lock.workspaces[path].devDependencies?.[name] !== requirement)
        throw new Error(`bun.lock has a stale compiler input declaration ${workspace}/${name}`);
      if (requirement === 'catalog:') {
        requirement = root.workspaces.catalog?.[name];
        if (!requirement || lock.catalog?.[name] !== requirement)
          throw new Error(`bun.lock has a stale catalog declaration for ${name}`);
      }
      compilerRoots[workspace][name] = record(name, workspace, requirement, false, true);
    }
  }
  for (const name of compilerInputs.overrideTools ?? []) {
    if (
      compilerToolRoots[name] ||
      !/^\d+\.\d+\.\d+$/.test(root.overrides?.[name] ?? '') ||
      lock.overrides?.[name] !== root.overrides?.[name]
    )
      throw new Error(`Compiler override tool ${name} requires an exact canonical lock override`);
    compilerToolRoots[name] = record(name, '', root.overrides![name], false, true);
  }
  const compilerClosures: Record<string, string[]> = {};
  const sharedCompilerPackages = Object.keys(compilerPackages)
    .filter((id) => Object.hasOwn(packages, id))
    .sort();
  for (const id of sharedCompilerPackages)
    if (!isDeepStrictEqual(compilerPackages[id], packages[id]))
      throw new Error(`Conflicting compiler/type acquisition context for ${packages[id].package}`);
  for (const id of Object.keys(compilerPackages)) {
    const closure = new Set<string>();
    const pending = [id];
    for (let current = pending.pop(); current; current = pending.pop()) {
      if (closure.has(current)) continue;
      closure.add(current);
      pending.push(...Object.values(compilerPackages[current].dependencies));
    }
    compilerClosures[id] = [...closure].sort();
  }
  return {
    workspaces,
    packages,
    typescript,
    ...(Object.keys(compilerRoots).length || Object.keys(compilerToolRoots).length
      ? {
          compilerInputs: {
            roots: compilerRoots,
            tools: compilerToolRoots,
            packages: compilerPackages,
            closures: compilerClosures,
            shared: sharedCompilerPackages,
          },
        }
      : {}),
    ...(Object.keys(consumerRoots).length
      ? {
          consumerTools: {
            roots: consumerRoots,
            packages: consumerPackages,
            platform: { os: 'linux', cpu: 'x64' },
          },
        }
      : {}),
  };
}

if (import.meta.main) {
  const [rootFile, lockFile, ...parameters] = Bun.argv.slice(2);
  const options = parameters.filter((value) => value.startsWith('--consumer-tools='));
  const compilerOptions = parameters.filter((value) => value.startsWith('--compiler-inputs='));
  if (options.length > 1) throw new Error('Expected at most one consumer tool selection');
  if (compilerOptions.length > 1) throw new Error('Expected at most one compiler input selection');
  const manifestFiles = parameters.filter(
    (value) => !value.startsWith('--consumer-tools=') && !value.startsWith('--compiler-inputs='),
  );
  const consumerTools = options.length
    ? JSON.parse(readFileSync(options[0].slice('--consumer-tools='.length), 'utf8'))
    : {};
  const compilerInputs = compilerOptions.length
    ? JSON.parse(readFileSync(compilerOptions[0].slice('--compiler-inputs='.length), 'utf8'))
    : {};
  if (!rootFile || !lockFile || !manifestFiles.length)
    throw new Error(
      'Expected root package.json, bun.lock, and conventional workspace package.json files',
    );
  const root = dirname(rootFile);
  const manifests = Object.fromEntries(
    manifestFiles.map((file) => [
      relative(root, dirname(file)).split('\\').join('/'),
      JSON.parse(readFileSync(file, 'utf8')),
    ]),
  );
  console.log(
    JSON.stringify(
      importJavascriptMetadata(
        JSON.parse(readFileSync(rootFile, 'utf8')),
        Bun.JSONC.parse(readFileSync(lockFile, 'utf8')),
        manifests,
        consumerTools,
        compilerInputs,
      ),
    ),
  );
}
