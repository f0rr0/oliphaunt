import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  validateRuntimeAotPayload,
  validateRuntimePayload,
} from '../../src/wasix/runtime/tools/package_liboliphaunt_wasix_cargo_artifacts.mts';
import {
  AOT_PACKAGES,
  AOT_TARGET_TRIPLES,
  RUNTIME_PACKAGE,
} from '../../src/wasix/runtime/tools/wasix-cargo-artifact-contract.mts';
import { cargoPackageRelativePathParts } from '../../tools/packaging/cargo-source-package.mts';
import { packagePayloadParts } from '../../tools/packaging/native-cargo-payload.mts';
import { extractPortableArchiveTree } from '../../tools/packaging/portable-archive.mts';
import {
  assertReleaseNoticesInDirectory,
  stageReleaseNotices,
} from '../../tools/packaging/release-notices.mts';
import { readRuntimeCargoFamily } from '../../tools/packaging/wasix-runtime-cargo-family.mts';

export { readRuntimeCargoFamily } from '../../tools/packaging/wasix-runtime-cargo-family.mts';

import { packageSpec } from '../../tools/packaging/wasix-cargo-payload.mts';

export interface RuntimeCargoSpec {
  version: string;
  packageName: string;
  target: string | null;
  payload: string;
  payloadFiles: string[];
  sources: Record<string, string>;
  notices: Record<string, string>;
  toolchain: string;
  engineSources?: string | null;
  partsReader?: string;
}

/** Stage only the declared conventional pins used by target-aware AOT readers. */
export function copyDeclaredToolchain(
  spec: Pick<RuntimeCargoSpec, 'toolchain' | 'engineSources'>,
  destination: string,
): void {
  copyDeclaredSources(
    {
      'src/wasix/runtime/toolchain.toml': spec.toolchain,
      ...(spec.engineSources
        ? { 'src/wasix/runtime/engine/sources.json': spec.engineSources }
        : {}),
    },
    destination,
  );
}

export function copyDeclaredSources(files: Record<string, string>, destination: string): void {
  for (const [relative, source] of Object.entries(files)) {
    const file = path.join(destination, ...cargoPackageRelativePathParts(relative));
    mkdirSync(path.dirname(file), { recursive: true });
    copyFileSync(source, file);
    chmodSync(file, 0o644);
  }
}

export function stageDeclaredPayload(
  spec: Pick<RuntimeCargoSpec, 'payload' | 'payloadFiles'>,
  destination: string,
): void {
  if (!Array.isArray(spec.payloadFiles) || spec.payloadFiles.length === 0)
    throw new Error('WASIX Cargo payload requires its declared TreeArtifact leaves');
  const sources: Record<string, string> = {};
  for (const source of spec.payloadFiles) {
    const relative = path
      .relative(path.resolve(spec.payload), path.resolve(source))
      .split(path.sep)
      .join('/');
    cargoPackageRelativePathParts(relative);
    if (Object.hasOwn(sources, relative))
      throw new Error(`Duplicate declared WASIX Cargo payload leaf: ${relative}`);
    sources[relative] = source;
  }
  copyDeclaredSources(sources, destination);
}

export function validatePackedRuntimeCargo(
  directory: string,
  { packageName, target }: Pick<RuntimeCargoSpec, 'packageName' | 'target'>,
  sourceRoot: string,
): void {
  if (packageName !== (target === null ? RUNTIME_PACKAGE : AOT_PACKAGES[target])) {
    throw new Error('Packed WASIX Cargo package has the wrong target identity');
  }
  const manifest = Bun.TOML.parse(readFileSync(path.join(directory, 'Cargo.toml'), 'utf8'));
  const parts = Object.keys(manifest['build-dependencies'] ?? {})
    .filter((name) => name.startsWith(`${packageName}-part-`))
    .sort();
  const expectedBuild =
    'const PACKAGE_LOCAL: bool = true;\n' +
    (parts.length
      ? `const PART_ROOTS: &[&str] = &[${parts.map((name) => `${name.replaceAll('-', '_')}::PAYLOAD_ROOT`).join(', ')}];\n`
      : '') +
    'include!("build-support.rs");\n';
  if (readFileSync(path.join(directory, 'build.rs'), 'utf8') !== expectedBuild) {
    throw new Error('Packed WASIX Cargo build script must require its package-local payload');
  }
  assertReleaseNoticesInDirectory(directory, {
    profile: target === null ? 'wasix-runtime' : 'wasix-aot',
    sourceRoot,
  });
  if (target === null) {
    validateRuntimePayload(path.join(directory, 'payload'));
  } else {
    validateRuntimeAotPayload(path.join(directory, 'artifacts'), AOT_TARGET_TRIPLES[target], {
      sourceRoot,
    });
  }
}

