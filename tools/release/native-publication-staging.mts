import { fileIdentity, safeRelative } from './native-file-identity.mts';

export { copyNativeInputFile } from './native-file-identity.mts';

/** Copy only captured native outputs into the existing target/ capsule boundary. */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { requireSafeDirectoryChain } from '../packaging/release-directory-safety.mts';
import {
  type NativeRoot,
  nativeOutputPath,
  type PhysicalShippingCohort,
} from './native-publication-artifacts.mts';
import { ROOT } from './release-graph.mts';

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
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

export type NativeOutputMember =
  | { path: string; type: 'directory'; mode: number }
  | { path: string; type: 'file'; mode: number; size: number; sha256: string };

/** Copy one declared regular output through the same bounded reader as candidate staging. */
export function copyNativeOutputFile(executionRoot: string, output: string, destination: string) {
  return fileIdentity(nativeOutputPath(executionRoot, safeRelative(output)), destination);
}

function captureMembers(absolute: string, assertPath: () => void) {
  requireSafeDirectoryChain(path.dirname(absolute), { label: 'native output' });
  const outputs = [{ key: 'payload', relative: 'root', absolute }];
  const observed = identities(snapshot(outputs));
  const expected = JSON.stringify(observed);
  return {
    members: observed.map(({ id, ...member }) => ({
      path: id.slice('payload/root'.length).replace(/^\//u, ''),
      ...member,
    })) as NativeOutputMember[],
    assertUnchanged() {
      assertPath();
      requireSafeDirectoryChain(path.dirname(absolute), { label: 'native output' });
      if (JSON.stringify(identities(snapshot(outputs))) !== expected)
        throw new Error('native payload bytes, modes or membership changed after capture');
    },
  };
}

/** Read one declared output, retaining physical modes without a shipping-mode policy. */
export function captureNativeOutputMembers(executionRoot: string, output: string) {
  if (!path.isAbsolute(executionRoot ?? ''))
    throw new Error('native payload requires the captured absolute executionRoot');
  const root = realpathSync(executionRoot);
  const absolute = nativeOutputPath(root, safeRelative(output));
  return captureMembers(absolute, () => {
    if (nativeOutputPath(root, output) !== absolute)
      throw new Error('native output path changed after capture');
  });
}

/** Resolve an exact declared Bazel input; workspace/repository links are part of its execroot. */
export function captureNativeInputMembers(executionRoot: string, input: string) {
  if (!path.isAbsolute(executionRoot ?? ''))
    throw new Error('native input requires the captured absolute executionRoot');
  const root = realpathSync(executionRoot);
  const declared = path.join(root, safeRelative(input));
  const absolute = realpathSync(declared);
  return captureMembers(absolute, () => {
    if (realpathSync(declared) !== absolute)
      throw new Error('native input path changed after capture');
  });
}

/**
 * Capturing before physical validation and comparing again before/after copying
 * binds the staged candidate to those same bytes and directory members. This is
 * byte staging, never producer execution, qualification or release selection.
 */
/** Final envelopes and the exact documents required to join extension target leaves. */
export function isNativeFinalTransportRoot({ package: pkg }: NativeRoot) {
  return (
    pkg.ecosystem !== 'internal' ||
    ['extension-release-manifest-input', 'extension-release-frozen-input'].includes(pkg.role)
  );
}

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
    const roots = (cohort.roots as NativeRoot[]).filter(isNativeFinalTransportRoot);
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
