import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageGeneratedCargoSource } from './cargo-source-package.mts';
import {
  assertReleaseNoticesInArchive,
  assertReleaseNoticesInDirectory,
  releaseNoticeRows,
  releaseProfilePackageLicense,
  stageReleaseNotices,
} from './release-notices.mts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CRATES_IO_MAX_BYTES = 10 * 1024 * 1024;
function fail(message) {
  throw new Error(message);
}
function rel(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}
function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}
function noticeProfileForSpec(spec) {
  if (spec.kind === 'icu-data') return 'wasix-icu-data-crate';
  if (spec.kind === 'wasix-runtime') return 'wasix-runtime';
  if (spec.kind === 'wasix-tools') return 'wasix-tools';
  if (spec.kind === 'wasix-aot' || spec.kind === 'wasix-tools-aot') return 'wasix-aot';
  fail(`WASIX Cargo package ${spec.name} has no release notice profile for kind ${spec.kind}`);
}

function injectCargoNoticeIncludes(text, profile) {
  const members = releaseNoticeRows({ profile }).map((row) => row.member);
  const match =
    text.match(/^include = \[(?<body>[\s\S]*?)^\]$/mu) ??
    text.match(/^include = \[(?<body>[^\n]*?)\]$/mu);
  if (!match?.groups) fail('Cargo package template must declare one include array');
  const existing = [...match.groups.body.matchAll(/"([^"]+)"/gu)].map((item) => item[1]);
  const values = [...new Set([...existing, ...members])];
  const replacement = `include = [\n${values.map((value) => `  ${JSON.stringify(value)},`).join('\n')}\n]`;
  return text.slice(0, match.index) + replacement + text.slice(match.index + match[0].length);
}

function rewriteCargoManifest(
  manifest,
  { packageName, version, transformManifest, noticeProfile },
) {
  let text = readFileSync(manifest, 'utf8');
  text = text.replace(/^name = "[^"]+"$/mu, `name = "${packageName}"`);
  text = text.replace(/^version = "[^"]+"$/mu, `version = "${version}"`);
  text = text.replace(/^publish = false\n?/gmu, '');
  text = text.replace(
    /^license = "[^"]+"$/mu,
    `license = ${JSON.stringify(releaseProfilePackageLicense(noticeProfile).spdx)}`,
  );
  text = injectCargoNoticeIncludes(text, noticeProfile);
  if (transformManifest) text = transformManifest(text);
  if (!text.includes('\n[workspace]')) {
    text = `${text.trimEnd()}\n\n[workspace]\n`;
  }
  writeFileSync(manifest, text);
  const packageData = Bun.TOML.parse(readFileSync(manifest, 'utf8')).package;
  if (packageData.name !== packageName || packageData.version !== version) {
    fail(
      `${rel(manifest)} generated the wrong package metadata: name=${JSON.stringify(packageData.name)}, version=${JSON.stringify(packageData.version)}`,
    );
  }
}

function copyPackageSource(spec, sourceRoot, version, transformManifest) {
  const crateDir = path.join(sourceRoot, spec.name);
  if (existsSync(crateDir)) {
    fail(`duplicate generated WASIX Cargo package source: ${rel(crateDir)}`);
  }
  cpSync(spec.templateDir, crateDir, {
    recursive: true,
    filter: (source) => !['target', 'payload', 'artifacts'].includes(path.basename(source)),
  });
  cpSync(spec.payloadRoot, path.join(crateDir, spec.payloadDirName), { recursive: true });
  const noticeProfile = noticeProfileForSpec(spec);
  stageReleaseNotices(crateDir, { profile: noticeProfile });
  rewriteCargoManifest(path.join(crateDir, 'Cargo.toml'), {
    packageName: spec.name,
    version,
    transformManifest,
    noticeProfile,
  });
  assertReleaseNoticesInDirectory(crateDir, { profile: noticeProfile });
  return crateDir;
}

export function cargoPackage(crateDir, targetDir) {
  const manifest = path.join(crateDir, 'Cargo.toml');
  const { name } = Bun.TOML.parse(readFileSync(manifest, 'utf8')).package;
  return packageGeneratedCargoSource(manifest, path.join(targetDir, 'strict-package', name), {
    root: ROOT,
    fail,
    rel,
  });
}

export function validateCrateSize(cratePath) {
  const size = statSync(cratePath).size;
  if (size > CRATES_IO_MAX_BYTES) {
    fail(
      `${rel(cratePath)} is ${size} bytes, above the crates.io 10 MiB package limit; reduce the WASIX Cargo payload before publishing`,
    );
  }
}

export function packageSpec(
  spec,
  { version, sourceRoot, outputDir, cargoTargetDir, transformManifest },
) {
  const crateDir = copyPackageSource(spec, sourceRoot, version, transformManifest);
  const cratePath = cargoPackage(crateDir, cargoTargetDir);
  validateCrateSize(cratePath);
  const output = path.join(outputDir, path.basename(cratePath));
  copyFileSync(cratePath, output);
  const noticeProfile = noticeProfileForSpec(spec);
  assertReleaseNoticesInArchive(output, {
    prefix: `${spec.name}-${version}`,
    profile: noticeProfile,
  });
  return {
    name: spec.name,
    manifestPath: path.join(crateDir, 'Cargo.toml'),
    cratePath: output,
    target: spec.target,
    kind: spec.kind,
    size: statSync(output).size,
    sha256: sha256File(output),
  };
}