/** Materialize the complete frozen family for readers that consume its data, not its Cargo API. */
export function extractRuntimeCargoFamily(
  archives: readonly string[],
  destination: string,
  target: string | null,
  sourceRoot: string,
): string {
  const { parent, parts } = readRuntimeCargoFamily(archives, target);
  const parentName = parent.name;
  mkdirSync(destination, { recursive: true });
  const directory = path.join(destination, parentName);
  extractPortableArchiveTree(parent.file, directory, `${parentName}-${parent.version}`);
  if (parts.length) {
    assert(target !== null, 'Portable WASIX carrier has no multipart reader');
    const files = new Map<string, Buffer>();
    const chunks = new Map<string, Map<number, Buffer>>();
    for (const part of parts)
      for (const entry of part.entries.values()) {
        if (!entry.isFile) continue;
        const prefix = `${part.name}-${part.version}/payload/`;
        if (!entry.name.startsWith(prefix)) continue;
        const relative = entry.name.slice(prefix.length);
        if (relative.startsWith('files/')) {
          const name = relative.slice(6);
          cargoPackageRelativePathParts(name);
          assert(
            !files.has(name) && !chunks.has(name),
            'Cargo family repeats or mixes a payload file',
          );
          files.set(name, entry.data());
        } else {
          const match = /^chunks\/(.+)\.part([0-9]{3})$/u.exec(relative);
          assert(match, 'Cargo family has a malformed payload chunk');
          const name = match[1];
          cargoPackageRelativePathParts(name);
          assert(!files.has(name), 'Cargo family mixes full and chunked payload files');
          const rows = chunks.get(name) ?? new Map<number, Buffer>();
          const index = Number(match[2]);
          assert(!rows.has(index), 'Cargo family repeats a payload chunk');
          rows.set(index, entry.data());
          chunks.set(name, rows);
        }
      }
    for (const [name, rows] of chunks) {
      assert.deepEqual(
        [...rows.keys()].sort((a, b) => a - b),
        Array.from({ length: rows.size }, (_, i) => i),
        'Cargo family chunk indexes must be contiguous',
      );
      files.set(
        name,
        Buffer.concat([...rows.entries()].sort(([a], [b]) => a - b).map(([, bytes]) => bytes)),
      );
    }
    const payload = path.join(directory, 'artifacts');
    for (const [name, bytes] of files) {
      const file = path.join(payload, ...cargoPackageRelativePathParts(name));
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, bytes, { mode: 0o644 });
    }
  }
  validatePackedRuntimeCargo(directory, { packageName: parentName, target }, sourceRoot);
  return directory;
}

