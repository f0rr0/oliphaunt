import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { releaseNoticeRows, releaseProfilePackageLicense } from '../packaging/release-notices.mts';

const ROOT = path.resolve(import.meta.dirname, '../..');

const CORE_TEMPLATES = [
  ['runtimes/liboliphaunt-wasix/crates/assets/Cargo.toml', 'wasix-runtime'],
  ['postgres-tools/wasix/crates/tools/Cargo.toml', 'wasix-tools'],
  ['database-resources/icu/cargo/Cargo.toml', 'wasix-icu-data-crate'],
  ...[
    'aarch64-apple-darwin',
    'aarch64-unknown-linux-gnu',
    'x86_64-pc-windows-msvc',
    'x86_64-unknown-linux-gnu',
  ].flatMap((target) => [
    [`runtimes/liboliphaunt-wasix/crates/aot/${target}/Cargo.toml`, 'wasix-aot'],
    [`postgres-tools/wasix/crates/aot/${target}/Cargo.toml`, 'wasix-aot'],
  ]),
];

const ALL_NOTICE_MEMBERS = new Set(
  releaseNoticeRows({
    products: ['native', 'wasix'],
    components: ['postgresql', 'icu', 'openssl'],
  }).map((row) => row.member),
);

function manifest(relative) {
  return Bun.TOML.parse(readFileSync(path.join(ROOT, relative), 'utf8'));
}

test('oliphaunt-wasix source SDK remains an MIT-only facade', () => {
  assert.equal(manifest('Cargo.toml').workspace.package.license, 'MIT');
  const source = manifest('sdks/rust-wasix/Cargo.toml');
  assert.equal(source.package.license, 'MIT');
});

test('every WASIX payload Cargo template includes its exact legal profile', () => {
  for (const [relative, profile] of CORE_TEMPLATES) {
    const cargo = manifest(relative);
    assert.equal(
      cargo.package.license,
      releaseProfilePackageLicense(profile).spdx,
      `${relative} license`,
    );
    assert.ok(Array.isArray(cargo.package.include), `${relative} must declare package.include`);
    const includedNotices = cargo.package.include.filter((member) =>
      ALL_NOTICE_MEMBERS.has(member),
    );
    assert.deepEqual(
      includedNotices.sort(),
      releaseNoticeRows({ profile })
        .map((row) => row.member)
        .sort(),
      `${relative} notice include closure`,
    );
  }
});
