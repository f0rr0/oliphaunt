/** Materialize only typed rules_pkg Files and TreeArtifacts into the public layout. */
import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validatePayload } from '../../../src/native/runtime/tools/native-runtime-payload.mts';
import { inspectPlatformBinaryTree } from '../../../tools/packaging/platform-binary-contract.mts';
import {
  assertReleaseNoticesInDirectory,
  stageReleaseNotices,
} from '../../../tools/packaging/release-notices.mts';
import {
  renderWindowsVcRuntimeSourceReceipt,
  stageWindowsVcRuntime,
  WINDOWS_VC_RUNTIME_RECEIPT,
} from '../../../tools/packaging/windows-vc-runtime-closure.mts';

export interface Mapping {
  source: string;
  destination: string;
  tree: boolean;
  mode: string;
}
export interface Artifact {
  product: string;
  kind: string;
  target: string;
  triple: string;
  asset: string;
  library_relative_path?: string;
  npm_package?: string;
  npm_os?: string;
  npm_cpu?: string;
  npm_libc?: string;
}
export interface PayloadSpec {
  artifact: Artifact;
  version: string;
  mappings: Mapping[];
  legal: Record<string, string>;
  windowsRuntime: Record<string, string>;
  output: string;
}

export function member(root: string, relative: string): string {
  assert(
    typeof relative === 'string' &&
      relative &&
      !relative.startsWith('/') &&
      !relative.includes('\\') &&
      !/[\u0000-\u001f\u007f]/u.test(relative) &&
      relative.split('/').every((part) => part && part !== '.' && part !== '..'),
    `unsafe payload destination ${JSON.stringify(relative)}`,
  );
  return path.join(root, ...relative.split('/'));
}

function copy(source: string, destination: string, mode: number): void {
  assert(lstatSync(source).isFile(), `expected regular declared file ${source}`);
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  chmodSync(destination, mode);
}

/** Source Files may be runfiles/sandbox aliases; children inside a declared tree may not. */
export function materializeMappings(mappings: Mapping[], output: string): void {
  const destinations = new Set<string>();
  const visit = (source: string, relative: string, tree: boolean, mode: number) => {
    const destination = member(output, relative);
    assert(!destinations.has(relative), `duplicate native payload destination ${relative}`);
    destinations.add(relative);
    const stat = lstatSync(source);
    assert(!stat.isSymbolicLink(), `declared payload tree contains a symbolic link: ${source}`);
    if (tree) {
      assert(stat.isDirectory(), `expected declared payload tree ${source}`);
      mkdirSync(destination, { recursive: true });
      chmodSync(destination, 0o755);
      for (const name of readdirSync(source).sort()) {
        const child = path.join(source, name);
        visit(child, `${relative}/${name}`, lstatSync(child).isDirectory(), mode);
      }
    } else copy(source, destination, mode);
  };
  mkdirSync(output, { recursive: true });
  for (const mapping of mappings) {
    assert(/^[0-7]{3,4}$/u.test(mapping.mode), `unsupported native payload mode ${mapping.mode}`);
    const mode = Number.parseInt(mapping.mode, 8);
    assert(mode === 0o644 || mode === 0o755, `unsupported native payload mode ${mapping.mode}`);
    visit(realpathSync(mapping.source), mapping.destination, mapping.tree, mode);
  }
}

export function stageLegalSources(sources: Record<string, string>, output: string): void {
  for (const [relative, source] of Object.entries(sources))
    copy(realpathSync(source), member(output, relative), 0o644);
}

/** Materialize one declared TreeArtifact's one-hop sandbox file aliases.
 * Original tree files must be regular, belong to the same logical tree, and
 * share one physical root. Authored symlinks and directory links stay invalid.
 */
