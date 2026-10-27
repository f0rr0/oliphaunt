/** Compile final extracted source packages against genuine closed Cargo inputs. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  cargoDependencyMinimum,
  renderCargoToml,
  resolveCargoWorkspaceInheritance,
} from '../../../tools/packaging/cargo-manifest.mts';
import {
  assertCargoSourceArtifacts,
  stageCargoCarrierInputs,
} from '../../../tools/packaging/frozen-cargo.mts';
import { readRuntimeCargoFamily } from '../../../tools/packaging/wasix-runtime-cargo-family.mts';
import { type CargoLinkConfiguration, cargoLinkEnvironment } from '../cargo-environment.mts';
import { cargoSatisfies } from '../cargo-metadata.mts';
import {
  type CargoPayloadRow,
  cargoCandidate,
  cargoPayloadInputs,
  cargoPayloadPool,
} from './consumer.mts';
import { type RegistryContext, validateRegistryContext, writeRegistryIndex } from './context.mts';

type Candidate = ReturnType<typeof cargoCandidate>;

type SourceInput = { manifest: string; workspace: string };

/** Original path intent must identify one of the explicitly supplied source packages. */
export function currentPathDependencies(
  sources: Record<string, SourceInput>,
  localNames = new Set(Object.keys(sources)),
) {
  const result: Record<string, string[]> = {};
  for (const [name, source] of Object.entries(sources)) {
    const original = Bun.TOML.parse(readFileSync(source.manifest, 'utf8'));
    const workspace = Bun.TOML.parse(readFileSync(source.workspace, 'utf8')).workspace ?? {};
    const manifest = resolveCargoWorkspaceInheritance(original, workspace);
    assert.equal(manifest.package.name, name);
    const adopted = new Set<string>();
    for (const [target, table] of [['', manifest], ...Object.entries(manifest.target ?? {})] as [
      string,
      any,
    ][]) {
      const authored = target ? original.target[target] : original;
      for (const section of ['dependencies', 'dev-dependencies', 'build-dependencies']) {
        for (const [alias, dependency] of Object.entries(table[section] ?? {}) as [string, any][]) {
          if (!dependency?.path) continue;
          const packageName = dependency.package ?? alias;
          // Linked payload carriers remain genuine registry inputs in this worker.
          if (!localNames.has(packageName)) continue;
          const supplier = sources[packageName];
          assert(supplier, `Missing explicit current path archive: ${packageName}`);
          const base =
            authored[section]?.[alias]?.workspace === true ? source.workspace : source.manifest;
          assert.equal(
            realpathSync(
              path.resolve(path.dirname(realpathSync(base)), dependency.path, 'Cargo.toml'),
            ),
            realpathSync(supplier.manifest),
            `Current path does not identify the declared source archive: ${packageName}`,
          );
          adopted.add(packageName);
        }
      }
    }
    result[name] = [...adopted];
  }
  return result;
}

