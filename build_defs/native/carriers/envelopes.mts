/** Existing public envelope writers over one previously validated native payload. */
import assert from 'node:assert/strict';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  requiredCoreRuntimePaths,
  requiredRuntimeMemberPaths,
  requiredToolsMemberPaths,
} from '../../../src/native/runtime/tools/native-runtime-payload.mts';
import { archiveDirectory } from '../../../tools/packaging/archive-directory.mts';
import {
  packagePayload,
  writePackagesManifest,
} from '../../../tools/packaging/native-cargo-payload.mts';
import { packGeneratedNpmCarrier } from '../../../tools/packaging/npm-package.mts';
import {
  stageNpmPackageDescriptor,
  validatePackedNpmPackage,
} from '../../../tools/packaging/release-carrier.mts';
import {
  assertReleaseNoticesInArchive,
  releaseNoticeRows,
  stageReleaseNotices,
} from '../../../tools/packaging/release-notices.mts';
import { type Artifact, copyDeclaredTree, member, stageLegalSources } from './payload.mts';

interface Carrier {
  product: string;
  ecosystem: string;
  name: string;
  version: string;
  target: string | null;
  role: string;
}
export interface EnvelopeSpec {
  phase: 'github' | 'npm' | 'cargo';
  artifact: Artifact;
  version: string;
  carriers: Carrier[];
  payload: string;
  sources: Record<string, string>;
  legal: Record<string, string>;
  output: string;
  partBytes?: number;
}

export function validateNpmIdentity(manifest: Record<string, any>, spec: EnvelopeSpec): Carrier {
  const candidates = spec.carriers.filter(
    (row) => row.ecosystem === 'npm' && row.name === spec.artifact.npm_package,
  );
  assert.equal(candidates.length, 1, 'canonical native npm carrier must be unique');
  const row = candidates[0];
  assert.equal(row.product, spec.artifact.product);
  assert.equal(row.version, spec.version);
  assert.equal(manifest.name, row.name);
  assert.equal(manifest.version, row.version);
  assert.equal(manifest.oliphaunt?.target, spec.artifact.target);
  assert.deepEqual(manifest.os, [spec.artifact.npm_os]);
  assert.deepEqual(manifest.cpu, [spec.artifact.npm_cpu]);
  assert.deepEqual(manifest.libc, spec.artifact.npm_libc ? [spec.artifact.npm_libc] : undefined);
  assert.equal(manifest.exports?.['./package.json'], './package.json');
  if (spec.artifact.kind === 'native-runtime')
    assert.equal(manifest.oliphaunt?.libraryRelativePath, spec.artifact.library_relative_path);
  assert.equal(manifest.oliphaunt?.runtimeRelativePath, 'runtime');
  return row;
}