export function copyDeclaredTree(
  source: string,
  output: string,
  executableFiles?: readonly string[],
): void {
  const root = realpathSync(source);
  let physicalRoot: string | undefined;
  const rows: Mapping[] = [];
  const visit = (directory: string, relative = '') => {
    assert(lstatSync(directory).isDirectory(), `expected declared tree directory ${directory}`);
    mkdirSync(relative ? member(output, relative) : output, { recursive: true });
    for (const name of readdirSync(directory).sort()) {
      const child = path.join(directory, name);
      const destination = relative ? `${relative}/${name}` : name;
      const metadata = lstatSync(child);
      if (metadata.isDirectory()) {
        visit(child, destination);
        continue;
      }
      let original = child;
      let owner = root;
      if (metadata.isSymbolicLink()) {
        assert(
          !path.isAbsolute(source) && !source.split('/').includes('..'),
          'sandbox tree aliases require the declared execroot-relative TreeArtifact path',
        );
        original = path.resolve(path.dirname(child), readlinkSync(child));
        owner = path.resolve(original, ...destination.split('/').map(() => '..'));
        assert(
          owner.endsWith(path.sep + path.normalize(source)),
          `sandbox file alias escapes the declared tree: ${child}`,
        );
      }
      const originalMetadata = lstatSync(original);
      assert(originalMetadata.isFile(), `declared tree has a non-regular original file: ${child}`);
      physicalRoot ??= owner;
      assert.equal(owner, physicalRoot, 'declared tree file aliases have mixed physical roots');
      rows.push({
        source: original,
        destination,
        tree: false,
        mode: originalMetadata.mode & 0o100 ? '0755' : '0644',
      });
    }
  };
  visit(root);
  if (executableFiles !== undefined) {
    const executables = new Set(executableFiles);
    assert.equal(executables.size, executableFiles.length, 'duplicate executable tree member');
    const members = new Set(rows.map(({ destination }) => destination));
    for (const name of executables) {
      member(output, name);
      assert(members.has(name), `declared tree omitted executable member ${name}`);
    }
    // Bazel can make every generated tree member executable. Public modes
    // therefore come from the declared payload contract at this boundary.
    for (const row of rows) row.mode = executables.has(row.destination) ? '0755' : '0644';
  }
  materializeMappings(rows, output);
}

export async function packageNativePayload(spec: PayloadSpec): Promise<void> {
  assert(
    ['native-runtime', 'native-tools'].includes(spec.artifact.kind),
    'unsupported native payload kind',
  );
  const output = path.resolve(spec.output);
  const temporary = mkdtempSync(path.join(tmpdir(), 'native-public-payload-'));
  try {
    const mappings = spec.mappings.map((mapping, index) => {
      if (!mapping.tree) return mapping;
      const source = path.join(temporary, `tree-${index}`);
      copyDeclaredTree(mapping.source, source);
      return { ...mapping, source };
    });
    materializeMappings(mappings, output);
    const sourceRoot = path.join(temporary, 'legal-sources');
    stageLegalSources(spec.legal, sourceRoot);
    const notices = { profile: spec.artifact.kind, sourceRoot };
    stageReleaseNotices(output, notices);
    if (spec.artifact.target === 'windows-x64-msvc') {
      const source = path.join(temporary, 'vc-runtime');
      mkdirSync(source);
      for (const [name, file] of Object.entries(spec.windowsRuntime))
        copy(realpathSync(file), member(source, name), 0o644);
      writeFileSync(
        path.join(source, WINDOWS_VC_RUNTIME_RECEIPT),
        renderWindowsVcRuntimeSourceReceipt({ sourceDirectory: source, profile: 'provider' }),
      );
      const destinations = [path.join(output, 'runtime/bin')];
      if (spec.artifact.kind === 'native-runtime') destinations.push(path.join(output, 'bin'));
      stageWindowsVcRuntime({
        root: output,
        sourceDirectory: source,
        destinations,
        profile: 'provider',
      });
    } else
      assert.equal(Object.keys(spec.windowsRuntime).length, 0, 'foreign Windows runtime inputs');
    validatePayload(output, spec.artifact.target, {
      toolSet: spec.artifact.kind === 'native-tools' ? 'tools' : 'runtime',
    });
    assertReleaseNoticesInDirectory(output, notices);
    await inspectPlatformBinaryTree(output, {
      target: spec.artifact.target,
      requireWindowsRuntimeImportLibrary:
        spec.artifact.kind === 'native-runtime' && spec.artifact.target === 'windows-x64-msvc',
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  assert.equal(process.argv.length, 3, 'usage: payload.mts <declared-inputs.json>');
  await packageNativePayload(JSON.parse(readFileSync(process.argv[2], 'utf8')));
}
