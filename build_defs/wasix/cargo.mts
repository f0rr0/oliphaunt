import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
import {
  assertReleaseNoticesInDirectory,
  stageReleaseNotices,
} from '../../tools/packaging/release-notices.mts';
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
  if (
    readFileSync(path.join(directory, 'build.rs'), 'utf8') !==
    'const PACKAGE_LOCAL: bool = true;\ninclude!("build-support.rs");\n'
  ) {
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

export function packageRuntimeCargo(spec: RuntimeCargoSpec, output: string): void {
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
  mkdirSync(path.dirname(output), { recursive: true });
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
    const generated = packageSpec(
      {
        name: spec.packageName,
        target: spec.target,
        kind: portable ? 'wasix-runtime' : 'wasix-aot',
        templateDir,
        payloadRoot,
        payloadDirName: portable ? 'payload' : 'artifacts',
      },
      {
        version: spec.version,
        sourceRoot: path.join(scratch, 'sources'),
        outputDir: scratch,
        cargoTargetDir: path.join(scratch, 'cargo-target'),
        noticeSourceRoot,
      },
    );
    copyFileSync(generated.cratePath, output);
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
      'usage: cargo.mts --spec <json> --output <crate> --payload-files <declared-leaves>',
    );
  packageRuntimeCargo(
    {
      ...JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(values.spec))),
      payloadFiles: readFileSync(values['payload-files'], 'utf8').trimEnd().split(/\r?\n/u),
    },
    values.output,
  );
}
