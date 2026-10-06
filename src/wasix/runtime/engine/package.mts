import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  fitCargoPayloadParts,
  packageGeneratedCargoSource,
  packagedCargoManifestText,
} from '../../../../tools/packaging/cargo-source-package.mts';
import { canonicalGzipSync } from '../../../../tools/packaging/portable-archive.mts';
import { releaseProfilePackageLicense } from '../../../../tools/packaging/release-notices.mts';
import { RUST_BUILD_SCRIPT_SHA256 } from '../../../../tools/packaging/rust-build-script-sha256.mts';
import { ROOT } from '../../../../tools/release/release-artifact-targets.mts';
import { archiveTreeDigest, sha256File } from '../../../third-party/tools/source-fetch-core.mts';
import { ENGINE_PAYLOAD_PACKAGE, ENGINE_SOURCE_CRATES } from './contract.mts';

const OWNER = path.join(ROOT, 'src/wasix/runtime/engine');
const DLL = 'oliphaunt_wee8.dll';

export function isEnginePayloadPart(name: string): boolean {
  return new RegExp(`^${ENGINE_PAYLOAD_PACKAGE}-part-[0-9]{3}$`, 'u').test(name);
}

/** Freeze qualified sources and engine bytes; this step never builds the engine. */
export function packageEngine({
  sourceRoot,
  outputDir,
  version,
  engineDir = path.join(ROOT, 'target/oliphaunt-wasix/engine/windows-x64-msvc'),
  cratesDir = path.join(OWNER, 'crates'),
  expectedSourceSha = process.env.RELEASE_ARTIFACT_SHA ??
    Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: ROOT }).stdout.toString().trim(),
}: {
  sourceRoot: string;
  outputDir: string;
  version: string;
  engineDir?: string;
  cratesDir?: string;
  expectedSourceSha?: string;
}) {
  const receipt = JSON.parse(readFileSync(path.join(engineDir, 'source.json'), 'utf8'));
  assert.equal(
    receipt.sourceSha,
    expectedSourceSha,
    'Windows engine must come from the qualified source commit',
  );
  assert.deepEqual(
    receipt.source,
    Bun.TOML.parse(readFileSync(path.join(OWNER, 'source.toml'), 'utf8')),
    'engine source pins',
  );
  assert.equal(
    sha256File(path.join(engineDir, DLL)),
    receipt.dllSha256,
    'frozen engine DLL digest',
  );
  assert.equal(
    sha256File(path.join(cratesDir, 'wasmer/prebuilt/embedded_bindings.rs')),
    receipt.bindingsSha256,
    'bindings must describe the frozen DLL',
  );
  for (const name of ENGINE_SOURCE_CRATES) {
    assert.equal(
      archiveTreeDigest(path.join(cratesDir, name, 'upstream')),
      receipt.engineSources[name],
      `${name}: qualified patched source digest`,
    );
  }

  const packages = [];
  function freeze(name: string, profile: string) {
    const manifestPath = path.join(sourceRoot, name, 'Cargo.toml');
    const cratePath = packageGeneratedCargoSource(manifestPath, outputDir, {
      noticeProfile: profile,
    });
    const row = {
      name,
      manifestPath,
      cratePath,
      target: name.startsWith(ENGINE_PAYLOAD_PACKAGE) ? 'windows-x64-msvc' : 'portable',
      kind: 'wasix-engine',
      size: statSync(cratePath).size,
      sha256: sha256File(cratePath),
    };
    packages.push(row);
    return cratePath;
  }
  function manifest(name: string, profile: string, extra: string) {
    const directory = path.join(sourceRoot, name);
    mkdirSync(path.join(directory, 'src'), { recursive: true });
    writeFileSync(
      path.join(directory, 'Cargo.toml'),
      `[package]\nname = ${JSON.stringify(name)}\nversion = ${JSON.stringify(version)}\nedition = "2024"\nrust-version = "1.96"\ndescription = "Internal Oliphaunt Windows engine carrier"\nrepository = "https://github.com/f0rr0/oliphaunt"\nlicense = ${JSON.stringify(releaseProfilePackageLicense(profile).spdx)}\n\n${extra}`,
    );
    return directory;
  }

  const compressed = canonicalGzipSync(readFileSync(path.join(engineDir, DLL)));
  const parts = fitCargoPayloadParts(
    (budget) => {
      const result = [];
      for (let offset = 0; offset < compressed.length; offset += budget) {
        const name = `${ENGINE_PAYLOAD_PACKAGE}-part-${String(result.length + 1).padStart(3, '0')}`;
        assert(result.length < 999, 'engine payload exceeds supported part count');
        const directory = manifest(name, 'wasix-engine-windows', '');
        writeFileSync(
          path.join(directory, 'payload.gz.part'),
          compressed.subarray(offset, offset + budget),
        );
        writeFileSync(
          path.join(directory, 'src/lib.rs'),
          'pub const PAYLOAD: &[u8] = include_bytes!("../payload.gz.part");\n',
        );
        result.push(name);
      }
      return result;
    },
    (name) =>
      packageGeneratedCargoSource(path.join(sourceRoot, name, 'Cargo.toml'), outputDir, {
        noticeProfile: 'wasix-engine-windows',
      }),
    8 * 1024 * 1024,
  );
  for (const name of parts) freeze(name, 'wasix-engine-windows');
  const directory = manifest(
    ENGINE_PAYLOAD_PACKAGE,
    'wasix-engine-windows',
    `[build-dependencies]\nflate2 = { version = "1", default-features = false, features = ["rust_backend"] }\nsha2 = "0.10"\n${parts.map((name) => `${name} = "=${version}"`).join('\n')}\n`,
  );
  cpSync(
    path.join(cratesDir, 'v8-windows-x64-msvc/src/lib.rs'),
    path.join(directory, 'src/lib.rs'),
  );
  writeFileSync(
    path.join(directory, 'build.rs'),
    `use std::{env, fs, io::{self, Read}, path::{Path, PathBuf}};
${RUST_BUILD_SCRIPT_SHA256}
fn main() {
    let parts: &[&[u8]] = &[${parts.map((name) => `${name.replaceAll('-', '_')}::PAYLOAD`).join(', ')}];
    let compressed: Vec<u8> = parts.iter().flat_map(|part| part.iter().copied()).collect();
    let mut decoder = flate2::read::GzDecoder::new(&compressed[..]).take(${statSync(path.join(engineDir, DLL)).size + 1});
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR")).join(${JSON.stringify(DLL)});
    let mut file = fs::File::create(&output).expect("create bundled engine");
    let size = io::copy(&mut decoder, &mut file).expect("decompress bundled engine");
    assert_eq!(size, ${statSync(path.join(engineDir, DLL)).size}, "bundled engine byte size");
    assert_eq!(sha256_file(&output).expect("hash bundled engine"), ${JSON.stringify(receipt.dllSha256)}, "bundled engine digest");
    println!("cargo::rerun-if-changed=build.rs");
}
`,
  );
  freeze(ENGINE_PAYLOAD_PACKAGE, 'wasix-engine-windows');

  for (const upstream of ENGINE_SOURCE_CRATES) {
    const name = `oliphaunt-${upstream}`;
    const destination = path.join(sourceRoot, name);
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(path.join(destination, 'upstream'), { recursive: true });
    cpSync(path.join(cratesDir, upstream, 'upstream/src'), path.join(destination, 'upstream/src'), {
      recursive: true,
    });
    const original = Bun.TOML.parse(
      readFileSync(path.join(cratesDir, upstream, 'Cargo.toml'), 'utf8'),
    );
    if (typeof original.package.readme === 'string')
      cpSync(
        path.join(cratesDir, upstream, original.package.readme),
        path.join(destination, original.package.readme),
      );
    cpSync(path.join(cratesDir, upstream, 'Cargo.toml'), path.join(destination, 'Cargo.toml'));
    if (upstream === 'wasmer') {
      cpSync(path.join(cratesDir, upstream, 'build.rs'), path.join(destination, 'build.rs'));
      cpSync(path.join(cratesDir, upstream, 'prebuilt'), path.join(destination, 'prebuilt'), {
        recursive: true,
      });
    }
    let text = packagedCargoManifestText(
      readFileSync(path.join(destination, 'Cargo.toml'), 'utf8'),
    );
    text = text
      .replace(/^publish = false\n/gmu, '')
      .replace(/^version = "[^"]+"$/mu, `version = "${version}"`);
    text = text.replace(
      /(package = "oliphaunt-wasmer[^"\n]*"\nversion = ")[^"]+/gu,
      `$1=${version}`,
    );
    text = text.replace(
      /(\[build-dependencies\.oliphaunt-wasmer-v8-windows-x64-msvc\]\nversion = ")[^"]+/u,
      `$1=${version}`,
    );
    writeFileSync(path.join(destination, 'Cargo.toml'), text);
    freeze(name, 'wasix-engine-source');
  }
  return packages;
}