export function packageRuntimeCargo(spec: RuntimeCargoSpec, output: string): string[] {
  const portable = spec.target === null;
  if (
    spec.packageName !== (portable ? RUNTIME_PACKAGE : AOT_PACKAGES[spec.target]) ||
    (!portable && !Object.hasOwn(AOT_TARGET_TRIPLES, spec.target))
  ) {
    throw new Error('Canonical release package name disagrees with the WASIX Cargo target');
  }
  const manifest = Bun.TOML.parse(readFileSync(spec.sources['Cargo.toml'], 'utf8'));
  if (manifest.package?.name !== spec.packageName) {
    throw new Error('Declared WASIX Cargo template has the wrong package identity');
  }
  output = path.resolve(output);
  mkdirSync(output, { recursive: true });
  const scratch = mkdtempSync(path.join(path.dirname(output), '.wasix-cargo-'));
  try {
    const templateDir = path.join(scratch, 'template');
    const noticeSourceRoot = path.join(scratch, 'notices');
    copyDeclaredSources(spec.sources, templateDir);
    copyDeclaredSources(spec.notices, noticeSourceRoot);
    copyDeclaredToolchain(spec, noticeSourceRoot);
    const payloadRoot = path.join(scratch, 'payload');
    stageDeclaredPayload(spec, payloadRoot);
    if (portable) {
      validateRuntimePayload(payloadRoot);
    } else {
      // The canonical AOT Cargo validator includes payload-local legal notices.
      stageReleaseNotices(payloadRoot, { profile: 'wasix-aot', sourceRoot: noticeSourceRoot });
      validateRuntimeAotPayload(payloadRoot, AOT_TARGET_TRIPLES[spec.target], {
        sourceRoot: noticeSourceRoot,
      });
    }
    const parentPackage = (parts?: { name: string }[]) =>
      packageSpec(
        {
          name: spec.packageName,
          target: spec.target,
          kind: portable ? 'wasix-runtime' : 'wasix-aot',
          templateDir,
          payloadRoot,
          payloadDirName: portable ? 'payload' : 'artifacts',
          ...(parts ? { payloadParts: parts } : {}),
        },
        {
          version: spec.version,
          sourceRoot: path.join(scratch, parts ? 'split-sources' : 'sources'),
          outputDir: scratch,
          cargoTargetDir: path.join(scratch, 'cargo-target'),
          noticeSourceRoot,
          ...(parts
            ? {
                transformManifest: (text: string) =>
                  text.replace(
                    '[build-dependencies]\n',
                    '[build-dependencies]\n' +
                      parts
                        .map((part) => `${part.name} = { version = "=${spec.version}" }\n`)
                        .join(''),
                  ),
              }
            : {}),
        },
      );
    let generated;
    let parts: { name: string; cratePath: string }[] = [];
    try {
      generated = parentPackage();
    } catch (cause) {
      if (
        portable ||
        !(cause instanceof Error) ||
        !cause.message.includes('above the crates.io 10 MiB package limit')
      )
        throw cause;
      parts = packagePayloadParts(
        payloadRoot,
        path.join(scratch, 'parts'),
        output,
        path.join(scratch, 'cargo-target'),
        {
          target: {
            target: AOT_TARGET_TRIPLES[spec.target],
            triple: AOT_TARGET_TRIPLES[spec.target],
          },
          version: spec.version,
          packageBase: 'liboliphaunt-wasix-aot',
          artifactProduct: 'liboliphaunt-wasix',
          artifactKind: 'wasix-aot',
          artifactLabel: 'WASIX AOT runtime',
          noticeProfile: 'wasix-aot',
          noticeSourceRoot,
        },
      );
      const support = path.join(templateDir, 'build-support.rs');
      const original = readFileSync(support, 'utf8');
      const probe = 'let package_artifacts = manifest_dir.join("artifacts");';
      if (original.split(probe).length !== 2)
        throw new Error('AOT source must contain one package-local artifact reader');
      writeFileSync(
        support,
        original.replace(probe, 'let package_artifacts = reconstruct_payload(PART_ROOTS);') +
          '\ninclude!("cargo-parts.rs");\n',
      );
      copyFileSync(
        spec.partsReader ?? new URL('./cargo-parts.rs', import.meta.url),
        path.join(templateDir, 'cargo-parts.rs'),
      );
      const manifestFile = path.join(templateDir, 'Cargo.toml');
      writeFileSync(
        manifestFile,
        readFileSync(manifestFile, 'utf8').replace(
          '"build-support.rs"',
          '"build-support.rs", "cargo-parts.rs"',
        ),
      );
      generated = parentPackage(parts);
    }
    const parent = path.join(output, `${spec.packageName}-${spec.version}.crate`);
    copyFileSync(generated.cratePath, parent);
    return [...parts.map((part) => part.cratePath), parent];
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      spec: { type: 'string' },
      output: { type: 'string' },
      'payload-files': { type: 'string' },
    },
    strict: true,
  });
  if (!values.spec || !values.output || !values['payload-files'])
    throw new Error(
      'usage: cargo.mts --spec <json> --output <package-directory> --payload-files <declared-leaves>',
    );
  packageRuntimeCargo(
    {
      ...JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(values.spec))),
      payloadFiles: readFileSync(values['payload-files'], 'utf8').trimEnd().split(/\r?\n/u),
    },
    values.output,
  );
}
