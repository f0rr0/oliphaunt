#!/usr/bin/env bun
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { compareText } from '../../../../tools/release/release-artifact-targets.mts';
import { fail, inspectSdkProduct, rel } from '../../../../tools/packaging/release-carrier.mts';
import { assertWasixTypescriptNpmArchive } from './wasix-typescript-package.mts';

export async function checkWasixTypescriptPackage(root) {
  const product = 'oliphaunt-wasix-ts';
  let checked = false;

  const tarballs = readdirSync(root)
    .filter((name) => name.endsWith('.tgz'))
    .map((name) => path.join(root, name))
    .sort(compareText);
  if (tarballs.length !== 1) {
    fail(`${product} must stage one SDK npm tarball under ${rel(root)}`);
  }
  try {
    assertWasixTypescriptNpmArchive(tarballs[0]);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  checked = true;

  return checked;
}

if (import.meta.main) await inspectSdkProduct('oliphaunt-wasix-ts', checkWasixTypescriptPackage);
