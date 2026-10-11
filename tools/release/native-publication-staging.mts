/** Copy only captured native outputs into the existing target/ capsule boundary. */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { requireSafeDirectoryChain } from '../packaging/release-directory-safety.mts';
import {
  nativeOutputPath,
  type NativeRoot,
  type PhysicalShippingCohort,
} from './native-publication-artifacts.mts';
import { ROOT } from './release-graph.mts';

function safeRelative(value: string) {
  if (
    typeof value !== 'string' ||
    value.startsWith('/') ||
    value.includes('\\') ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    value.normalize('NFC') !== value ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error(`unsafe native staging path: ${JSON.stringify(value)}`);
  return value;
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function fileIdentity(file: string, destination?: string) {
  requireSafeDirectoryChain(path.dirname(file), { label: 'native output' });
  const source = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let target;
  try {
    const before = fstatSync(source);
    if (!before.isFile()) throw new Error(`native output must be a regular file: ${file}`);
    if (destination !== undefined) {
      requireSafeDirectoryChain(path.dirname(destination), { create: true, label: 'native stage' });
      target = openSync(
        destination,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
    }
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let size = 0;
    for (;;) {
      const count = readSync(source, buffer, 0, buffer.length, null);
      if (!count) break;
      const bytes = buffer.subarray(0, count);
      hash.update(bytes);
      size += count;
      if (target !== undefined) {
        let offset = 0;
        while (offset < count) offset += writeSync(target, bytes, offset, count - offset);
      }
    }
    const after = fstatSync(source);
    const named = lstatSync(file);
    if (
      !named.isFile() ||
      named.isSymbolicLink() ||
      [after, named].some(
        (stat) =>
          stat.dev !== before.dev ||
          stat.ino !== before.ino ||
          stat.size !== size ||
          stat.mode !== before.mode ||
          stat.mtimeMs !== before.mtimeMs ||
          stat.ctimeMs !== before.ctimeMs,
      )
    )
      throw new Error(`native output changed while being read: ${file}`);
    if (destination !== undefined) chmodSync(destination, before.mode & 0o777);
    return { type: 'file', mode: before.mode & 0o777, size, sha256: hash.digest('hex') };
  } finally {
    closeSync(source);
    if (target !== undefined) closeSync(target);
  }
}

function snapshot(outputs: { key: string; relative: string; absolute: string }[]) {
  const rows = new Map();
  const visit = (key: string, relative: string, absolute: string) => {
    safeRelative(relative);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
      throw new Error(`native output must be a regular file or directory: ${absolute}`);
    const id = `${key}/${relative}`;
    const identity = stat.isFile()
      ? fileIdentity(absolute)
      : { type: 'directory', mode: stat.mode & 0o777 };
    const existing = rows.get(id);
    if (existing) {
      const { id: _id, absolute: _absolute, ...previous } = existing;
      if (existing.absolute !== absolute || JSON.stringify(previous) !== JSON.stringify(identity))
        throw new Error('duplicate native output declarations have conflicting bytes or modes');
    }
    rows.set(id, { id, absolute, ...identity });
    if (stat.isDirectory()) {
      requireSafeDirectoryChain(absolute, { label: 'native output' });
      for (const name of readdirSync(absolute).sort())
        visit(key, `${relative}/${name}`, path.join(absolute, name));
    }
  };
  for (const output of outputs) visit(output.key, output.relative, output.absolute);
  return [...rows.values()].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
}

function identities(rows) {
  return rows.map(({ absolute: _absolute, ...identity }) => identity);
}

/**
 * Capturing before physical validation and comparing again before/after copying
 * binds the staged candidate to those same bytes and directory members. This is
 * byte staging, never producer execution, qualification or release selection.
 */
export function captureNativePublicationOutputs(
  cohorts: PhysicalShippingCohort[],
  { sourceCommit, stageDirectory }: { sourceCommit: string; stageDirectory?: string },
) {
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit))
    throw new Error('native stage requires a full source SHA');
  if (stageDirectory !== undefined) {
    safeRelative(stageDirectory);
    if (!stageDirectory.startsWith('target/'))
      throw new Error('native stage must remain under target/');
  }
  const outputs = cohorts.flatMap((cohort) => {
    if (!path.isAbsolute(cohort.executionRoot ?? ''))
      throw new Error('native stage requires the captured absolute executionRoot');
    const executionRoot = realpathSync(cohort.executionRoot);
    const roots = (cohort.roots as NativeRoot[]).filter(
      ({ package: pkg }) => pkg.ecosystem !== 'internal',
    );
    const declarations = roots
      .map(({ package: pkg }) => ({
        product: pkg.product,
        version: pkg.version,
        ecosystem: pkg.ecosystem,
        name: pkg.name,
        configuration: pkg.configuration,
        role: pkg.role,
        outputs: pkg.outputs
          .map(({ path: relative, owner }) => ({ path: safeRelative(relative), owner }))
          .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
      }))
      .sort((left, right) =>
        JSON.stringify(left) < JSON.stringify(right)
          ? -1
          : JSON.stringify(left) > JSON.stringify(right)
            ? 1
            : 0,
      );
    const cohortKey = digest({ executionRoot, declarations });
    const producers = new Map<string, { owner: string; namespace: string; paths: Set<string> }>();
    for (const { package: pkg } of roots)
      for (const { path: sourceRelative, owner } of pkg.outputs) {
        if (typeof owner !== 'string' || !owner || /[\u0000-\u001f\u007f]/u.test(owner))
          throw new Error('native stage requires the declared output producer');
        const parts = safeRelative(sourceRelative).split('/');
        if (parts[0] !== 'bazel-out' || parts.length < 4)
          throw new Error(`unsafe native output path: ${JSON.stringify(sourceRelative)}`);
        const namespace = parts.slice(0, 3).join('/');
        const producer = JSON.stringify([owner, namespace]);
        if (!producers.has(producer))
          producers.set(producer, { owner, namespace, paths: new Set() });
        producers.get(producer)!.paths.add(sourceRelative);
      }
    return [...producers.values()].flatMap(({ owner, namespace, paths }) => {
      const declared = [...paths].sort();
      let parent = path.posix.dirname(declared[0]).split('/');
      for (const sourceRelative of declared.slice(1)) {
        const parts = path.posix.dirname(sourceRelative).split('/');
        const mismatch = parent.findIndex((part, index) => part !== parts[index]);
        if (mismatch >= 0) parent = parent.slice(0, mismatch);
      }
      const base = path.posix.dirname(parent.join('/'));
      // Keep the shared parent and tree basenames; carriers can require those directory boundaries.
      const key = digest({ sourceCommit, cohortKey, owner, namespace, base, outputs: declared });
      return declared.map((sourceRelative) => {
        const relative = safeRelative(path.posix.relative(base, sourceRelative));
        const absolute = nativeOutputPath(executionRoot, sourceRelative);
        requireSafeDirectoryChain(path.dirname(absolute), { label: 'native output' });
        return { key, relative, sourceRelative, executionRoot, absolute: realpathSync(absolute) };
      });
    });
  });
  const observed = snapshot(outputs);
  const expected = JSON.stringify(identities(observed));
  const relative = safeRelative(
    stageDirectory ??
      `target/n/${digest({ sourceCommit, outputs: identities(observed) }).slice(0, 32)}`,
  );
  if (!relative.startsWith('target/')) throw new Error('native stage must remain under target/');
  const destination = path.join(ROOT, relative);
  const stagedOutputs = (directory) =>
    outputs.map((output) => ({
      ...output,
      absolute: path.join(directory, output.key, output.relative),
    }));
  const assertUnchanged = () => {
    for (const output of outputs) {
      requireSafeDirectoryChain(
        path.dirname(path.join(output.executionRoot, output.sourceRelative)),
        {
          label: 'native output',
        },
      );
      if (
        realpathSync(nativeOutputPath(output.executionRoot, output.sourceRelative)) !==
        output.absolute
      )
        throw new Error('native output path changed after capture');
    }
    if (JSON.stringify(identities(snapshot(outputs))) !== expected)
      throw new Error('native output bytes, modes or directory membership changed after capture');
  };
  return {
    stage() {
      assertUnchanged();
      const parent = requireSafeDirectoryChain(path.dirname(destination), {
        create: true,
        label: 'native stage',
      });
      let existing;
      try {
        existing = lstatSync(destination);
      } catch (cause) {
        if (cause.code !== 'ENOENT') throw cause;
      }
      if (existing) {
        requireSafeDirectoryChain(destination, { label: 'native stage' });
        if (JSON.stringify(identities(snapshot(stagedOutputs(destination)))) !== expected)
          throw new Error('existing native stage differs from the captured outputs');
      } else {
        const temporary = mkdtempSync(path.join(parent, '.native-stage-'));
        try {
          for (const row of observed) {
            const target = path.join(temporary, row.id);
            if (row.type === 'directory')
              requireSafeDirectoryChain(target, { create: true, label: 'native stage' });
            else {
              const { id: _id, absolute: _absolute, ...identity } = row;
              if (JSON.stringify(fileIdentity(row.absolute, target)) !== JSON.stringify(identity))
                throw new Error('native output changed while being copied');
            }
          }
          for (const row of observed.filter(({ type }) => type === 'directory').reverse())
            chmodSync(path.join(temporary, row.id), row.mode);
          assertUnchanged();
          if (JSON.stringify(identities(snapshot(stagedOutputs(temporary)))) !== expected)
            throw new Error('staged native output differs from its captured bytes');
          renameSync(temporary, destination);
        } finally {
          rmSync(temporary, { recursive: true, force: true });
        }
      }
      assertUnchanged();
      return [...new Set(stagedOutputs(destination).map(({ absolute }) => absolute))].sort();
    },
  };
}
