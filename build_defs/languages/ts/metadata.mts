import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { readPortableArchiveEntries } from '../../../tools/packaging/portable-archive.mts';
import { dirname, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

type Manifest = {
  name: string;
  version: string;
  type?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
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
        bin?: string | Record<string, string>;
        os?: string;
        cpu?: string;
      },
      string,
    ]
  >;
};
type SupplierArchive = {
  publication: { product: string; version: string; [key: string]: unknown };
  artifact: string;
  file: { path: string; size: number; sha256: string };
  /** Generated repository alias for this same captured File. */
  archive: string;
};

/** Check the actual npm File; completion/origin authentication remains the controller's job. */
export function validateJavascriptDependencyArchive(
  file: string,
  name: string,
  version: string,
  identity?: { size: number; sha256: string },
) {
  const source = realpathSync(file);
  const before = statSync(source);
  if (!before.isFile() || (identity && before.size !== identity.size))
    throw new Error(`JavaScript dependency ${name} File size differs`);
  if (before.size > 512 * 1024 * 1024)
    throw new Error('JavaScript dependency archive exceeds 512 MiB');
  if (
    identity &&
    createHash('sha256').update(readFileSync(source)).digest('hex') !== identity.sha256
  )
    throw new Error(`JavaScript dependency ${name} File digest differs`);
  const packed = readPortableArchiveEntries(source).get('package/package.json');
  if (!packed?.isFile || packed.isSymbolicLink)
    throw new Error(`JavaScript dependency ${name} has no packed manifest`);
  const manifest = JSON.parse(packed.data().toString('utf8'));
  if (manifest.name !== name || manifest.version !== version)
    throw new Error(`JavaScript dependency ${name} packed identity differs`);
  const after = statSync(source);
  if (
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  )
    throw new Error(`JavaScript dependency ${name} File changed during capture`);
  return manifest as Manifest;
}

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
  dependencyManifests: Record<string, Manifest> = {},
  executionWorkspaces: string[] = [],
  graphWorkspaces: string[] = [],
  {
    supplierArchives = [],
    selectedProducts = [],
    sourceOwners = {},
  }: {
    supplierArchives?: SupplierArchive[];
    selectedProducts?: string[];
    sourceOwners?: Record<string, { id: string; registry_packages: string[] }>;
  } = {},
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
  const consumerBins: Record<string, Record<string, Record<string, string>>> = {};
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
  const selectedManifests = { ...manifests, ...dependencyManifests };
  const lockedPackage = (
    name: string,
    parent: string,
    requirement: string,
    allowOverride = false,
  ) => {
    const override = root.overrides?.[name];
    if (override) {
      if (!allowOverride) throw new Error(`Unsupported JavaScript override for ${name}`);
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
    return { key, entry, version };
  };
  const consumerSelection = { ...consumerTools };
  const execution = new Set(executionWorkspaces);
  const graphs = new Set(graphWorkspaces);
  if (
    graphs.size !== graphWorkspaces.length ||
    graphWorkspaces.some((workspace) => !execution.has(workspace))
  )
    throw new Error('Consumer graph workspace requires one selected execution workspace');
  if (execution.size !== executionWorkspaces.length)
    throw new Error('Duplicate execution workspace selection');
  const catalogRequirement = (name: string, requirement: string) => {
    if (requirement !== 'catalog:') return requirement;
    const range = root.workspaces.catalog?.[name];
    if (!range || lock.catalog?.[name] !== range)
      throw new Error(`bun.lock has a stale catalog declaration for ${name}`);
    return range;
  };
  for (const workspace of executionWorkspaces) {
    const member = Object.entries(selectedManifests).find(
      ([, manifest]) => manifest.name === workspace,
    );
    if (!member || Object.hasOwn(consumerSelection, workspace))
      throw new Error(
        `Execution workspace requires one independent conventional selection ${workspace}`,
      );
    consumerSelection[workspace] = Object.keys({
      ...member[1].dependencies,
      ...member[1].devDependencies,
    })
      .filter(
        (name) =>
          !graphs.has(workspace) ||
          !Object.values(lock.workspaces).some((source) => source.name === name) ||
          /^sha512-[A-Za-z0-9+/]+=*$/.test(
            lock.packages[resolutionKey(name, workspace)]?.[3] ?? '',
          ),
      )
      .sort();
  }
  const onConsumerPlatform = (entry: Lock['packages'][string] | undefined) =>
    Boolean(
      entry?.[2] &&
        (!entry[2].os || entry[2].os === 'linux') &&
        (!entry[2].cpu || entry[2].cpu === 'x64'),
    );
  const consumerProvided = new Map<string, Set<string>>();
  for (const workspace of Object.keys(consumerSelection)) {
    const member = Object.entries(selectedManifests).find(
      ([, manifest]) => manifest.name === workspace,
    );
    if (!member) throw new Error(`Missing conventional consumer workspace ${workspace}`);
    const [path, manifest] = member;
    const provided = new Set<string>();
    const visit = (name: string, parent: string, range: string, optional = false) => {
      const key = resolutionKey(name, parent);
      const entry = lock.packages[key];
      if (!entry?.[2] || !onConsumerPlatform(entry)) {
        if (optional) return;
        throw new Error(`Missing Linux x64 consumer tool dependency ${parent} -> ${name}`);
      }
      lockedPackage(name, parent, range, true);
      if (provided.has(key)) return;
      provided.add(key);
      for (const [dependency, requirement] of Object.entries({
        ...entry[2].dependencies,
        ...entry[2].optionalDependencies,
        ...Object.fromEntries(
          Object.entries(entry[2].peerDependencies ?? {}).filter(
            ([name]) => !entry[2].optionalPeers?.includes(name),
          ),
        ),
      }))
        visit(
          dependency,
          key,
          requirement,
          Object.hasOwn(entry[2].optionalDependencies ?? {}, dependency),
        );
    };
    // Optional peers are supplied by this workspace, not unrelated global lock entries.
    for (const field of ['dependencies', 'devDependencies'] as const)
      for (const name of Object.keys({ ...manifest[field], ...lock.workspaces[path]?.[field] })) {
        const requirement = manifest[field]?.[name];
        if (!requirement || lock.workspaces[path]?.[field]?.[name] !== requirement)
          throw new Error(
            `bun.lock has a stale consumer ${consumerSelection[workspace].includes(name) ? 'tool' : 'provider'} declaration ${workspace}/${name}`,
          );
        const range = catalogRequirement(name, requirement);
        const source = Object.values(lock.workspaces).find((row) => row.name === name);
        if (
          source &&
          !/^sha512-[A-Za-z0-9+/]+=*$/.test(
            lock.packages[resolutionKey(name, workspace)]?.[3] ?? '',
          )
        )
          continue;
        visit(name, workspace, range);
      }
    consumerProvided.set(workspace, provided);
  }
  const record = (
    name: string,
    parent: string,
    requirement: string,
    consumer = false,
    compiler = false,
    consumerWorkspace = '',
  ): string => {
    const { key, entry, version } = lockedPackage(name, parent, requirement, consumer || compiler);
    if (consumer && !onConsumerPlatform(entry))
      throw new Error(`Consumer tool ${key} does not support Linux x64`);
    const identity = `${consumer ? `consumer:${consumerWorkspace}:` : compiler ? 'compiler:' : ''}${key}`;
    const result = consumer ? consumerPackages : compiler ? compilerPackages : packages;
    const existing = ids.get(identity);
    if (existing) return existing;
    if (visiting.has(identity)) throw new Error(`Cycle in JavaScript type dependencies at ${key}`);
    const context = consumer && graphs.has(consumerWorkspace) ? `/${consumerWorkspace}/${key}` : '';
    const id = `p_${createHash('sha256').update(`${name}@${version}${context}`).digest('hex').slice(0, 16)}`;
    if (compiler || (consumer && graphs.has(consumerWorkspace))) ids.set(identity, id);
    visiting.add(identity);
    const dependencies: Record<string, string> = {};
    const requirements = consumer
      ? {
          ...entry[2].peerDependencies,
          ...entry[2].dependencies,
          ...entry[2].optionalDependencies,
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
        const optionalPeer =
          entry[2].optionalPeers?.includes(dependency) &&
          !Object.hasOwn(entry[2].dependencies ?? {}, dependency) &&
          !Object.hasOwn(entry[2].optionalDependencies ?? {}, dependency);
        const optional =
          Object.hasOwn(entry[2].optionalDependencies ?? {}, dependency) || optionalPeer;
        const child = lock.packages[resolutionKey(dependency, key)];
        if (
          optionalPeer &&
          (!consumerProvided.get(consumerWorkspace)?.has(resolutionKey(dependency, key)) ||
            !child ||
            !Bun.semver.satisfies(
              child[0].slice(dependency.length + 1),
              root.overrides?.[dependency] ?? range,
            ))
        )
          continue;
        if (!onConsumerPlatform(child)) {
          if (optional) continue;
          throw new Error(`Missing Linux x64 consumer tool dependency ${key} -> ${dependency}`);
        }
      }
      dependencies[dependency] = record(
        dependency,
        key,
        range,
        consumer,
        compiler,
        consumerWorkspace,
      );
    }
    const resolved = {
      package: name,
      version,
      integrity: entry[3],
      dependencies,
      ...(compiler && entry[2].os ? { os: entry[2].os } : {}),
      ...(compiler && entry[2].cpu ? { cpu: entry[2].cpu } : {}),
    };
    if (result[id] && !isDeepStrictEqual(result[id], resolved))
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
      dependencyInputs?: Record<string, Record<string, unknown>>;
    }
  > = {};
  for (const path of Object.keys(dependencyManifests))
    if (Object.hasOwn(manifests, path))
      throw new Error(
        `JavaScript workspace ${path} is selected as both compiler and dependency input`,
      );
  let typescript: { package: string; version: string; integrity: string } | undefined;
  for (const [path, manifest] of Object.entries(selectedManifests).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const workspace = lock.workspaces[path];
    if (workspace?.name !== manifest.name || workspace.version !== manifest.version)
      throw new Error(`bun.lock has a stale workspace identity for ${path}`);
    const types: Record<string, string> = {};
    for (const name of Object.hasOwn(manifests, path)
      ? [
          'typescript',
          ...Object.keys(manifest.devDependencies ?? {}).filter((name) =>
            name.startsWith('@types/'),
          ),
        ]
      : []) {
      let requirement = manifest.devDependencies?.[name];
      if (workspace.devDependencies?.[name] !== requirement || !requirement)
        throw new Error(`bun.lock has a stale workspace declaration for ${path}/${name}`);
      requirement = catalogRequirement(name, requirement);
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
    const dependencyInputs: Record<string, Record<string, unknown>> = {};
    for (const [name, requirement] of Object.hasOwn(manifests, path)
      ? Object.entries(dependencies)
      : []) {
      if (workspace.dependencies?.[name] !== requirement)
        throw new Error(`bun.lock has a stale workspace dependency for ${path}/${name}`);
      const target = Object.entries(selectedManifests).find(([, row]) => row.name === name);
      const range = requirement.startsWith('workspace:')
        ? requirement.slice('workspace:'.length)
        : requirement;
      const current =
        target && Bun.semver.satisfies(target[1].version, ['^', '~'].includes(range) ? '*' : range);
      const owner = target && sourceOwners[target[0]];
      const owns = Boolean(owner?.registry_packages.includes(`npm:${name}`));
      const selected = Boolean(owns && selectedProducts.includes(owner!.id));
      if (current && (requirement.startsWith('workspace:') || selected)) {
        dependencyInputs[name] = {
          source: 'workspace',
          workspace: target[0],
          version: target[1].version,
          ...(owns ? { owner: owner!.id } : {}),
        };
      } else if (requirement.startsWith('workspace:')) {
        throw new Error(
          `Native JavaScript dependency ${name} must match its conventional workspace version`,
        );
      } else {
        const captured = supplierArchives.filter(
          (row) =>
            row.artifact === `npm:${name}` &&
            Bun.semver.satisfies(row.publication.version, range) &&
            (!owns || row.publication.product === owner!.id),
        );
        if (captured.length > 1)
          throw new Error(`Ambiguous completed JavaScript dependency ${name}`);
        if (captured.length) {
          const row = captured[0];
          if (!/^@[A-Za-z0-9_.+-]+\/\/:/.test(row.archive))
            throw new Error(
              `Completed JavaScript dependency ${name} needs its captured File alias`,
            );
          const packageManifest = validateJavascriptDependencyArchive(
            row.file.path,
            name,
            row.publication.version,
            row.file,
          );
          if (
            Object.keys(packageManifest.optionalDependencies ?? {}).length ||
            Object.keys(packageManifest.peerDependencies ?? {}).length
          )
            throw new Error(
              `Completed JavaScript dependency ${name} requires an explicit optional/peer closure`,
            );
          const children: Record<string, string> = {};
          for (const [child, childRequirement] of Object.entries(
            packageManifest.dependencies ?? {},
          ))
            children[child] = record(
              child,
              resolutionKey(name, manifest.name),
              childRequirement as string,
            );
          dependencyInputs[name] = {
            source: 'completed',
            archive: row.archive,
            version: packageManifest.version,
            publication: row.publication,
            artifact: row.artifact,
            size: row.file.size,
            sha256: row.file.sha256,
            packages: children,
          };
        } else {
          const key = resolutionKey(name, manifest.name);
          const entry = lock.packages[key];
          if (
            entry?.[0].startsWith(`${name}@`) &&
            entry[1] === '' &&
            /^sha512-[A-Za-z0-9+/]+=*$/.test(entry[3] ?? '')
          ) {
            const id = record(name, manifest.name, requirement);
            if (!target) runtimePackages[name] = id;
            dependencyInputs[name] = {
              source: 'registry',
              package: id,
              version: packages[id].version,
              packages: packages[id].dependencies,
            };
          } else if (target || Object.values(lock.workspaces).some((row) => row.name === name)) {
            dependencyInputs[name] = {
              source: 'unverified',
              requirement,
              reason: 'missing completed archive or selected source owner',
            };
          } else {
            const id = record(name, manifest.name, requirement);
            if (!target) runtimePackages[name] = id;
            dependencyInputs[name] = {
              source: 'registry',
              package: id,
              version: packages[id].version,
              packages: packages[id].dependencies,
            };
          }
        }
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
      ...(Object.keys(dependencyInputs).length ? { dependencyInputs } : {}),
    };
    if (Object.keys(runtimePackages).length) workspaces[manifest.name].packages = runtimePackages;
  }
  if (!typescript) throw new Error('Selected workspaces have no TypeScript compiler');
  // The compiler is acquired by aspect_rules_ts from the same lock-derived facts.
  for (const id of Object.keys(packages))
    if (packages[id].package === 'typescript') delete packages[id];
  for (const [workspace, tools] of Object.entries(consumerSelection)) {
    const member = Object.entries(selectedManifests).find(
      ([, manifest]) => manifest.name === workspace,
    );
    if (!member || !tools.length || new Set(tools).size !== tools.length)
      throw new Error(`Consumer tools require one selected conventional workspace ${workspace}`);
    const [path, manifest] = member;
    consumerRoots[workspace] = {};
    consumerBins[workspace] = {};
    for (const name of tools) {
      const field = manifest.devDependencies?.[name] ? 'devDependencies' : 'dependencies';
      let requirement = manifest[field]?.[name];
      if (!requirement || lock.workspaces[path][field]?.[name] !== requirement)
        throw new Error(`bun.lock has a stale consumer tool declaration ${workspace}/${name}`);
      requirement = catalogRequirement(name, requirement);
      consumerRoots[workspace][name] = record(name, workspace, requirement, true, false, workspace);
      const bin = lock.packages[resolutionKey(name, workspace)][2].bin;
      if (bin) {
        const bins =
          typeof bin === 'string' ? { [name.slice(name.lastIndexOf('/') + 1)]: bin } : bin;
        consumerBins[workspace][name] = {};
        for (const [command, path] of Object.entries(bins)) {
          if (
            !command ||
            command === '.' ||
            command === '..' ||
            /[/\\:\u0000-\u001f\u007f]/u.test(command) ||
            typeof path !== 'string' ||
            /[\\:\u0000-\u001f\u007f]/u.test(path)
          )
            throw new Error(`Invalid consumer CLI declaration ${name}/${command}`);
          const relative = path.replace(/^\.\//u, '');
          if (relative.split('/').some((part) => !part || part === '.' || part === '..'))
            throw new Error(`Consumer CLI path must stay inside ${name}`);
          consumerBins[workspace][name][command] = relative;
        }
      }
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
      requirement = catalogRequirement(name, requirement);
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
  const closure = (records: typeof packages, roots: string[]) => {
    const ids = new Set<string>();
    const pending = [...roots];
    for (let current = pending.pop(); current; current = pending.pop()) {
      if (ids.has(current)) continue;
      ids.add(current);
      pending.push(...Object.values(records[current].dependencies));
    }
    return [...ids].sort();
  };
  const sharedCompilerPackages = Object.keys(compilerPackages)
    .filter((id) => Object.hasOwn(packages, id))
    .sort();
  for (const id of sharedCompilerPackages)
    if (!isDeepStrictEqual(compilerPackages[id], packages[id]))
      throw new Error(`Conflicting compiler/type acquisition context for ${packages[id].package}`);
  for (const id of Object.keys(compilerPackages))
    compilerClosures[id] = closure(compilerPackages, [id]);
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
            bins: consumerBins,
            closures: Object.fromEntries(
              Object.entries(consumerRoots).map(([workspace, roots]) => [
                workspace,
                closure(consumerPackages, Object.values(roots)),
              ]),
            ),
            packages: consumerPackages,
            platform: { os: 'linux', cpu: 'x64' },
          },
        }
      : {}),
  };
}

