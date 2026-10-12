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
import { renderCargoToml } from '../../../tools/packaging/cargo-manifest.mts';
import { stageCargoCarrierInputs } from '../../../tools/packaging/frozen-cargo.mts';
import { type CargoLinkConfiguration, cargoLinkEnvironment } from '../cargo-environment.mts';
import { cargoCandidate } from './consumer.mts';
import { type RegistryContext, validateRegistryContext, writeRegistryIndex } from './context.mts';

type Candidate = ReturnType<typeof cargoCandidate>;

/** Select only actual local envelopes; the captured lock keeps compatible held identities. */
export function sourceCandidates(
  root: Candidate,
  pool: Candidate[],
  lockText: string,
  heldPool: Candidate[] = [],
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
  const pending = [root];
  const satisfies = (version: string, requirement: string) => {
    const range = requirement.replaceAll(',', ' ');
    return Bun.semver.satisfies(version.split('+', 1)[0], /^\d/u.test(range) ? `^${range}` : range);
  };
  for (const owner of pending) {
    for (const table of [owner.manifest, ...Object.values(owner.manifest.target ?? {})] as any[]) {
      for (const section of ['dependencies', 'dev-dependencies', 'build-dependencies']) {
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
          const already = selected.get(name);
          if (already) {
            assert(
              satisfies(already.version, dependency.version),
              `Conflicting packaged local requirement: ${name} ${dependency.version}`,
            );
            continue;
          }
          const matching = [...current.values()].filter(
            (row) => row.name === name && satisfies(row.version, dependency.version),
          );
          const heldVersion = locals.get(name).version;
          const held = completed.get(`${name}@${heldVersion}`);
          const retainsHeld = satisfies(heldVersion, dependency.version);
          assert(!retainsHeld || held, `Missing actual held local archive: ${name}@${heldVersion}`);
          assert(
            retainsHeld || matching.length === 1,
            `Missing or ambiguous actual local archive: ${name} ${dependency.version}`,
          );
          const chosen = retainsHeld ? held : matching[0];
          assert(chosen);
          selected.set(name, chosen);
          pending.push(chosen);
        }
      }
    }
  }
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
    const candidates = sourceCandidates(
      archivePool[0],
      archivePool.slice(1),
      capturedLock,
      heldPool,
    );
    const candidate = candidates[0];
    const config = stageCargoCarrierInputs(candidates, output);
    const directory = path.join(output, 'crates', `${candidate.name}-${candidate.version}`);
    const manifest = path.join(directory, 'Cargo.toml');
    const lockText = sourceLock(capturedLock, candidates);
    const context = JSON.parse(readFileSync(file(spec.index), 'utf8')) as RegistryContext;
    const archives = validateRegistryContext(lockText, context);
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
    writeFileSync(lock, lockText);
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
      HOME: output,
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
    async function cargo(name: string, command: string[]) {
      const stdout = path.join(diagnostics, `${name}.stdout`),
        stderr = path.join(diagnostics, `${name}.stderr`);
      const child = Bun.spawn([file(spec.cargo), '--config', config, ...command], {
        cwd: directory,
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
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}
if (import.meta.main) {
  const [specification, runfiles] = Bun.argv.slice(2);
  if (specification === '--help')
    console.log(
      'Declared compile-only qualification: SPEC RUNFILES. Genuine Cargo lock/index/cache and actual source archives required. No source rewriting or resolution.',
    );
  else {
    assert(specification && runfiles && Bun.argv.length === 4);
    await sourceCompile(specification, runfiles);
  }
}
