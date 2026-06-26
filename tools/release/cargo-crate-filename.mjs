#!/usr/bin/env bun

function fail(message) {
  console.error(`cargo-crate-filename.mjs: ${message}`);
  process.exit(2);
}

const manifest = Bun.argv[2];
if (manifest === undefined || manifest.length === 0) {
  fail('usage: tools/release/cargo-crate-filename.mjs <Cargo.toml>');
}

let parsed;
try {
  parsed = Bun.TOML.parse(await Bun.file(manifest).text());
} catch (error) {
  fail(`could not parse ${manifest}: ${error.message}`);
}

const packageConfig = parsed.package;
if (packageConfig === null || typeof packageConfig !== 'object' || Array.isArray(packageConfig)) {
  fail(`${manifest} must declare a [package] table`);
}

const { name, version } = packageConfig;
if (typeof name !== 'string' || name.length === 0) {
  fail(`${manifest} must declare package.name`);
}
if (typeof version !== 'string' || version.length === 0) {
  fail(`${manifest} must declare package.version`);
}

console.log(`${name}-${version}.crate`);
