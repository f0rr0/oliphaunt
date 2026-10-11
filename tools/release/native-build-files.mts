/** Transport final envelope files with the existing evidence inventory, never producer trees. */
import { deepStrictEqual } from 'node:assert';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { requireSafeDirectoryChain } from '../packaging/release-directory-safety.mts';
import {
  type NativeBuildEvidence,
  validateNativeBuildEvidence,
} from './native-build-qualification.mts';
import { captureNativeOutputMembers, copyNativeOutputFile } from './native-publication-staging.mts';

type File = { cohort: number; path: string; size: number; sha256: string };

function finalFiles(evidence: NativeBuildEvidence) {
  const files: File[] = [];
  const unsupported = [];
  for (const [cohort, value] of evidence.cohorts.entries()) {
    const selected = new Set<string>();
    for (const root of value.roots) {
      const pkg = root.package;
      if (pkg.ecosystem === 'internal') continue;
      if (pkg.ecosystem === 'swift' || pkg.role === 'release-input') {
        unsupported.push({
          cohort,
          label: root.label,
          reason: 'source publication input transport',
        });
        continue;
      }
      for (const output of pkg.outputs) selected.add(output.path);
    }
    const seen = new Map<string, unknown>();
    for (const output of value.outputs.filter(({ path }) => selected.has(path)))
      for (const member of output.members) {
        if (member.type !== 'file') continue;
        const name = member.path ? `${output.path}/${member.path}` : output.path;
        const identity = { ...member, path: name };
        if (seen.has(name)) {
          deepStrictEqual(seen.get(name), identity, 'overlapping native final file declarations');
          continue;
        }
        seen.set(name, identity);
        files.push({ cohort, path: name, size: member.size, sha256: member.sha256 });
      }
  }
  files.sort((left, right) => left.cohort - right.cohort || left.path.localeCompare(right.path));
  return { files, unsupported };
}

/** No receipt is added: source/configuration/run and file identities remain in evidence. */
export function writeNativeBuildFinalFiles(evidence: NativeBuildEvidence, directory: string) {
  const root = requireSafeDirectoryChain(path.resolve(directory), { label: 'native file packet' });
  const destination = path.join(root, 'files');
  mkdirSync(destination);
  try {
    const { files } = finalFiles(evidence);
    for (const file of files) {
      const identity = copyNativeOutputFile(
        evidence.cohorts[file.cohort].executionRoot,
        file.path,
        path.join(destination, String(file.cohort), file.path),
      );
      deepStrictEqual(
        { size: identity.size, sha256: identity.sha256 },
        { size: file.size, sha256: file.sha256 },
        'native final file differs from build evidence',
      );
    }
    return files;
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

/** Validate loose transport bytes independently; their modes are normalized by Actions ZIP. */
export function readNativeBuildFinalFiles(
  directory: string,
  evidence: NativeBuildEvidence,
  expected: Parameters<typeof validateNativeBuildEvidence>[1],
) {
  validateNativeBuildEvidence(evidence, expected);
  const root = requireSafeDirectoryChain(path.resolve(directory), { label: 'native file packet' });
  const inventory = finalFiles(evidence);
  const transport = path.join(root, 'files');
  if (!existsSync(transport)) {
    if (inventory.files.length) throw new Error('native final file transport is missing');
    return { scope: 'construction' as const, ...inventory, artifactRoots: [] as string[] };
  }
  const expectedFiles = inventory.files.map(({ cohort, path }) => `${cohort}/${path}`).sort();
  const expectedDirectories = new Set(['']);
  for (const file of expectedFiles) {
    const parts = file.split('/');
    for (let index = 1; index < parts.length; index++)
      expectedDirectories.add(parts.slice(0, index).join('/'));
  }
  const assertInventory = () => {
    const actual = [] as string[];
    const directories = [] as string[];
    const visit = (relative: string) => {
      const absolute = path.join(transport, relative);
      requireSafeDirectoryChain(absolute, { label: 'native final files' });
      directories.push(relative);
      for (const entry of readdirSync(absolute, { withFileTypes: true })) {
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) visit(child);
        else if (entry.isFile()) actual.push(child);
        else throw new Error(`native final transport requires regular files: ${child}`);
      }
    };
    visit('');
    deepStrictEqual(actual.sort(), expectedFiles, 'native final file transport inventory');
    deepStrictEqual(
      directories.sort(),
      [...expectedDirectories].sort(),
      'native final directory inventory',
    );
  };
  assertInventory();
  const captures = inventory.files.map((file) => {
    const executionRoot = path.join(transport, String(file.cohort));
    const captured = captureNativeOutputMembers(executionRoot, file.path);
    const member = captured.members[0];
    if (captured.members.length !== 1 || member.type !== 'file' || member.path !== '')
      throw new Error('native final transport member must be a regular file');
    deepStrictEqual(
      { size: member.size, sha256: member.sha256 },
      { size: file.size, sha256: file.sha256 },
      'native final transport bytes',
    );
    return { file, captured, absolute: path.join(executionRoot, file.path) };
  });
  return {
    scope: 'construction' as const,
    ...inventory,
    artifactRoots: captures.map(({ absolute }) => absolute),
    assertUnchanged() {
      assertInventory();
      for (const { captured } of captures) captured.assertUnchanged();
    },
  };
}
