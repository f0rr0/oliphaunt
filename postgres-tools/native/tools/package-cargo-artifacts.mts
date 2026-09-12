#!/usr/bin/env bun
import path from 'node:path';
import { existsSync, cpSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { ROOT, compareText } from '../../../tools/release/release-artifact-targets.mts';
import { inspectPlatformBinaryTree } from '../../../tools/packaging/platform-binary-contract.mts';
import { extractPortableArchiveTree } from '../../../tools/packaging/portable-archive.mts';
import {
  assertReleaseNoticesInArchive,
  assertReleaseNoticesInDirectory,
  stageReleaseNotices,
} from '../../../tools/packaging/release-notices.mts';
import {
  renderUnsupportedNativeTargetGuard,
  rustNativeTargetCfg,
} from '../../../tools/packaging/rust-native-targets.mts';
import { validatePayload } from '../../../runtimes/liboliphaunt-native/tools/native-runtime-payload.mts';
import {
  fail,
  rel,
  cargoPackageName,
  freezeSourceCrate,
  packagePayload,
  parseCargoArtifactArgs,
  prepareCargoArtifactWorkspace,
  selectCargoArtifactTargets,
  writePackagesManifest,
} from '../../../tools/packaging/native-cargo-payload.mts';
const PRODUCT = 'postgres-tools-native';
const TOOLS_PRODUCT = 'oliphaunt-tools';
const TOOLS_KIND = 'native-tools';
const TOOLS_FACADE_TEMPLATE = path.join(ROOT, 'postgres-tools/native/crates/tools');
export function renderUnsupportedToolsTargetGuard(nativeTargets, nativeCfgs) {
  return renderUnsupportedNativeTargetGuard({
    product: TOOLS_PRODUCT,
    nativeTargets,
    nativeCfgs,
    guidance: 'use one of these declared native targets; this package has no portable fallback.',
  });
}

function writeToolsFacadeCrate(sourceRoot, { version, toolsTargets }) {
  const crateDir = path.join(sourceRoot, TOOLS_PRODUCT);
  if (existsSync(crateDir)) {
    fail(`duplicate generated ${TOOLS_PRODUCT} source crate: ${rel(crateDir)}`);
  }
  cpSync(TOOLS_FACADE_TEMPLATE, crateDir, {
    recursive: true,
    filter: (source) =>
      path.basename(source) !== 'target' && source !== path.join(TOOLS_FACADE_TEMPLATE, 'tests'),
  });
  mkdirSync(path.join(crateDir, 'testdata'), { recursive: true });
  copyFileSync(
    path.join(ROOT, 'test-fixtures/postgres/logical-tools.json'),
    path.join(crateDir, 'testdata/logical-tools.json'),
  );
  const cargoToml = path.join(crateDir, 'Cargo.toml');
  let text = readFileSync(cargoToml, 'utf8');
  text = text
    .replace('repository.workspace = true', 'repository = "https://github.com/f0rr0/oliphaunt"')
    .replace('homepage.workspace = true', 'homepage = "https://oliphaunt.dev"');
  const versionMatches = text.match(/^version = "[^"]+"$/gm) ?? [];
  if (versionMatches.length !== 1) {
    fail(`${rel(cargoToml)} must declare exactly one package version`);
  }
  text = text.replace(/^version = "[^"]+"$/m, `version = "${version}"`);
  const dependencyBlocks = [];
  const sortedToolsTargets = [...toolsTargets].sort((left, right) =>
    compareText(left.target, right.target),
  );
  const nativeTargets = sortedToolsTargets.map((target) => target.target);
  const nativeCfgs = sortedToolsTargets.map((target) => rustNativeTargetCfg(target));
  for (let index = 0; index < sortedToolsTargets.length; index += 1) {
    const target = sortedToolsTargets[index];
    const packageName = cargoPackageName(target.target, { packageBase: TOOLS_PRODUCT });
    dependencyBlocks.push(
      [
        '',
        `[target.'cfg(${nativeCfgs[index]})'.dependencies]`,
        `${packageName} = { version = "=${version}", path = "../${packageName}" }`,
      ].join('\n'),
    );
  }
  if (!text.includes('\n[workspace]')) {
    text = `${text.trimEnd()}\n\n[workspace]\n`;
  }
  writeFileSync(cargoToml, `${text.trimEnd()}\n${dependencyBlocks.join('\n')}\n`);
  const libRs = path.join(crateDir, 'src/lib.rs');
  const releaseOnlyGuard = renderUnsupportedToolsTargetGuard(nativeTargets, nativeCfgs);
  writeFileSync(
    libRs,
    `${readFileSync(libRs, 'utf8').trimEnd()}\n\n// Generated release-only native target guard.\n${releaseOnlyGuard}\n`,
  );
  stageReleaseNotices(crateDir, { profile: 'code-facade' });
  assertReleaseNoticesInDirectory(crateDir, { profile: 'code-facade' });
  return {
    name: TOOLS_PRODUCT,
    version,
    manifestPath: cargoToml,
    cratePath: null,
    target: 'portable',
    product: TOOLS_PRODUCT,
    kind: TOOLS_KIND,
    role: 'facade',
    noticeProfile: 'code-facade',
    index: null,
  };
}

export async function packageNativeToolsCargoArtifacts(argv) {
  const args = await parseCargoArtifactArgs(argv, {
    product: PRODUCT,
    assetDir: 'target/postgres-tools/native/release-assets',
    outputDir: 'target/postgres-tools/native/cargo-artifacts',
    workDir: 'target/postgres-tools/native',
  });
  const { sourceRoot, cargoTargetDir } = prepareCargoArtifactWorkspace(args);
  const targets = selectCargoArtifactTargets(PRODUCT, TOOLS_KIND, args.targets);
  const packages = [];
  for (const target of targets) {
    const archive = path.join(args.assetDir, target.asset.replaceAll('{version}', args.version));
    assertReleaseNoticesInArchive(archive, { profile: 'native-tools' });
    const root = path.join(sourceRoot, target.target + '-extracted');
    extractPortableArchiveTree(archive, root);
    await inspectPlatformBinaryTree(root, { target: target.target });
    validatePayload(root, target.target, { toolSet: 'tools' });
    packages.push(
      ...packagePayload(root, sourceRoot, args.outputDir, cargoTargetDir, {
        target,
        version: args.version,
        partBytes: args.partBytes,
        packageBase: TOOLS_PRODUCT,
        artifactProduct: TOOLS_PRODUCT,
        artifactKind: TOOLS_KIND,
        artifactLabel: 'Oliphaunt native tools',
        noticeProfile: 'native-tools',
      }),
    );
  }
  packages.push(
    freezeSourceCrate(
      writeToolsFacadeCrate(sourceRoot, { version: args.version, toolsTargets: targets }),
      args.outputDir,
      cargoTargetDir,
    ),
  );
  writePackagesManifest(packages, args.outputDir, PRODUCT);
  return packages;
}
if (import.meta.main) await packageNativeToolsCargoArtifacts(Bun.argv.slice(2));
