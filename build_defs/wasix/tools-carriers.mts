/** Final tools envelopes from one declared portable or target AOT payload. */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  validatePortableToolsPayload,
  validateToolsAotPayload,
} from '../../src/wasix/postgres-tools/tools/package-assets.mts';
import { packWasixToolsAotNpmCarrier } from '../../src/wasix/postgres-tools/tools/wasix-tools-aot-npm.mts';
import { packWasixToolsNpmCarrier } from '../../src/wasix/postgres-tools/tools/wasix-tools-npm-carrier.mts';
import {
  AOT_TARGET_TRIPLES,
  TOOLS_AOT_PACKAGES,
  TOOLS_PACKAGE,
} from '../../src/wasix/runtime/tools/wasix-cargo-artifact-contract.mts';
import { createDeterministicTar } from '../../tools/packaging/cargo-source-package.mts';
import { canonicalGzipSync } from '../../tools/packaging/portable-archive.mts';
import { stageReleaseNotices } from '../../tools/packaging/release-notices.mts';
import { packageSpec } from '../../tools/packaging/wasix-cargo-payload.mts';
import { copyDeclaredSources, stageDeclaredPayload } from './cargo.mts';
import { type RuntimePayloadSpec, sourceFacts } from './package.mts';

export interface ToolsCarrierSpec
  extends Pick<RuntimePayloadSpec, 'postgresSource' | 'postgresSeries' | 'patches' | 'icuSource'> {
  version: string;
  runtimeVersion: string;
  artifact: {
    target: string;
    asset: string;
    triple?: string;
    npm_package?: string;
    npm_os?: string;
    npm_cpu?: string;
    npm_libc?: string;
  };
  cargoPackage: string;
  npmPackage: string;
  payload: string;
  payloadFiles: string[];
  sources: Record<string, string>;
  notices: Record<string, string>;
  toolchain: string;
  outputs: { github: string; npm: string; cargo: string };
}

export async function packageToolsCarriers(spec: ToolsCarrierSpec): Promise<void> {
  const portable = spec.artifact.target === 'portable';
  if (
    spec.cargoPackage !== (portable ? TOOLS_PACKAGE : TOOLS_AOT_PACKAGES[spec.artifact.target]) ||
    (!portable && spec.artifact.triple !== AOT_TARGET_TRIPLES[spec.artifact.target]) ||
    spec.npmPackage !==
      (portable ? '@oliphaunt/liboliphaunt-wasix-tools' : spec.artifact.npm_package)
  )
    throw new Error('WASIX tools carrier differs from its canonical target identity');
  const manifest = Bun.TOML.parse(readFileSync(spec.sources['Cargo.toml'], 'utf8'));
  if (manifest.package?.name !== spec.cargoPackage)
    throw new Error('Declared WASIX tools Cargo template has the wrong package identity');
  const asset = spec.artifact.asset.replaceAll('{version}', spec.version);
  const expected = {
    github: asset,
    npm: `${spec.npmPackage.replace('@', '').replace('/', '-')}-${spec.version}.tgz`,
    cargo: `${spec.cargoPackage}-${spec.version}.crate`,
  };
  for (const [kind, file] of Object.entries(spec.outputs)) {
    if (path.basename(file) !== expected[kind])
      throw new Error(`WASIX tools ${kind} output has the wrong canonical filename`);
    mkdirSync(path.dirname(file), { recursive: true });
  }
  const scratch = mkdtempSync(
    path.join(path.dirname(path.resolve(spec.outputs.github)), '.wasix-tools-'),
  );
  try {
    const templateDir = path.join(scratch, 'template');
    const sourceRoot = path.join(scratch, 'notices');
    copyDeclaredSources(spec.sources, templateDir);
    copyDeclaredSources(spec.notices, sourceRoot);
    copyDeclaredSources({ 'src/wasix/runtime/toolchain.toml': spec.toolchain }, sourceRoot);
    const payloadRoot = path.join(scratch, 'payload');
    stageDeclaredPayload(spec, payloadRoot);
    const { source_fingerprint: sourceFingerprint } = await sourceFacts(spec);
    if (portable) {
      validatePortableToolsPayload(payloadRoot, spec.version, {
        runtimeVersion: spec.runtimeVersion,
        sourceFingerprint,
        sourceRoot,
      });
    } else {
      stageReleaseNotices(payloadRoot, { profile: 'wasix-aot', sourceRoot });
      validateToolsAotPayload(payloadRoot, spec.artifact.triple, { sourceFingerprint, sourceRoot });
    }
    const github = path.join(scratch, asset);
    writeFileSync(
      github,
      canonicalGzipSync(
        createDeterministicTar(payloadRoot, '.', {
          fail: (message) => {
            throw new Error(message);
          },
          fixedFileMode: 0o644,
        }),
      ),
    );
    const npm = portable
      ? packWasixToolsNpmCarrier({
          version: spec.version,
          portableReleaseArchive: github,
          packageDir: path.join(scratch, 'npm-source'),
          tarballRoot: path.join(scratch, 'npm'),
          sourceRoot,
        }).tarball
      : packWasixToolsAotNpmCarrier({
          version: spec.version,
          assetDir: scratch,
          target: {
            ...spec.artifact,
            npmPackage: spec.npmPackage,
            npmOs: spec.artifact.npm_os,
            npmCpu: spec.artifact.npm_cpu,
            npmLibc: spec.artifact.npm_libc,
          },
          workRoot: scratch,
          sourceRoot,
          sourceFingerprint,
        });
    const cargo = packageSpec(
      {
        name: spec.cargoPackage,
        target: spec.artifact.triple ?? 'portable',
        kind: portable ? 'wasix-tools' : 'wasix-tools-aot',
        templateDir,
        payloadRoot,
        payloadDirName: portable ? 'payload' : 'artifacts',
      },
      {
        version: spec.version,
        sourceRoot: path.join(scratch, 'cargo-sources'),
        outputDir: scratch,
        cargoTargetDir: path.join(scratch, 'cargo-target'),
        noticeSourceRoot: sourceRoot,
      },
    ).cratePath;
    copyFileSync(github, spec.outputs.github);
    copyFileSync(npm, spec.outputs.npm);
    copyFileSync(cargo, spec.outputs.cargo);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { spec: { type: 'string' }, 'payload-files': { type: 'string' } },
    strict: true,
  });
  if (!values.spec || !values['payload-files'])
    throw new Error('usage: tools-carriers.mts --spec <json> --payload-files <declared-leaves>');
  await packageToolsCarriers({
    ...JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(values.spec))),
    payloadFiles: readFileSync(values['payload-files'], 'utf8').trimEnd().split(/\r?\n/u),
  });
}
