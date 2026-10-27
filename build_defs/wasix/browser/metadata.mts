import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join } from 'node:path';

type Table = Record<string, any>;
const sourceNames = ['wasmer-js', 'wasmer-wasix', 'wasmer', 'virtual-fs', 'virtual-mio'];

export function browserSources(source: Table) {
  const sources = sourceNames.map((name) => {
    const pin = source[name];
    if (
      !pin ||
      pin.name !== (name === 'wasmer-js' ? '@wasmer/sdk' : name) ||
      !/^\d+\.\d+\.\d+$/.test(pin.version ?? '')
    )
      throw new Error(`Invalid canonical browser source ${name}`);
    if (name === 'wasmer-js') {
      if (
        pin.url !== 'https://github.com/wasmerio/wasmer-js.git' ||
        !/^[a-f0-9]{40}$/.test(pin.commit)
      )
        throw new Error('Invalid immutable Wasmer JS source');
      return { ...pin, name, directory: name };
    }
    if (
      pin.url !== `https://static.crates.io/crates/${name}/${name}-${pin.version}.crate` ||
      !/^[a-f0-9]{64}$/.test(pin.sha256)
    )
      throw new Error(`Invalid immutable browser crate ${name}`);
    return { ...pin, name, directory: `${name}-${pin.version}` };
  });
  const series = source.patches?.series;
  if (!Array.isArray(series) || !series.length || new Set(series).size !== series.length)
    throw new Error('Browser patch series must be non-empty and unique');
  const patches = series.map((name: string) => {
    const match =
      /^\d{4}-(wasmer-js|wasmer-wasix|wasmer|virtual-fs|virtual-mio)-[a-z0-9-]+\.patch$/.exec(name);
    if (!match) throw new Error(`Unsafe canonical browser patch ${name}`);
    return { name, source: match[1] };
  });
  return { sources, patches };
}

/** Acquisition facts for crate_universe's existing HTTP source provider. */
export function browserCargoSources(source: Table) {
  const contract = browserSources(source);
  return Object.fromEntries(
    contract.sources.slice(1).map((row) => [
      `${row.name} ${row.version}`,
      {
        url: row.url,
        sha256: row.sha256,
        strip_prefix: row.directory,
        patches: contract.patches
          .filter((patch) => patch.source === row.name)
          .map((patch) => `patches/${patch.name}`),
      },
    ]),
  );
}

export function browserRustFlags(value: unknown): string[] {
  const flags = typeof value === 'string' ? value.trim().split(/\s+/) : value;
  if (
    !Array.isArray(flags) ||
    !flags.length ||
    flags.some((flag) => typeof flag !== 'string' || !flag)
  )
    throw new Error('Canonical browser rustflags must be a non-empty Cargo argument list');
  return [...flags];
}