export async function packageEnvelope(spec: EnvelopeSpec): Promise<void> {
  const output = path.resolve(spec.output);
  mkdirSync(path.dirname(output), { recursive: true });
  const root = mkdtempSync(path.join(tmpdir(), 'native-envelope-'));
  try {
    const payload = path.join(root, 'payload');
    const executables =
      spec.artifact.kind === 'native-tools'
        ? requiredToolsMemberPaths(spec.artifact.target, 'runtime/bin')
        : requiredRuntimeMemberPaths(spec.artifact.target, 'runtime/bin');
    copyDeclaredTree(spec.payload, payload, executables);
    if (spec.phase === 'github') {
      assert.equal(
        path.basename(output),
        spec.artifact.asset.replaceAll('{version}', spec.version),
      );
      await archiveDirectory(payload, output, {
        modes: Object.fromEntries(executables.map((name) => [name, 0o755])),
      });
      return;
    }
    const sourceRoot = path.join(root, 'legal');
    stageLegalSources(spec.legal, sourceRoot);
    const notices = { profile: spec.artifact.kind, sourceRoot };
    if (spec.phase === 'npm') {
      const descriptors = path.join(root, 'descriptors');
      stageLegalSources(spec.sources, descriptors);
      const manifest = JSON.parse(readFileSync(path.join(descriptors, 'package.json'), 'utf8'));
      const row = validateNpmIdentity(manifest, spec);
      const stage = stageNpmPackageDescriptor(row.name, descriptors, spec.version, {
        target: spec.artifact.target,
        stageDir: path.join(root, 'package'),
      });
      cpSync(path.join(payload, 'runtime'), path.join(stage, 'runtime'), { recursive: true });
      const executableMembers = executables.map((name) => `package/${name}`);
      const required = [...executableMembers];
      if (spec.artifact.kind === 'native-runtime') {
        const library = spec.artifact.library_relative_path;
        assert(library, 'native runtime omitted its canonical library path');
        mkdirSync(path.dirname(member(stage, library)), { recursive: true });
        copyFileSync(member(payload, library), member(stage, library));
        cpSync(path.join(payload, 'lib/modules'), path.join(stage, 'lib/modules'), {
          recursive: true,
        });
        required.push(
          `package/${library}`,
          ...requiredCoreRuntimePaths(spec.artifact.target).map(
            (name) => `package/runtime/${name}`,
          ),
        );
        if (spec.artifact.target === 'windows-x64-msvc') {
          // The wrapper uses the root bin directory; carry the same explicit DLL/receipt closure.
          cpSync(path.join(payload, 'bin'), path.join(stage, 'bin'), { recursive: true });
        }
      }
      stageReleaseNotices(stage, notices);
      required.push(...releaseNoticeRows(notices).map(({ member }) => `package/${member}`));
      const tarball = packGeneratedNpmCarrier(stage, path.join(root, 'tarballs'));
      validatePackedNpmPackage({
        packageName: row.name,
        version: spec.version,
        tarball,
        requiredMembers: required,
        executableMembers,
      });
      assertReleaseNoticesInArchive(tarball, { ...notices, prefix: 'package' });
      copyFileSync(tarball, output);
    } else {
      assert.equal(spec.phase, 'cargo');
      mkdirSync(output, { recursive: true });
      const packageBase =
        spec.artifact.kind === 'native-tools' ? 'oliphaunt-tools' : 'liboliphaunt-native';
      const packages = packagePayload(
        payload,
        path.join(root, 'sources'),
        output,
        path.join(root, 'cargo'),
        {
          target: { ...spec.artifact, libraryRelativePath: spec.artifact.library_relative_path },
          version: spec.version,
          partBytes: spec.partBytes ?? 64 * 1024 * 1024,
          packageBase,
          artifactProduct: packageBase,
          artifactKind: spec.artifact.kind,
          artifactLabel:
            spec.artifact.kind === 'native-tools'
              ? 'Oliphaunt native tools'
              : 'Oliphaunt native runtime',
          noticeProfile: spec.artifact.kind,
          noticeSourceRoot: sourceRoot,
          executableFiles: executables,
        },
      );
      const carrier = spec.carriers.filter(
        (row) =>
          row.ecosystem === 'cargo' &&
          row.target === spec.artifact.target &&
          row.name === packages.find(({ role }) => role === 'aggregator')?.name,
      );
      assert.equal(carrier.length, 1, 'canonical Cargo aggregator must be unique');
      assert.equal(packages.find(({ role }) => role === 'aggregator')?.name, carrier[0].name);
      // packages.json retains actual conventional manifests, never private /tmp paths.
      for (const pkg of packages) {
        const manifest = path.join(output, 'manifests', pkg.name, 'Cargo.toml');
        mkdirSync(path.dirname(manifest), { recursive: true });
        copyFileSync(pkg.manifestPath, manifest);
        pkg.manifestPath = path.join(spec.output, 'manifests', pkg.name, 'Cargo.toml');
        pkg.cratePath = path.join(spec.output, path.basename(pkg.cratePath));
      }
      writePackagesManifest(packages, output, spec.artifact.product);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  assert.equal(process.argv.length, 3, 'usage: envelopes.mts <declared-inputs.json>');
  await packageEnvelope(JSON.parse(readFileSync(process.argv[2], 'utf8')));
}
