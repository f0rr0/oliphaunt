#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { packageGeneratedCargoSource } from '../../tools/packaging/cargo-source-package.mts';
import { packGeneratedNpmCarrier } from '../../tools/packaging/npm-package.mts';
import {
  extractPortableArchiveTree,
  readPortableArchiveEntries,
} from '../../tools/packaging/portable-archive.mts';
import {
  emptyDirectoryPaths,
  filesystemTreeRows,
  logicalTreeSha256,
} from '../contracts/native-manifest.mts';
import { stageMobileSeed } from './package-mobile-carriers.mts';
import {
  releaseProfilePackageLicense,
  stageReleaseNotices,
} from '../../tools/packaging/release-notices.mts';
import { currentProductVersionSync, ROOT } from '../../tools/release/release-artifact-targets.mts';
import { seedCarrierIdentities } from './carrier-identities.mts';

export function packageSeedCarriers(argv = [], { assetDir, outputDir, sourceDir } = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      family: { type: 'string' },
      target: { type: 'string' },
      profile: { type: 'string' },
    },
  });
  const selected = seedCarrierIdentities().filter((item) =>
    Object.entries(values).every(([key, value]) => item[key] === value),
  );
  if (!selected.length) throw new Error('no declared seed carrier matches the selection');
  const version = currentProductVersionSync('database-resources');
  const output = path.resolve(
    outputDir ?? path.join(ROOT, 'target/database-resources/seed-carriers'),
  );
  const assets = path.resolve(
    assetDir ?? path.join(ROOT, 'target/database-resources/release-assets'),
  );
  mkdirSync(output, { recursive: true });
  const results = [];
  for (const identity of selected) {
    const stem = `database-resources-${version}-seed-${identity.suffix}`;
    const archive = path.join(assets, `${stem}.tar.zst`);
    const manifestFile = path.join(assets, `${stem}.json`);
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    const archiveBytes = readFileSync(archive);
    const entries = readPortableArchiveEntries(archive);
    if (
      entries.get('PG_VERSION')?.data().toString('utf8').trim() !==
        String(manifest.runtime.postgresMajor) ||
      !entries.get('global/pg_control')?.isFile
    )
      throw new Error(`${stem} is not an importable PostgreSQL cluster archive`);
    if (
      manifest.catalogProfile !== identity.profile ||
      manifest.runtime.engineFamily !== identity.family ||
      manifest.runtime.target !== identity.target ||
      manifest.archive.sha256 !== createHash('sha256').update(archiveBytes).digest('hex')
    )
      throw new Error(`${stem} does not match the selected seed or its checksum`);
    const stage = path.join(
      sourceDir ?? path.join(ROOT, 'target/database-resources/seed-package-sources'),
      identity.suffix,
    );
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(stage, { recursive: true });
    copyFileSync(archive, path.join(stage, 'seed.tar.zst'));
    copyFileSync(manifestFile, path.join(stage, 'manifest.json'));
    const noticeProfile = 'native-runtime-resources';
    const license = releaseProfilePackageLicense(noticeProfile).spdx;
    stageReleaseNotices(stage, { profile: noticeProfile });
    writeFileSync(
      path.join(stage, 'README.md'),
      `# ${identity.npm}\n\nOne ${identity.profile} ${identity.family} PostgreSQL cluster seed for ${identity.target}.\nSee manifest.json for physical compatibility and producer identity.\n${identity.profile === 'icu' ? 'ICU data comes from the separate canonical ICU dependency.\n' : ''}`,
    );
    const npm = {
      name: identity.npm,
      version,
      description: `PostgreSQL ${identity.family} ${identity.profile} cluster seed for ${identity.target}.`,
      license,
      repository: {
        type: 'git',
        url: 'git+https://github.com/f0rr0/oliphaunt.git',
        directory: 'database-resources',
      },
      publishConfig: { access: 'public', provenance: true },
      files: ['seed.tar.zst', 'manifest.json', 'LICENSE', 'THIRD_PARTY*'],
      exports: {
        './seed.tar.zst': './seed.tar.zst',
        './manifest.json': './manifest.json',
        './package.json': './package.json',
      },
      ...(identity.profile === 'icu' ? { dependencies: { '@oliphaunt/icu': version } } : {}),
    };
    if (identity.family === 'native') {
      let directory = 'pgdata';
      if (identity.target === 'ios-datum64') {
        const name = `OliphauntSeedNativeIOS${identity.profile === 'icu' ? 'ICU' : 'Standard'}`;
        const resource = identity.profile === 'icu' ? 'cluster-seed-icu' : 'cluster-seed';
        const bundle = `${name}.bundle`;
        let icuData;
        const icuStage = path.join(stage, '.icu-validation');
        if (identity.profile === 'icu') {
          extractPortableArchiveTree(
            path.join(assets, `database-resources-${version}-icu-data.tar.gz`),
            icuStage,
          );
          icuData = path.join(icuStage, 'share/icu');
        }
        stageMobileSeed({
          archive,
          manifest: manifestFile,
          destination: path.join(stage, bundle, resource),
          target: identity.target,
          profile: identity.profile,
          icuData,
        });
        rmSync(icuStage, { recursive: true, force: true });
        directory = `${bundle}/${resource}/files`;
        writeFileSync(
          path.join(stage, bundle, 'Info.plist'),
          `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.oliphaunt.seed.ios.${identity.profile}</string><key>CFBundleName</key><string>${name}</string><key>CFBundlePackageType</key><string>BNDL</string></dict></plist>\n`,
        );
        writeFileSync(
          path.join(stage, `${name}.podspec`),
          `Pod::Spec.new do |s|\n  s.name = '${name}'\n  s.version = '${version}'\n  s.summary = 'Selectable native PostgreSQL ${identity.profile} seed for iOS.'\n  s.homepage = 'https://oliphaunt.dev'\n  s.license = { :type => '${license}' }\n  s.author = { 'Oliphaunt Maintainers' => 'https://github.com/f0rr0' }\n  s.source = { :path => '.' }\n  s.platforms = { :ios => '17.0' }\n  s.resources = '${bundle}'\nend\n`,
        );
        writeFileSync(
          path.join(stage, 'react-native.config.js'),
          `module.exports = { dependency: { platforms: { ios: {}, android: null } } };\n`,
        );
        npm.files.push(bundle, `${name}.podspec`, 'react-native.config.js');
      } else {
        extractPortableArchiveTree(archive, path.join(stage, directory));
        npm.files.push(directory);
      }
      const treeSha256 = logicalTreeSha256(filesystemTreeRows(path.join(stage, directory)));
      writeFileSync(
        path.join(stage, 'manifest.json'),
        `${JSON.stringify({ ...manifest, directory: { path: directory, treeSha256, emptyDirectories: emptyDirectoryPaths(path.join(stage, directory)) } }, null, 2)}\n`,
      );
      npm.files = npm.files.filter((file) => file !== 'seed.tar.zst');
      delete npm.exports['./seed.tar.zst'];
      npm.exports['./pgdata/PG_VERSION'] = `./${directory}/PG_VERSION`;
      rmSync(path.join(stage, 'seed.tar.zst'));
    }
    writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify(npm, null, 2)}\n`);
    const npmArchive = packGeneratedNpmCarrier(stage, path.join(output, 'npm'));
    // Cargo preserves its existing compressed include_bytes interface.
    if (identity.family === 'native') {
      for (const name of readdirSync(stage)) {
        if (
          name === 'pgdata' ||
          name.endsWith('.bundle') ||
          name.endsWith('.podspec') ||
          name === 'react-native.config.js'
        )
          rmSync(path.join(stage, name), { recursive: true, force: true });
      }
    }
    copyFileSync(archive, path.join(stage, 'seed.tar.zst'));
    copyFileSync(manifestFile, path.join(stage, 'manifest.json'));
    rmSync(path.join(stage, 'package.json'));
    mkdirSync(path.join(stage, 'src'));
    writeFileSync(
      path.join(stage, 'src/lib.rs'),
      `#![deny(unsafe_code)]\npub fn seed_archive() -> &'static [u8] { include_bytes!("../seed.tar.zst") }\npub fn seed_manifest() -> &'static str { include_str!("../manifest.json") }\n${identity.profile === 'icu' ? 'pub use oliphaunt_icu as icu;\n' : ''}`,
    );
    writeFileSync(
      path.join(stage, 'Cargo.toml'),
      `[package]\nname = ${JSON.stringify(identity.cargo)}\nversion = ${JSON.stringify(version)}\nedition = "2024"\nrust-version = "1.93"\ndescription = ${JSON.stringify(npm.description)}\nlicense = ${JSON.stringify(license)}\nrepository = "https://github.com/f0rr0/oliphaunt"\ninclude = ["src/**", "seed.tar.zst", "manifest.json", "README.md", "LICENSE", "THIRD_PARTY*"]\n${identity.profile === 'icu' ? `\n[dependencies]\noliphaunt-icu = "=${version}"\n` : ''}\n[workspace]\n`,
    );
    const crate = packageGeneratedCargoSource(
      path.join(stage, 'Cargo.toml'),
      path.join(output, 'cargo'),
      { root: ROOT },
    );
    if (statSync(crate).size > 10 * 1024 * 1024)
      throw new Error(`${identity.cargo} exceeds the registry package limit`);
    results.push({ ...identity, version, npmArchive, crate });
  }
  return results;
}

if (import.meta.main)
  console.log(JSON.stringify(packageSeedCarriers(process.argv.slice(2)), null, 2));