export function browserNpmAcquisition(
  manifest: Table,
  lock: Table,
  compilerImports: string[],
  platform = { os: 'linux', cpu: 'x64' },
) {
  if (
    lock.lockfileVersion !== 3 ||
    lock.packages?.['']?.name !== manifest.name ||
    lock.packages[''].version !== manifest.version
  )
    throw new Error('Browser npm lock has a stale conventional package identity');
  const result: Table = {};
  const visiting = new Set<string>();
  const accepts = (items: string[] | undefined, value: string) =>
    !items ||
    ((!items.some((item) => !item.startsWith('!')) || items.includes(value)) &&
      !items.includes(`!${value}`));
  function locate(parent: string, name: string): string | undefined {
    let cursor = parent;
    for (;;) {
      const candidate = [cursor, 'node_modules', name].filter(Boolean).join('/');
      if (lock.packages[candidate]) return candidate;
      if (!cursor) return undefined;
      cursor = dirname(cursor).replaceAll('\\', '/');
      if (cursor === '.') cursor = '';
      if (cursor.endsWith('node_modules')) cursor = dirname(cursor).replaceAll('\\', '/');
      if (cursor === '.' || cursor === 'node_modules') cursor = '';
    }
  }
  function record(key: string, name: string, requirement: string): string {
    const row = lock.packages[key];
    if (
      !row ||
      !Bun.semver.satisfies(row.version, requirement) ||
      !/^sha512-[A-Za-z0-9+/]+=*$/.test(row.integrity ?? '') ||
      row.resolved !==
        `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${row.version}.tgz`
    )
      throw new Error(`Missing exact integrity-bearing browser npm resolution for ${key}`);
    const id = `p_${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
    if (result[id]) return id;
    if (visiting.has(key)) throw new Error(`Browser compiler npm dependency cycle at ${key}`);
    visiting.add(key);
    const dependencies: Record<string, string> = {};
    const requirements = {
      ...row.dependencies,
      ...row.optionalDependencies,
      ...row.peerDependencies,
    };
    for (const [dependency, range] of Object.entries(requirements) as [string, string][]) {
      const child = locate(key, dependency);
      const optional =
        dependency in (row.optionalDependencies ?? {}) ||
        row.peerDependenciesMeta?.[dependency]?.optional;
      if (!child) {
        if (optional) continue;
        throw new Error(`Missing locked browser compiler dependency ${key} -> ${dependency}`);
      }
      const target = lock.packages[child];
      if (!accepts(target.os, platform.os) || !accepts(target.cpu, platform.cpu)) {
        if (optional) continue;
        throw new Error(
          `Browser compiler dependency ${child} is unavailable on ${platform.os}/${platform.cpu}`,
        );
      }
      dependencies[dependency] = record(child, dependency, range);
    }
    result[id] = {
      key,
      package: name,
      version: row.version,
      integrity: row.integrity,
      url: row.resolved,
      dependencies,
    };
    visiting.delete(key);
    return id;
  }
  const roots: Record<string, string> = {};
  for (const name of new Set([
    ...compilerImports,
    ...Object.keys(manifest.dependencies ?? {}),
    'typescript',
    '@types/node',
  ])) {
    const requirement = manifest.dependencies?.[name] ?? manifest.devDependencies?.[name];
    const locked =
      lock.packages[''].dependencies?.[name] ?? lock.packages[''].devDependencies?.[name];
    if (!requirement || locked !== requirement)
      throw new Error(`Stale canonical browser npm declaration ${name}`);
    const key = locate('', name);
    if (!key) throw new Error(`Missing browser compiler acquisition ${name}`);
    roots[name] = record(key, name, requirement);
  }
  return { roots, packages: result, platform };
}

function projectContext(root: string, source: Table, sourceFile: string) {
  const contract = browserSources(source);
  const js = join(root, 'wasmer-js');
  const read = (file: string) => readFileSync(join(js, file), 'utf8');
  const manifest = Bun.TOML.parse(read('Cargo.toml'));
  const lockText = read('Cargo.lock');
  const lock = Bun.TOML.parse(lockText);
  if (
    lock.version !== 4 ||
    manifest.package?.name !== 'wasmer-js' ||
    manifest.lib?.['crate-type']?.join(',') !== 'cdylib'
  )
    throw new Error('Unexpected canonical browser Cargo construction contract');
  const patched = Object.fromEntries(
    contract.sources
      .filter((row) => row.name !== 'wasmer-js')
      .map((row) => [
        row.name,
        Bun.TOML.parse(readFileSync(join(root, row.directory, 'Cargo.toml'), 'utf8')),
      ]),
  );
  const originals = Object.fromEntries(
    contract.sources
      .filter((row) => row.name !== 'wasmer-js')
      .map((row) => [
        row.name,
        Bun.TOML.parse(readFileSync(join(root, '_original_manifests', `${row.name}.toml`), 'utf8')),
      ]),
  );
  writeFileSync(
    join(js, 'Cargo.bazel.lock'),
    projectPatchedCargoLock(source, patched, lockText, originals),
  );
  writeFileSync(join(root, 'Cargo.bazel.toml'), browserCargoWorkspace(source, manifest));
  const npm = JSON.parse(read('package.json'));
  if (npm.name !== source['wasmer-js'].name || npm.version !== source['wasmer-js'].version)
    throw new Error('Canonical browser npm source version differs from the source manifest');
  const toolchain = Bun.TOML.parse(read('rust-toolchain.toml')).toolchain;
  const config = Bun.TOML.parse(read('.cargo/config.toml'));
  if (
    !/^nightly-\d{4}-\d{2}-\d{2}$/.test(toolchain.channel) ||
    config.build?.target !== 'wasm32-unknown-unknown' ||
    config.unstable?.['build-std']?.join(',') !== 'std,panic_abort'
  )
    throw new Error('Browser requires its exact nightly wasm32 atomics sysroot construction');
  const bindgen = lock.package.filter((row: Table) => row.name === 'wasm-bindgen');
  if (
    bindgen.length !== 1 ||
    manifest.dependencies['wasm-bindgen'].version !== `=${bindgen[0].version}`
  )
    throw new Error('Browser wasm-bindgen CLI must match its exact Cargo lock version');
  const imports = new Bun.Transpiler({ loader: 'js' })
    .scanImports(read('rollup.config.mjs'))
    .map((row) => row.path)
    .filter((name) => !name.startsWith('.') && !isBuiltin(name));
  const acquisition = browserNpmAcquisition(npm, JSON.parse(read('package-lock.json')), imports);
  return {
    ...contract,
    cargoSources: browserCargoSources(source),
    sourceInputs: Object.fromEntries(
      [
        ['src/wasix/browser-host/source.toml', sourceFile],
        ...contract.patches.map((patch) => [
          `src/wasix/browser-host/patches/${patch.name}`,
          join(dirname(sourceFile), 'patches', patch.name),
        ]),
      ].map(([name, file]) => [
        name,
        createHash('sha256').update(readFileSync(file)).digest('hex'),
      ]),
    ),
    acquisition,
    npm,
    rust: {
      channel: toolchain.channel,
      edition: manifest.package.edition,
      target: config.build.target,
      flags: browserRustFlags(config.target[config.build.target].rustflags),
      buildStd: config.unstable['build-std'],
      profile: manifest.profile.release,
    },
    bindgen: {
      version: bindgen[0].version,
      profile: manifest.package.metadata['wasm-pack'].profile.release['wasm-bindgen'],
    },
    wasmOpt: manifest.package.metadata['wasm-pack'].profile.release['wasm-opt'],
  };
}

/** Preserve sibling patches without making their default features workspace roots. */
export function browserCargoWorkspace(source: Table, manifest: Table): string {
  const crates = browserSources(source).sources.filter((row) => row.name !== 'wasmer-js');
  const patches = manifest.patch?.['crates-io'];
  if (!patches || Object.keys(patches).length !== crates.length || manifest.workspace)
    throw new Error('Unexpected canonical browser path-patch workspace');
  const lines = [
    '[workspace]',
    'members = ["wasmer-js"]',
    `exclude = ${JSON.stringify(crates.map((row) => row.directory))}`,
    'resolver = "2"',
    '',
    '[patch.crates-io]',
  ];
  for (const row of crates) {
    if (
      patches[row.name]?.path !== `../${row.directory}` ||
      Object.keys(patches[row.name]).join(',') !== 'path'
    )
      throw new Error(`Unexpected canonical browser patch path ${row.name}`);
    lines.push(`${row.name} = { path = ${JSON.stringify(row.directory)} }`);
  }
  lines.push('', '[profile.release]');
  for (const [name, value] of Object.entries(manifest.profile.release)) {
    if (!['number', 'boolean', 'string'].includes(typeof value))
      throw new Error(`Unsupported browser Cargo profile field ${name}`);
    lines.push(`${name} = ${JSON.stringify(value)}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Keep every canonical resolution; only path-source identity and new patch edges change. */
export function projectPatchedCargoLock(
  source: Table,
  manifests: Table,
  original: string,
  originals: Table,
): string {
  const lock = Bun.TOML.parse(original);
  const blocks = original.split('\n[[package]]\n');
  for (const [name, manifest] of Object.entries(manifests) as [string, Table][]) {
    const pin = source[name];
    const candidates = lock.package.filter(
      (row: Table) => row.name === name && row.version === pin.version,
    );
    if (
      candidates.length !== 1 ||
      candidates[0].checksum !== pin.sha256 ||
      manifest.package?.name !== name ||
      manifest.package.version !== pin.version
    )
      throw new Error(
        `Patched browser Cargo source differs from its canonical lock entry: ${name}`,
      );
    const row = candidates[0];
    const dependencies = [...(row.dependencies ?? [])];
    const tables = Object.entries({ root: manifest, ...manifest.target }) as [string, Table][];
    for (const [condition, table] of tables)
      for (const declaration of ['dependencies', 'build-dependencies'])
        for (const [alias, specification] of Object.entries(table[declaration] ?? {}) as [
          string,
          any,
        ][]) {
          const target = specification?.package ?? alias;
          const before =
            condition === 'root' ? originals[name] : originals[name]?.target?.[condition];
          if (JSON.stringify(before?.[declaration]?.[alias]) === JSON.stringify(specification))
            continue;
          const existing = dependencies.filter((value) => value.split(' ')[0] === target);
          const requirement =
            typeof specification === 'string' ? specification : specification.version;
          const range = /^\d/.test(requirement) ? `^${requirement}` : requirement;
          const candidates = lock.package.filter((value: Table) => value.name === target);
          const matching = candidates.filter(
            (value: Table) =>
              Bun.semver.satisfies(value.version, range) &&
              (!existing.length ||
                existing.some(
                  (dependency) =>
                    (dependency === target && candidates.length === 1) ||
                    dependency.split(' ')[1] === value.version,
                )),
          );
          if (matching.length !== 1)
            throw new Error(
              `Patch requires a missing or ambiguous canonical Cargo resolution: ${name} -> ${target}`,
            );
          if (existing.length) continue;
          dependencies.push(
            lock.package.filter((value: Table) => value.name === target).length === 1
              ? target
              : `${target} ${matching[0].version}`,
          );
        }
    const index = blocks.findIndex((block) =>
      block.startsWith(`name = "${name}"\nversion = "${pin.version}"\n`),
    );
    if (index === -1) throw new Error(`Cannot project canonical browser Cargo lock block ${name}`);
    blocks[index] = blocks[index].replace(/^source = .*\nchecksum = .*\n/m, '').replace(
      /dependencies = \[[\s\S]*?\]/,
      `dependencies = [\n${dependencies
        .sort()
        .map((value) => ` ${JSON.stringify(value)},`)
        .join('\n')}\n]`,
    );
  }
  return blocks.join('\n[[package]]\n');
}

if (import.meta.main) {
  const [mode, sourceFile, root] = Bun.argv.slice(2);
  if (!sourceFile || !['sources', 'context'].includes(mode))
    throw new Error('Expected sources|context SOURCE.toml [ROOT]');
  const source = Bun.TOML.parse(readFileSync(sourceFile, 'utf8'));
  const data =
    mode === 'sources' ? browserSources(source) : projectContext(root, source, sourceFile);
  if (mode === 'context') writeFileSync(join(root, 'metadata.json'), JSON.stringify(data));
  console.log(JSON.stringify(data));
}
