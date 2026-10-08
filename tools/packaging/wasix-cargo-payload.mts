import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fitCargoPayloadParts, packageGeneratedCargoSource } from './cargo-source-package.mts';
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
  if (existsSync(path.join(crateDir, 'build-support.rs'))) {
    writeFileSync(
      path.join(crateDir, 'build.rs'),
      'const PACKAGE_LOCAL: bool = true;\ninclude!("build-support.rs");\n',
    );
  }
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
  return freezeSpec(spec, crateDir, { version, outputDir, cargoTargetDir });
}

function freezeSpec(
  spec,
  crateDir,
  { version, outputDir, cargoTargetDir },
  cratePath = cargoPackage(crateDir, cargoTargetDir),
) {
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

export function aotPayloadPartParent(name) {
  return (
    name.match(
      /^(liboliphaunt-wasix-aot-x86_64-pc-windows-msvc|oliphaunt-wasix-tools-aot-x86_64-pc-windows-msvc)-part-(?!000)[0-9]{3}$/u,
    )?.[1] ?? null
  );
}

/** Preserve the AOT facade; Cargo privately reconstructs oversized V8 payloads. */
export function packageAotSpec(spec, options) {
  if (spec.target !== 'x86_64-pc-windows-msvc') return [packageSpec(spec, options)];
  const { version, sourceRoot, cargoTargetDir, transformManifest } = options;
  const crateDir = copyPackageSource(spec, sourceRoot, version, transformManifest);
  const probe = (directory) =>
    packageGeneratedCargoSource(
      path.join(directory, 'Cargo.toml'),
      path.join(cargoTargetDir, 'size-probe'),
      { packageSizeLimitBytes: Number.MAX_SAFE_INTEGER },
    );
  const candidate = probe(crateDir);
  if (statSync(candidate).size <= CRATES_IO_MAX_BYTES) {
    return [freezeSpec(spec, crateDir, options, candidate)];
  }
  const payloadRoot = path.join(crateDir, spec.payloadDirName);
  const files = readdirSync(payloadRoot, { recursive: true })
    .sort()
    .flatMap((relative) => {
      const file = path.join(payloadRoot, relative);
      const metadata = lstatSync(file);
      if (metadata.isDirectory()) return [];
      if (!metadata.isFile()) fail(`AOT payload must contain regular files: ${file}`);
      return [{ relative: relative.split(path.sep).join('/'), bytes: readFileSync(file) }];
    });
  const payload = Buffer.concat(files.map((file) => file.bytes));
  const profile = noticeProfileForSpec(spec);
  const parts = fitCargoPayloadParts(
    (budget) => {
      const result = [];
      for (let offset = 0; offset < payload.length; offset += budget) {
        if (result.length >= 999) fail('AOT payload exceeds supported part count');
        const name = `${spec.name}-part-${String(result.length + 1).padStart(3, '0')}`;
        const directory = path.join(sourceRoot, name);
        mkdirSync(path.join(directory, 'src'), { recursive: true });
        writeFileSync(
          path.join(directory, 'Cargo.toml'),
          `[package]\nname = ${JSON.stringify(name)}\nversion = ${JSON.stringify(version)}\nedition = "2024"\nrust-version = "1.96"\ndescription = "Internal Oliphaunt V8 AOT payload part"\nrepository = "https://github.com/f0rr0/oliphaunt"\nlicense = ${JSON.stringify(releaseProfilePackageLicense(profile).spdx)}\n\n[workspace]\n`,
        );
        writeFileSync(
          path.join(directory, 'payload.part'),
          payload.subarray(offset, offset + budget),
        );
        writeFileSync(
          path.join(directory, 'src/lib.rs'),
          'pub const PAYLOAD: &[u8] = include_bytes!("../payload.part");\n',
        );
        stageReleaseNotices(directory, { profile });
        result.push({ ...spec, name, directory });
      }
      return result;
    },
    (part) => probe(part.directory),
  );
  const manifest = path.join(crateDir, 'Cargo.toml');
  writeFileSync(
    manifest,
    readFileSync(manifest, 'utf8').replace(
      '[build-dependencies]',
      `[build-dependencies]\n${parts.map(({ name }) => `${name} = "=${version}"`).join('\n')}`,
    ),
  );
  let offset = 0;
  const writes = files
    .map(({ relative, bytes }) => {
      const begin = offset;
      offset += bytes.length;
      return `    let file = root.join(${JSON.stringify(relative)});\n    fs::create_dir_all(file.parent().unwrap()).expect("create AOT directory");\n    fs::write(file, &payload[${begin}..${offset}]).expect("write bundled AOT artifact");`;
    })
    .join('\n');
  writeFileSync(
    path.join(crateDir, 'build.rs'),
    `use std::{env, fs, path::PathBuf};
use sha2::{Digest, Sha256};
mod aot {
    const PACKAGE_LOCAL: bool = true;
    include!("build-support.rs");
    pub fn generate() { main(); }
}
fn main() {
    let parts: &[&[u8]] = &[${parts.map(({ name }) => `${name.replaceAll('-', '_')}::PAYLOAD`).join(', ')}];
    let payload = parts.concat();
    assert_eq!(format!("{:x}", Sha256::digest(&payload)), ${JSON.stringify(createHash('sha256').update(payload).digest('hex'))}, "bundled AOT payload digest");
    let root = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR")).join("artifacts");
    if root.exists() { fs::remove_dir_all(&root).expect("remove stale AOT payload"); }
${writes}
    println!("cargo::rerun-if-changed=build.rs");
    aot::generate();
}
`,
  );
  rmSync(payloadRoot, { recursive: true });
  return [
    ...parts.map((part) =>
      freezeSpec(
        part,
        part.directory,
        options,
        path.join(cargoTargetDir, 'size-probe', `${part.name}-${version}.crate`),
      ),
    ),
    freezeSpec(spec, crateDir, options),
  ];
}