/** Retain published requirements; explicit paths qualify current construction before versioning. */
export function sourceCandidates(
  root: Candidate,
  pool: Candidate[],
  lockText: string,
  heldPool: Candidate[] = [],
  {
    minimum = false,
    currentPaths = {},
    includeDev = true,
    sourceOwners = {},
    selectedProducts = [],
    payloadNames = new Set<string>(),
  }: {
    minimum?: boolean;
    currentPaths?: Record<string, string[]>;
    includeDev?: boolean;
    sourceOwners?: Record<string, { product: string; version: string }>;
    selectedProducts?: string[];
    payloadNames?: ReadonlySet<string>;
  } = {},
) {
  const lock = Bun.TOML.parse(lockText);
  assert.equal(lock.version, 4);
  const locals = new Map<string, any>();
  for (const row of lock.package.filter((row: any) => row.source === undefined)) {
    assert(!locals.has(row.name), `Ambiguous captured local package: ${row.name}`);
    assert(
      !lock.package.some((other: any) => other.name === row.name && other.source),
      `Captured local/registry identity overlaps: ${row.name}`,
    );
    locals.set(row.name, row);
  }
  for (const name of payloadNames) locals.delete(name);
  const available = (rows: Candidate[]) => {
    const result = new Map<string, Candidate>();
    for (const row of rows) {
      assert(locals.has(row.name), `Undeclared local archive: ${row.name}`);
      const key = `${row.name}@${row.version}`;
      const previous = result.get(key);
      assert(
        !previous || previous.sha256 === row.sha256,
        `Conflicting actual local archive: ${key}`,
      );
      result.set(key, row);
    }
    return result;
  };
  const current = available([root, ...pool]),
    completed = available(heldPool);
  const selected = new Map([[root.name, root]]);
  const currentOwners = new Set([root.name]);
  const pending = [root];
  for (const owner of pending) {
    const requirements = new Map<string, string[]>();
    for (const table of [owner.manifest, ...Object.values(owner.manifest.target ?? {})] as any[]) {
      for (const section of [
        'dependencies',
        ...(includeDev ? ['dev-dependencies'] : []),
        'build-dependencies',
      ]) {
        for (const [alias, declaration] of Object.entries(table[section] ?? {})) {
          const dependency =
            typeof declaration === 'string' ? { version: declaration } : (declaration as any);
          const name = dependency.package ?? alias;
          if (!locals.has(name)) continue;
          assert(
            typeof dependency.version === 'string' &&
              !dependency.path &&
              !dependency.git &&
              !dependency.workspace,
            `Local requirement is not conventional: ${name}`,
          );
          requirements.set(name, [...(requirements.get(name) ?? []), dependency.version]);
        }
      }
    }
    for (const [name, ranges] of requirements) {
      const already = selected.get(name);
      if (already) {
        assert(
          ranges.every((range) => cargoSatisfies(already.version, range)),
          `Conflicting packaged local requirement: ${name} ${ranges.join(', ')}`,
        );
        if (!minimum && currentOwners.has(owner.name) && currentPaths[owner.name]?.includes(name))
          assert(currentOwners.has(name), `Current path overlaps a held source identity: ${name}`);
        continue;
      }
      const matching = [...current.values()].filter(
        (row) => row.name === name && ranges.every((range) => cargoSatisfies(row.version, range)),
      );
      let chosen: Candidate | undefined;
      let fromCurrent = false;
      if (minimum) {
        const floor = cargoDependencyMinimum(ranges);
        const key = `${name}@${floor}`;
        const held = completed.get(key);
        chosen = held ?? current.get(key);
        const owner = sourceOwners[name];
        assert(
          chosen &&
            (held || (owner?.version === floor && selectedProducts.includes(owner.product))),
          `Missing actual local dependency minimum: ${key}`,
        );
      } else if (currentOwners.has(owner.name) && currentPaths[owner.name]?.includes(name)) {
        assert.equal(matching.length, 1, `Missing or ambiguous current path archive: ${name}`);
        chosen = matching[0];
        fromCurrent = true;
      } else {
        const heldVersion = locals.get(name).version;
        const retainsHeld = ranges.every((range) => cargoSatisfies(heldVersion, range));
        chosen = retainsHeld ? completed.get(`${name}@${heldVersion}`) : matching[0];
        fromCurrent = !retainsHeld;
        assert(!retainsHeld || chosen, `Missing actual held local archive: ${name}@${heldVersion}`);
        assert(
          retainsHeld || matching.length === 1,
          `Missing or ambiguous actual local archive: ${name} ${ranges.join(', ')}`,
        );
      }
      assert(chosen);
      selected.set(name, chosen);
      if (fromCurrent) currentOwners.add(name);
      pending.push(chosen);
    }
  }
  if (includeDev)
    assert.equal(
      selected.size,
      locals.size,
      'Captured local package closure differs from actual source manifests',
    );
  return [...selected.values()];
}

