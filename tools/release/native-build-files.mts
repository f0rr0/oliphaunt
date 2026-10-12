/** Transport final files and declared source tags with the existing evidence inventory. */
import { deepStrictEqual } from 'node:assert';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { SEED_CONSTRUCTION_RECEIPT_SUFFIX } from '../../build_defs/resources/seed_construction.mts';
import {
  removeOwnedDirectory,
  requireSafeDirectoryChain,
} from '../packaging/release-directory-safety.mts';
import {
  type NativeBuildEvidence,
  type NativeBuildGithub,
  validateNativeBuildEvidence,
} from './native-build-qualification.mts';
import {
  nativeSwiftSourceTagRoots,
  validateNativeSwiftSourceTagFiles,
} from './native-build-source-tag.mts';
import {
  captureNativeOutputMembers,
  captureNativePublicationOutputs,
  copyNativeOutputFile,
  isNativeFinalTransportRoot,
} from './native-publication-staging.mts';
import { ROOT } from './release-graph.mts';

type File = { cohort: number; path: string; size: number; sha256: string };

function finalFiles(evidence: NativeBuildEvidence) {
  const files: File[] = [];
  const unsupported = [];
  const supportedRoots = [];
  const artifactFileKeys = new Set<string>();
  for (const [cohort, value] of evidence.cohorts.entries()) {
    const selected = new Set<string>();
    const sourceInputs = new Set(nativeSwiftSourceTagRoots(value));
    for (const root of value.roots) {
      const pkg = root.package;
      if (!isNativeFinalTransportRoot(root)) continue;
      if (pkg.ecosystem === 'swift' || (pkg.role === 'release-input' && !sourceInputs.has(root))) {
        unsupported.push({
          cohort,
          label: root.label,
          reason: 'source publication input transport',
        });
        continue;
      }
      supportedRoots.push({ cohort, root });
      for (const output of pkg.outputs) selected.add(output.path);
    }
    const seen = new Map<string, unknown>();
    // Promotion needs the exact original constructor Files, not a reconstruction
    // from a public compressed archive. They remain internal evidence inputs.
    const seedFiles = new Set(
      (value.seedConstructions ?? []).flatMap(({ path: file }) => [
        file,
        `${file.slice(0, -SEED_CONSTRUCTION_RECEIPT_SUFFIX.length)}.tar`,
      ]),
    );
    for (const output of [
      ...value.outputs.filter(({ path }) => selected.has(path)),
      ...value.inputs.filter(({ path }) => seedFiles.has(path)),
    ])
      for (const member of output.members) {
        if (member.type !== 'file') continue;
        const name = member.path ? `${output.path}/${member.path}` : output.path;
        if (selected.has(output.path)) artifactFileKeys.add(`${cohort}\0${name}`);
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
  return { files, unsupported, supportedRoots, artifactFileKeys };
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
    validateNativeSwiftSourceTagFiles(evidence, (cohort, file) =>
      path.join(destination, String(cohort), file),
    );
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
  const qualification = validateNativeBuildEvidence(evidence, expected);
  const root = requireSafeDirectoryChain(path.resolve(directory), { label: 'native file packet' });
  const { supportedRoots, artifactFileKeys, ...inventory } = finalFiles(evidence);
  const transport = path.join(root, 'files');
  if (!existsSync(transport)) {
    if (inventory.files.length) throw new Error('native final file transport is missing');
    return {
      scope: 'construction' as const,
      qualification,
      ...inventory,
      artifactRoots: [] as string[],
    };
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
  validateNativeSwiftSourceTagFiles(evidence, (cohort, file) =>
    path.join(transport, String(cohort), file),
  );
  const assertUnchanged = () => {
    assertInventory();
    for (const { captured } of captures) captured.assertUnchanged();
  };
  const source = { ...evidence.source };
  const github = { ...evidence.github };
  // Retain only the validated staging data by value; callers cannot relabel it after reading.
  const selected = evidence.cohorts.map((cohort, index) => {
    const roots = structuredClone(
      supportedRoots.filter(({ cohort }) => cohort === index).map(({ root }) => root),
    );
    const outputs = new Set(
      roots.flatMap(({ package: pkg }) => pkg.outputs.map(({ path }) => path)),
    );
    return {
      executionRoot: cohort.executionRoot,
      aquery: cohort.aquery,
      roots,
      rootConfigurations: structuredClone(cohort.rootConfigurations),
      outputs: structuredClone(cohort.outputs.filter(({ path }) => outputs.has(path))),
    };
  });
  return {
    scope: 'construction' as const,
    qualification,
    ...inventory,
    artifactRoots: captures.flatMap(({ absolute }, index) =>
      artifactFileKeys.has(`${inventory.files[index].cohort}\0${inventory.files[index].path}`)
        ? [absolute]
        : [],
    ),
    assertUnchanged,
    /** Restore only verified captured modes in owned staging, never in downloaded bytes. */
    stage(
      options: {
        stageDirectory?: string;
        excludeRoles?: readonly string[];
        products?: readonly string[];
        artifactPhase?: 'pre-version' | 'final';
      } = {},
    ) {
      assertUnchanged();
      if (
        options.artifactPhase !== undefined &&
        !['pre-version', 'final'].includes(options.artifactPhase)
      )
        throw new Error('native File staging requires a conventional inventory phase');
      if (
        options.products !== undefined &&
        (!Array.isArray(options.products) ||
          !options.products.length ||
          new Set(options.products).size !== options.products.length ||
          options.products.some(
            (id) =>
              typeof id !== 'string' ||
              !selected.some((cohort) => cohort.roots.some((root) => root.package.product === id)),
          ))
      )
        throw new Error('native File staging requires unique observed product IDs');
      const stagedSelection = selected.map((cohort) => ({
        ...cohort,
        roots: cohort.roots.filter(
          (root) =>
            !options.excludeRoles?.includes(root.package.role) &&
            (options.products === undefined || options.products.includes(root.package.product)) &&
            !(
              options.artifactPhase === 'pre-version' &&
              root.package.role === 'release-input' &&
              root.package.name === 'swiftpm-extension-consumer-fixture'
            ),
        ),
      }));
      if (stagedSelection.every((cohort) => cohort.roots.length === 0)) return [];
      const identity = createHash('sha256')
        .update(
          JSON.stringify({
            source,
            github,
            cohorts: stagedSelection.map(
              ({ executionRoot, roots, rootConfigurations, outputs }) => ({
                executionRoot,
                roots,
                rootConfigurations,
                outputs,
              }),
            ),
          }),
        )
        .digest('hex');
      const parent = requireSafeDirectoryChain(path.join(ROOT, 'target/native-file-stage'), {
        create: true,
        label: 'native file reconstruction',
      });
      const reconstruction = path.join(parent, identity);
      // Existing paths cannot substitute for this validated packet, including concurrent callers.
      mkdirSync(reconstruction);
      try {
        const cohorts = stagedSelection.map((cohort, index) => ({
          ...cohort,
          executionRoot: path.join(reconstruction, String(index)),
        }));
        for (const [index, cohort] of cohorts.entries()) {
          requireSafeDirectoryChain(cohort.executionRoot, {
            create: true,
            label: 'native file reconstruction',
          });
          const restored = new Map<string, unknown>();
          const directories: { path: string; mode: number }[] = [];
          const outputs = new Set(
            cohort.roots.flatMap(({ package: pkg }) => pkg.outputs.map(({ path }) => path)),
          );
          for (const output of cohort.outputs.filter(({ path }) => outputs.has(path))) {
            for (const member of output.members) {
              const relative = member.path ? `${output.path}/${member.path}` : output.path;
              const target = path.join(cohort.executionRoot, relative);
              const identity = { ...member, path: relative };
              if (restored.has(relative)) {
                deepStrictEqual(
                  restored.get(relative),
                  identity,
                  'native overlapping reconstructed members',
                );
                continue;
              }
              restored.set(relative, identity);
              if (member.type === 'directory') {
                if ((member.mode & 0o500) !== 0o500 || (member.mode & 0o002) !== 0)
                  throw new Error(
                    `native transported directory has an unsafe captured mode ${member.mode.toString(8)}: ${relative}`,
                  );
                requireSafeDirectoryChain(target, {
                  create: true,
                  label: 'native file reconstruction',
                });
                directories.push({ path: target, mode: member.mode });
              } else {
                if (
                  (member.mode & 0o400) === 0 ||
                  (member.mode & 0o002) !== 0 ||
                  ((member.mode & 0o111) !== 0 && (member.mode & 0o020) !== 0)
                )
                  throw new Error(
                    `native transported file has an unsafe captured mode ${member.mode.toString(8)}: ${relative}`,
                  );
                const copied = copyNativeOutputFile(
                  path.join(transport, String(index)),
                  relative,
                  target,
                );
                deepStrictEqual(
                  { size: copied.size, sha256: copied.sha256 },
                  { size: member.size, sha256: member.sha256 },
                  'native reconstructed file bytes',
                );
                chmodSync(target, member.mode);
              }
            }
          }
          for (const directory of directories.reverse()) chmodSync(directory.path, directory.mode);
          for (const output of cohort.outputs.filter(({ path }) => outputs.has(path)))
            deepStrictEqual(
              captureNativeOutputMembers(cohort.executionRoot, output.path).members,
              output.members,
              'native reconstructed output members',
            );
        }
        assertUnchanged();
        const staged = captureNativePublicationOutputs(cohorts, {
          sourceCommit: source.commit,
          stageDirectory: options.stageDirectory,
        }).stage();
        assertUnchanged();
        return staged;
      } finally {
        removeOwnedDirectory(reconstruction);
      }
    },
  };
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      options: Object.fromEntries(
        ['evidence-root', 'source-commit', 'source-tree', 'github-json', 'output-directory'].map(
          (name) => [name, { type: 'string' as const }],
        ),
      ),
      strict: true,
      allowPositionals: false,
    });
    const required = (name: string) => {
      const value = values[name];
      if (typeof value !== 'string' || !value)
        throw new Error(`native file staging requires --${name}`);
      return value;
    };
    const directory = required('evidence-root');
    const packet = readNativeBuildFinalFiles(
      directory,
      JSON.parse(readFileSync(path.join(directory, 'native-build-evidence.json'), 'utf8')),
      {
        source: { commit: required('source-commit'), tree: required('source-tree') },
        github: JSON.parse(readFileSync(required('github-json'), 'utf8')) as NativeBuildGithub,
        bazelVersion: readFileSync(path.join(ROOT, '.bazelversion'), 'utf8').trim(),
        requireShippingAnalysis: true,
      },
    );
    if (packet.unsupported.length || !packet.stage)
      throw new Error('native file staging requires a complete supported final-file packet');
    process.stdout.write(
      `${JSON.stringify(packet.stage({ stageDirectory: required('output-directory') }))}\n`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
