/** Stage the declared portable runtime files and its deterministic private archive. */
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createDeterministicTar } from '../../tools/packaging/archive-directory.mts';
import {
  portableMemberName,
  releaseZstdCompressSync,
} from '../../tools/packaging/portable-archive.mts';

export interface RuntimeEntry {
  source: string;
  destination: string;
  tree?: boolean;
  executable?: boolean;
}

export interface RuntimePayloadSpec {
  entries: RuntimeEntry[];
  runtime: string;
  initdb: string;
  exportPolicy: string;
  support: { name: string; source: string; path: string }[];
  postgresSource: string;
  postgresSeries: string;
  patches: Record<string, string>;
  icuSource: string;
}

/** Consume Bazel's declared TreeArtifact leaf inventory without walking links. */
export function expandDeclaredTrees(entries: RuntimeEntry[], files: string[]): RuntimeEntry[] {
  const roots = entries.filter((entry) => entry.tree);
  const leaves = new Map<RuntimeEntry, RuntimeEntry[]>(roots.map((entry) => [entry, []]));
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file)) throw new Error(`duplicate declared runtime tree leaf: ${file}`);
    seen.add(file);
    const owners = roots.filter((entry) => {
      const relative = path.relative(path.resolve(entry.source), path.resolve(file));
      return (
        relative &&
        relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
      );
    });
    if (owners.length !== 1)
      throw new Error(`runtime tree leaf is outside its unique declared directory: ${file}`);
    const owner = owners[0];
    const relative = path
      .relative(path.resolve(owner.source), path.resolve(file))
      .split(path.sep)
      .join('/');
    const ownedLeaves = leaves.get(owner);
    if (!ownedLeaves) throw new Error('declared runtime tree owner is missing');
    ownedLeaves.push({
      source: file,
      destination: safePath(`${owner.destination}/${relative}`),
      executable: owner.executable,
    });
  }
  return entries.flatMap((entry) => (entry.tree ? (leaves.get(entry) ?? []) : [entry]));
}

function safePath(value: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error(`unsafe runtime destination: ${value}`);
  portableMemberName(value, 'file', value);
  return value;
}

async function treeFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    const metadata = await lstat(file);
    if (metadata.isSymbolicLink()) throw new Error(`runtime input tree contains a link: ${file}`);
    if (metadata.isDirectory()) files.push(...(await treeFiles(file)));
    else if (metadata.isFile()) files.push(file);
    else throw new Error(`runtime input tree contains a special entry: ${file}`);
  }
  return files.sort();
}

export async function stageRuntimeArchive(
  entries: RuntimeEntry[],
  stage: string,
  archive: string,
): Promise<void> {
  if (path.basename(stage) !== 'oliphaunt')
    throw new Error('runtime archive parent must be oliphaunt');
  const destinations = new Set<string>();
  const modes: Record<string, number> = {};
  await mkdir(stage, { recursive: true });
  for (const entry of entries) {
    safePath(entry.destination);
    // Bazel projects ordinary declared files as links. Flatten those leaf links;
    // a directory artifact is followed once, then every child must be real.
    const source = await realpath(entry.source);
    const files = entry.tree ? await treeFiles(source) : [source];
    for (const file of files) {
      if (!(await stat(file)).isFile()) throw new Error(`runtime input is not a file: ${file}`);
      const destination = safePath(
        entry.tree
          ? `${entry.destination}/${path.relative(source, file).split(path.sep).join('/')}`
          : entry.destination,
      );
      if (destination === 'password' || destinations.has(destination)) {
        throw new Error(`duplicate runtime destination: ${destination}`);
      }
      destinations.add(destination);
      modes[`oliphaunt/${destination}`] = entry.executable ? 0o755 : 0o644;
      const output = path.join(stage, destination);
      await mkdir(path.dirname(output), { recursive: true });
      await copyFile(file, output);
      await chmod(output, entry.executable ? 0o755 : 0o644);
    }
  }
  await writeFile(path.join(stage, 'password'), 'password\n', { mode: 0o644 });
  for (const required of [
    'bin/postgres',
    'bin/initdb',
    'lib/postgresql/plpgsql.so',
    'lib/postgresql/dict_snowball.so',
    'share/postgresql/postgres.bki',
    'share/postgresql/system_constraints.sql',
    'share/postgresql/snowball_create.sql',
    'share/postgresql/extension/plpgsql.control',
    'share/postgresql/extension/plpgsql--1.0.sql',
    ...['UTC', 'GMT', 'Etc/UTC', 'America/New_York'].map(
      (zone) => `share/postgresql/timezone/${zone}`,
    ),
  ]) {
    if (!destinations.has(required)) throw new Error(`runtime payload is missing ${required}`);
  }
  await writeFile(
    archive,
    releaseZstdCompressSync(await createDeterministicTar(stage, { keepParent: true, modes })),
  );
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function sourceFacts(
  spec: Pick<RuntimePayloadSpec, 'postgresSource' | 'postgresSeries' | 'patches' | 'icuSource'>,
) {
  const text = async (file: string) =>
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readFile(file));
  const postgres = (
    Bun.TOML.parse(await text(spec.postgresSource)) as {
      postgresql: { version: string; url: string; sha256: string };
    }
  ).postgresql;
  if (
    !postgres ||
    !/^\d+\.\d+$/u.test(postgres.version) ||
    !/^[0-9a-f]{64}$/u.test(postgres.sha256)
  ) {
    throw new Error('invalid canonical PostgreSQL source facts');
  }
  const series = await text(spec.postgresSeries);
  const names = series
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  if (!names.length || new Set(names).size !== names.length)
    throw new Error('invalid canonical PostgreSQL patch series');
  const hashes = [sha256(series.replace(/\r\n/gu, '\n'))];
  for (const name of names) {
    safePath(name);
    if (!name.endsWith('.patch') || !Object.hasOwn(spec.patches, name))
      throw new Error(`undeclared PostgreSQL patch: ${name}`);
    hashes.push(sha256((await text(spec.patches[name])).replace(/\r\n/gu, '\n')));
  }
  const patchHash = sha256(`${hashes.join('\n')}\n`);
  const icu = Bun.TOML.parse(await text(spec.icuSource)) as Record<string, unknown>;
  if (
    !icu ||
    typeof icu.name !== 'string' ||
    typeof icu.url !== 'string' ||
    typeof icu.branch !== 'string' ||
    typeof icu.commit !== 'string'
  ) {
    throw new Error('invalid canonical ICU source facts');
  }
  return {
    source_fingerprint: `${postgres.version}:${postgres.sha256}:${patchHash}`,
    postgres_version: postgres.version,
    sources: [
      icu,
      {
        name: 'postgresql',
        url: postgres.url,
        branch: `v${postgres.version}`,
        commit: postgres.sha256,
      },
      {
        name: 'oliphaunt-wasix-stable-patches',
        url: 'src/wasix/runtime/postgres/series',
        branch: 'series',
        commit: patchHash,
      },
    ],
  };
}