if (import.meta.main && Bun.argv[2] === '--verify-dependency') {
  const [, , , file, output, name, version, size, sha256] = Bun.argv;
  if (!file || !output || !name || !version)
    throw new Error('Expected dependency File, output, name and version');
  const identity = sha256 ? { size: Number(size), sha256 } : undefined;
  validateJavascriptDependencyArchive(file, name, version, identity);
  copyFileSync(file, output);
  validateJavascriptDependencyArchive(output, name, version, identity);
} else if (import.meta.main) {
  const [rootFile, lockFile, ...parameters] = Bun.argv.slice(2);
  const dependencyOptions = parameters.filter((value) => value.startsWith('--dependency-inputs='));
  if (dependencyOptions.length > 1)
    throw new Error('Expected at most one dependency input projection');
  const dependencyInputs = dependencyOptions.length
    ? JSON.parse(readFileSync(dependencyOptions[0].slice('--dependency-inputs='.length), 'utf8'))
    : {};
  const options = parameters.filter((value) => value.startsWith('--consumer-tools='));
  const executionOptions = parameters.filter((value) => value.startsWith('--consumer-workspace='));
  const graphOptions = parameters.filter((value) =>
    value.startsWith('--consumer-graph-workspace='),
  );
  const compilerOptions = parameters.filter((value) => value.startsWith('--compiler-inputs='));
  const dependencyFiles = parameters
    .filter((value) => value.startsWith('--dependency-manifest='))
    .map((value) => value.slice('--dependency-manifest='.length));
  if (options.length > 1) throw new Error('Expected at most one consumer tool selection');
  if (compilerOptions.length > 1) throw new Error('Expected at most one compiler input selection');
  const manifestFiles = parameters.filter(
    (value) =>
      !value.startsWith('--consumer-tools=') &&
      !value.startsWith('--consumer-workspace=') &&
      !value.startsWith('--consumer-graph-workspace=') &&
      !value.startsWith('--compiler-inputs=') &&
      !value.startsWith('--dependency-manifest=') &&
      !value.startsWith('--dependency-inputs='),
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
  const readManifests = (files: string[]) =>
    Object.fromEntries(
      files.map((file) => [
        relative(root, dirname(file)).split('\\').join('/'),
        JSON.parse(readFileSync(file, 'utf8')),
      ]),
    );
  console.log(
    JSON.stringify(
      importJavascriptMetadata(
        JSON.parse(readFileSync(rootFile, 'utf8')),
        Bun.JSONC.parse(readFileSync(lockFile, 'utf8')),
        readManifests(manifestFiles),
        consumerTools,
        compilerInputs,
        readManifests(dependencyFiles),
        executionOptions.map((value) => value.slice('--consumer-workspace='.length)),
        graphOptions.map((value) => value.slice('--consumer-graph-workspace='.length)),
        {
          ...dependencyInputs,
          sourceOwners: Object.fromEntries(
            [...manifestFiles, ...dependencyFiles].flatMap((file) => {
              const descriptor = `${dirname(file)}/release.toml`;
              return existsSync(descriptor)
                ? [
                    [
                      relative(root, dirname(file)).split('\\').join('/'),
                      Bun.TOML.parse(readFileSync(descriptor, 'utf8')),
                    ],
                  ]
                : [];
            }),
          ),
        },
      ),
    ),
  );
}