/** Retarget only authenticated local package versions; registry resolution is immutable. */
export function sourceLock(lockText: string, candidates: Candidate[]) {
  const lock = Bun.TOML.parse(lockText);
  const before = structuredClone(lock);
  const replacements = new Map<string, string>();
  for (const candidate of candidates) {
    const rows = lock.package.filter((row: any) => row.name === candidate.name);
    assert.equal(rows.length, 1, `Captured local identity is ambiguous: ${candidate.name}`);
    const row = rows[0];
    assert(
      !row.source && !row.checksum,
      `Registry package cannot be retargeted: ${candidate.name}`,
    );
    if (row.version !== candidate.version) {
      replacements.set(`${row.name} ${row.version}`, `${row.name} ${candidate.version}`);
      row.version = candidate.version;
    }
  }
  if (!replacements.size) return lockText;
  for (const row of lock.package) {
    if (!row.source && row.dependencies)
      row.dependencies = row.dependencies.map(
        (reference: string) => replacements.get(reference) ?? reference,
      );
  }
  assert.deepEqual(
    lock.package.filter((row: any) => row.source),
    before.package.filter((row: any) => row.source),
    'Registry resolution changed during local retarget',
  );
  const rendered = renderCargoToml(lock);
  assert.deepEqual(Bun.TOML.parse(rendered), lock);
  return rendered;
}

const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/** Expand only Bazel-declared family leaves into original parent and part archive inputs. */
export function runtimePayloadPool(
  pool: Parameters<typeof cargoPayloadPool>[0],
  families: (CargoPayloadRow & { configuration: string })[],
  declaredLeaves: readonly string[],
  file: (name: string) => string,
  workspace: string,
) {
  const leaves = declaredLeaves.map((name) =>
    name.startsWith('../') ? name.slice(3) : `${workspace}/${name}`,
  );
  const rows: CargoPayloadRow[] = [];
  const owners = { ...pool.owners };
  const consumed = new Set<string>();
  assert.equal(new Set(leaves).size, leaves.length, 'Runtime Cargo family repeats a declared leaf');
  for (const family of families) {
    const members = leaves.filter((leaf) => path.posix.dirname(leaf) === family.file.path);
    const originals = new Map(members.map((leaf) => [file(leaf), leaf]));
    const { parent, parts } = readRuntimeCargoFamily(
      [...originals.keys()],
      family.configuration === 'portable' ? null : family.configuration,
    );
    assert.equal(family.artifact, `cargo:${parent.name}`, 'Runtime Cargo family parent differs');
    assert.equal(family.version, parent.version, 'Runtime Cargo family version differs');
    for (const archive of [parent, ...parts]) {
      const original = originals.get(archive.file);
      assert(original && !consumed.has(original), 'Runtime Cargo family repeats an original File');
      consumed.add(original);
      const owner = { product: family.product, version: family.version };
      if (owners[archive.name])
        assert.deepEqual(owners[archive.name], owner, 'Runtime Cargo family owner differs');
      owners[archive.name] = owner;
      rows.push({ ...family, artifact: `cargo:${archive.name}`, file: { path: original } });
    }
  }
  assert.equal(consumed.size, leaves.length, 'Runtime Cargo family has an undeclared archive path');
  return { ...pool, current: [...pool.current, ...rows], owners };
}