export async function packageRuntime(
  spec: RuntimePayloadSpec,
  output: string,
  manifestTool: string,
): Promise<void> {
  const stage = path.join(output, 'oliphaunt');
  await mkdir(output, { recursive: true });
  const archive = path.join(output, 'oliphaunt.wasix.tar.zst');
  try {
    await stageRuntimeArchive(spec.entries, stage, archive);
    const initdb = path.join(output, 'bin/initdb.wasix.wasm');
    await mkdir(path.dirname(initdb), { recursive: true });
    await copyFile(spec.initdb, initdb);
    await chmod(initdb, 0o644);
    const support = [];
    const names = new Set<string>();
    for (const item of spec.support) {
      safePath(item.path);
      if (names.has(item.name)) throw new Error(`duplicate runtime support module: ${item.name}`);
      names.add(item.name);
      const file = path.join(output, item.path);
      await mkdir(path.dirname(file), { recursive: true });
      await copyFile(item.source, file);
      await chmod(file, 0o644);
      support.push({ name: item.name, path: item.path, source: file });
    }
    const manifestSpec = path.join(output, '.manifest-inputs.json');
    await writeFile(
      manifestSpec,
      JSON.stringify({
        ...(await sourceFacts(spec)),
        runtime: spec.runtime,
        archive,
        initdb,
        export_policy: spec.exportPolicy,
        support,
      }),
    );
    const result = Bun.spawnSync(
      [
        manifestTool,
        'assets',
        'declared-manifest',
        '--spec',
        manifestSpec,
        '--output',
        path.join(output, 'manifest.json'),
      ],
      {
        stdout: 'inherit',
        stderr: 'inherit',
        env: { ...process.env, LC_ALL: 'C' },
      },
    );
    if (result.exitCode !== 0)
      throw new Error(`runtime manifest tool failed with exit ${result.exitCode}`);
    await rm(manifestSpec);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      spec: { type: 'string' },
      output: { type: 'string' },
      'manifest-tool': { type: 'string' },
      'tree-files': { type: 'string' },
    },
  });
  if (!values.spec || !values.output || !values['manifest-tool'])
    throw new Error('--spec, --output and --manifest-tool are required');
  const spec = JSON.parse(
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readFile(values.spec)),
  ) as RuntimePayloadSpec;
  if (values['tree-files']) {
    const leaves = new TextDecoder('utf-8', { fatal: true })
      .decode(await readFile(values['tree-files']))
      .split('\n')
      .filter(Boolean);
    spec.entries = expandDeclaredTrees(spec.entries, leaves);
  }
  await packageRuntime(spec, values.output, values['manifest-tool']);
}