export async function sourceCompile(
  specification: string,
  runfiles: string,
  { compile = true } = {},
) {
  assert(process.env.TEST_TMPDIR, 'Installed compilation requires an isolated test directory');
  const spec = JSON.parse(readFileSync(specification, 'utf8'));
  const file = (name: string) => path.join(runfiles, name);
  const output = mkdtempSync(path.join(process.env.TEST_TMPDIR, 'installed-source-compile-'));
  try {
    const diagnostics =
      process.env.TEST_UNDECLARED_OUTPUTS_DIR ??
      mkdtempSync(path.join(process.env.TEST_TMPDIR, 'installed-source-diagnostics-'));
    mkdirSync(diagnostics, { recursive: true });
    const archiveDirectory = path.join(output, 'archives');
    mkdirSync(archiveDirectory);
    assert(Array.isArray(spec.archives) && spec.archives.length > 0);
    const archivePool = spec.archives.map((archive: string, index: number) => {
      const copied = path.join(archiveDirectory, `${index}-${path.basename(archive)}`);
      copyFileSync(file(archive), copied);
      return cargoCandidate(copied);
    });
    const heldPool = (spec.held ?? []).map((row: any, index: number) => {
      const copied = path.join(archiveDirectory, `held-${index}-${path.basename(row.file)}`);
      copyFileSync(file(row.file), copied);
      const bytes = readFileSync(copied),
        candidate = cargoCandidate(copied);
      assert.equal(bytes.length, row.size, 'Completed source archive size differs');
      assert.equal(candidate.sha256, row.sha256, 'Completed source archive SHA differs');
      assert.equal(candidate.name, row.name, 'Completed source archive name differs');
      assert.equal(candidate.version, row.version, 'Completed source archive version differs');
      return candidate;
    });
    const capturedLock = readFileSync(file(spec.lock), 'utf8');
    const sourceInputs = Object.fromEntries(
      Object.entries(spec.sources ?? {}).map(([archive, source]: [string, any]) => {
        const candidate = archivePool[spec.archives.indexOf(archive)];
        assert(candidate, 'Original source manifest is outside the explicit archive pool');
        return [
          candidate.name,
          { manifest: file(source.manifest), workspace: file(source.workspace) },
        ];
      }),
    );
    const currentPaths = currentPathDependencies(
      sourceInputs,
      new Set(
        Bun.TOML.parse(capturedLock)
          .package.filter((row: any) => !row.source)
          .map((row: any) => row.name),
      ),
    );
    const familyLeaves: string[] = spec.payloadFamilyFiles
      ? readFileSync(file(spec.payloadFamilyFiles), 'utf8').split('\n').filter(Boolean)
      : [];
    const payloadSpecification = runtimePayloadPool(
      spec.payloadPool ?? { completed: [], current: [], owners: {} },
      spec.payloadFamilies ?? [],
      familyLeaves,
      file,
      spec.workspace,
    );
    const payloadPool = cargoPayloadPool(
      payloadSpecification,
      spec.sourceOwners ?? {},
      file,
      archiveDirectory,
    );
    const payloadNames = new Set(Object.keys(payloadPool.owners));
    const sourcePool = sourceCandidates(
      archivePool[0],
      archivePool.slice(1),
      capturedLock,
      heldPool,
      { currentPaths, payloadNames },
    );
    const payloadOptions = {
      currentSources: archivePool,
      sourceOwners: spec.sourceOwners ?? {},
      selectedProducts: spec.selectedProducts ?? [],
    };
    const candidates = [
      ...sourcePool,
      ...cargoPayloadInputs(sourcePool, payloadPool, payloadOptions),
    ];
    const candidate = sourcePool[0];
    const config = stageCargoCarrierInputs(candidates, output);
    const directory = path.join(output, 'crates', `${candidate.name}-${candidate.version}`);
    const manifest = path.join(directory, 'Cargo.toml');
    const seedLockText = sourceLock(capturedLock, sourcePool);
    const context = JSON.parse(readFileSync(file(spec.index), 'utf8')) as RegistryContext;
    const archives = validateRegistryContext(seedLockText, context);
    const cargoHome = path.join(output, 'cargo-home');
    writeRegistryIndex(context, cargoHome);
    const expected = new Set<string>();
    const registryFiles = (directory: string, relative = '') => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const name = path.posix.join(relative, entry.name);
        if (entry.isDirectory()) registryFiles(path.join(directory, entry.name), name);
        else {
          assert(entry.isFile());
          expected.add(name);
        }
      }
    };
    registryFiles(path.join(cargoHome, 'registry'));
    const checksums = new Map(
      archives.map((archive) => [
        `cache/${context.repository}/${archive.name}-${archive.version}.crate`,
        archive.sha256,
      ]),
    );
    for (const name of checksums.keys()) expected.add(name);
    const supplied = new Set<string>();
    for (const [input, relative] of Object.entries(spec.cargoHome) as [string, string][]) {
      assert(
        expected.has(relative) && !supplied.has(relative),
        `Unexpected captured registry input: ${relative}`,
      );
      supplied.add(relative);
      const bytes = readFileSync(file(input));
      const destination = path.join(cargoHome, 'registry', relative);
      if (checksums.has(relative)) {
        assert.equal(
          digest(bytes),
          checksums.get(relative),
          `Captured registry checksum differs: ${relative}`,
        );
        mkdirSync(path.dirname(destination), { recursive: true });
        writeFileSync(destination, bytes, { flag: 'wx' });
      } else
        assert.deepEqual(
          bytes,
          readFileSync(destination),
          `Captured sparse index differs: ${relative}`,
        );
    }
    assert.equal(supplied.size, expected.size, 'Captured Cargo repository is incomplete');
    const lock = path.join(directory, 'Cargo.lock');
    writeFileSync(lock, seedLockText);
    const env = {
      ...cargoLinkEnvironment(
        JSON.parse(readFileSync(file(spec.compiler), 'utf8')) as CargoLinkConfiguration,
        runfiles,
      ),
      CARGO_HOME: cargoHome,
      CARGO_TARGET_DIR: path.join(output, 'target'),
      CARGO_NET_OFFLINE: 'true',
      CARGO_TERM_COLOR: 'never',
      RUSTC: file(spec.rustc),
      RUSTDOC: file(spec.rustdoc),
      PATH: path.dirname(file(spec.rustc)),
      // Reuse the compiler's content-keyed cache within this private test only.
      HOME: process.env.TEST_TMPDIR,
      TMPDIR: output,
    };
    const version = Bun.spawnSync([file(spec.cargo), '--version'], { env });
    assert.equal(version.exitCode, 0);
    assert.equal(
      version.stdout.toString().trim().split(' ')[1],
      context.cargo,
      'Selected Cargo differs from captured resolver',
    );
    const compiler = Bun.spawnSync([file(spec.rustc), '--version', '--verbose'], { env });
    assert.equal(compiler.exitCode, 0);
    assert.equal(
      /^host: (.+)$/mu.exec(compiler.stdout.toString())?.[1],
      context.target,
      'Installed source compilation requires the captured native host',
    );
    async function cargo(name: string, command: string[], cwd = directory, configuration = config) {
      const stdout = path.join(diagnostics, `${name}.stdout`),
        stderr = path.join(diagnostics, `${name}.stderr`);
      const child = Bun.spawn([file(spec.cargo), '--config', configuration, ...command], {
        cwd,
        env,
        stdin: 'ignore',
        stdout: Bun.file(stdout),
        stderr: Bun.file(stderr),
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const code = await Promise.race([
          child.exited,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              child.kill('SIGKILL');
              reject(new Error(`Installed ${candidate.name} ${name} timed out`));
            }, 1_800_000);
          }),
        ]);
        assert.equal(code, 0, `Installed ${candidate.name} ${name} failed: ${stderr}`);
        return readFileSync(stdout, 'utf8');
      } finally {
        if (timer) clearTimeout(timer);
        await child.exited;
      }
    }
    await cargo('generate-lock', ['generate-lockfile', '--offline', '--manifest-path', manifest]);
    const lockText = readFileSync(lock, 'utf8');
    const capturedRegistry = new Map(
      Bun.TOML.parse(capturedLock)
        .package.filter((row: any) => row.source)
        .map((row: any) => [`${row.name}@${row.version}`, row]),
    );
    const assertCapturedRegistry = (text: string) => {
      for (const row of Bun.TOML.parse(text).package.filter((row: any) => row.source)) {
        const original = capturedRegistry.get(`${row.name}@${row.version}`) as any;
        assert(
          original && original.source === row.source && original.checksum === row.checksum,
          'Cargo resolved outside the captured original registry identities: ' +
            row.name +
            '@' +
            row.version,
        );
      }
    };
    assertCapturedRegistry(lockText);
    const metadata = JSON.parse(
      await cargo('metadata', [
        'metadata',
        '--locked',
        '--offline',
        '--format-version',
        '1',
        '--filter-platform',
        context.target,
        '--manifest-path',
        manifest,
        ...spec.flags,
      ]),
    );
    const selected = metadata.packages.find((pkg: any) => pkg.id === metadata.resolve?.root);
    assert.equal(selected?.name, candidate.name);
    assert.equal(selected?.version, candidate.version);
    assert.equal(selected?.source, null);
    assert.equal(
      realpathSync(selected.manifest_path),
      realpathSync(manifest),
      'Cargo selected a source root outside the actual envelope',
    );
    for (const pkg of metadata.packages.filter((pkg: any) => pkg.source === null)) {
      const declared = candidates.find(
        (row) => row.name === pkg.name && row.version === pkg.version,
      );
      assert(declared, `Cargo selected an undeclared local package: ${pkg.name}@${pkg.version}`);
      assert.equal(
        realpathSync(pkg.manifest_path),
        realpathSync(
          path.join(output, 'crates', `${declared.name}-${declared.version}`, 'Cargo.toml'),
        ),
      );
    }
    if (compile)
      await cargo('test-no-run', [
        'test',
        '--no-run',
        '--locked',
        '--offline',
        '--jobs',
        '2',
        '--manifest-path',
        manifest,
        ...spec.flags,
      ]);
    assert.equal(
      readFileSync(lock, 'utf8'),
      lockText,
      'Locked offline compilation changed its genuine lock',
    );
    writeFileSync(
      path.join(diagnostics, 'source-compile-result.json'),
      `${JSON.stringify(
        {
          scope: compile ? 'installed-source-compile' : 'installed-source-resolution',
          status: 'passed',
          level: compile ? 'locked-offline-test-compilation' : 'locked-offline-metadata',
          name: candidate.name,
          version: candidate.version,
          target: context.target,
          flags: spec.flags,
          archiveSha256: candidate.sha256,
          cargoLockSha256: digest(lockText),
          capturedCargoLockSha256: digest(capturedLock),
          registryIndexSha256: digest(readFileSync(file(spec.index))),
          selectedCandidates: candidates
            .filter((row) =>
              metadata.packages.some(
                (pkg: any) =>
                  pkg.name === row.name && pkg.version === row.version && pkg.source === null,
              ),
            )
            .map(({ name, version, sha256 }) => ({ name, version, sha256 })),
        },
        null,
        2,
      )}\n`,
    );
    if (compile && spec.minimum) {
      // The original package's tests can elevate normal dependencies through
      // dev requirements. A dependent compiles the production source without them.
      const minimumSources = sourceCandidates(
        archivePool[0],
        archivePool.slice(1),
        capturedLock,
        heldPool,
        {
          minimum: true,
          includeDev: false,
          sourceOwners: spec.sourceOwners ?? {},
          selectedProducts: spec.selectedProducts ?? [],
          payloadNames,
        },
      );
      const minimumCandidates = [
        ...minimumSources,
        ...cargoPayloadInputs(minimumSources, payloadPool, {
          ...payloadOptions,
          includeDev: false,
        }),
      ];
      const minimumRoot = path.join(output, 'minimum');
      const minimumConfig = stageCargoCarrierInputs(minimumCandidates, minimumRoot);
      const minimumSource = path.join(
        minimumRoot,
        'crates',
        `${candidate.name}-${candidate.version}`,
      );
      const enabledFeatures = new Set(
        metadata.resolve.nodes.find((node: any) => node.id === selected.id).features,
      );
      const binaries = selected.targets.filter(
        (target: any) =>
          target.kind.includes('bin') &&
          (target['required-features'] ?? []).every((feature: string) =>
            enabledFeatures.has(feature),
          ),
      );
      const hasBinary = binaries.length > 0;
      let minimumLockText: string | undefined;
      let compiled: { name: string; version: string; manifestPath: string }[];
      const staged = minimumCandidates.map(({ name, version }) => ({
        name,
        version,
        manifestPath: path.join(minimumRoot, 'crates', `${name}-${version}`, 'Cargo.toml'),
      }));
      if (hasBinary) {
        // Cargo install compiles original library and binary production targets;
        // root tests and --locked would admit the root's development constraints.
        compiled = assertCargoSourceArtifacts(
          await cargo(
            'minimum-install',
            [
              'install',
              '--path',
              minimumSource,
              '--root',
              path.join(minimumRoot, 'installed'),
              '--debug',
              '--offline',
              '--jobs',
              '2',
              '--message-format',
              'json',
              ...binaries.flatMap((target: any) => ['--bin', target.name]),
              ...spec.flags,
            ],
            minimumSource,
            minimumConfig,
          ),
          staged,
          [candidate.name],
        );
      } else {
        const consumer = path.join(minimumRoot, 'consumer');
        mkdirSync(path.join(consumer, 'src'), { recursive: true });
        writeFileSync(path.join(consumer, 'src/lib.rs'), 'pub fn qualification() {}\n');
        writeFileSync(
          path.join(consumer, 'Cargo.toml'),
          renderCargoToml({
            package: { name: 'source-floor-consumer', version: '0.0.0', edition: '2021' },
            dependencies: {
              [candidate.name]: { version: `=${candidate.version}`, 'default-features': false },
            },
            features: Object.fromEntries(
              Object.keys(candidate.manifest.features ?? {}).map((feature) => [
                feature,
                [`${candidate.name}/${feature}`],
              ]),
            ),
          }),
        );
        const minimumLock = path.join(consumer, 'Cargo.lock');
        writeFileSync(minimumLock, sourceLock(capturedLock, minimumSources));
        await cargo('minimum-lock', ['generate-lockfile', '--offline'], consumer, minimumConfig);
        const minimumMetadata = JSON.parse(
          await cargo(
            'minimum-metadata',
            [
              'metadata',
              '--locked',
              '--offline',
              '--format-version',
              '1',
              '--filter-platform',
              context.target,
              ...spec.flags,
            ],
            consumer,
            minimumConfig,
          ),
        );
        for (const pkg of minimumMetadata.packages.filter(
          (pkg: any) => pkg.source === null && pkg.id !== minimumMetadata.resolve.root,
        )) {
          const declared = minimumCandidates.find(
            (row) => row.name === pkg.name && row.version === pkg.version,
          );
          assert(
            declared,
            `Cargo selected an undeclared minimum source: ${pkg.name}@${pkg.version}`,
          );
          assert.equal(
            realpathSync(pkg.manifest_path),
            realpathSync(
              path.join(
                minimumRoot,
                'crates',
                `${declared.name}-${declared.version}`,
                'Cargo.toml',
              ),
            ),
          );
        }
        assert(
          minimumMetadata.packages.some(
            (pkg: any) =>
              pkg.source === null &&
              pkg.name === candidate.name &&
              pkg.version === candidate.version,
          ),
          'Dependent did not compile the actual source envelope',
        );
        minimumLockText = readFileSync(minimumLock, 'utf8');
        assertCapturedRegistry(minimumLockText);
        compiled = assertCargoSourceArtifacts(
          await cargo(
            'minimum-build',
            [
              'build',
              '--locked',
              '--offline',
              '--jobs',
              '2',
              '--message-format',
              'json',
              ...spec.flags,
            ],
            consumer,
            minimumConfig,
          ),
          staged,
          [candidate.name],
        );
        assert.equal(
          readFileSync(minimumLock, 'utf8'),
          minimumLockText,
          'Minimum compilation changed its resolved lock',
        );
      }
      writeFileSync(
        path.join(diagnostics, 'source-minimum-result.json'),
        `${JSON.stringify(
          {
            scope: 'installed-source-dependent-minimum',
            status: 'passed',
            level: hasBinary
              ? 'offline-production-install'
              : 'locked-offline-dependent-compilation',
            name: candidate.name,
            version: candidate.version,
            target: context.target,
            flags: spec.flags,
            archiveSha256: candidate.sha256,
            ...(minimumLockText ? { cargoLockSha256: digest(minimumLockText) } : {}),
            capturedCargoLockSha256: digest(capturedLock),
            selectedCandidates: minimumCandidates
              .filter((row) =>
                compiled.some((pkg: any) => pkg.name === row.name && pkg.version === row.version),
              )
              .map(({ name, version, sha256 }) => ({ name, version, sha256 })),
          },
          null,
          2,
        )}\n`,
      );
    }
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}
if (import.meta.main) {
  const [specification, runfiles] = Bun.argv.slice(2);
  if (specification === '--help')
    console.log(
      'Declared compile-only qualification: SPEC RUNFILES. Genuine Cargo lock/index/cache and actual source archives required. No source rewriting or network resolution.',
    );
  else {
    assert(specification && runfiles && Bun.argv.length === 4);
    await sourceCompile(specification, runfiles);
  }
}
