#!/usr/bin/env bun
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { compareText } from '../../../shared/product-metadata/release-artifact-targets.mts';
import {
  fail,
  inspectSdkProduct,
  rel,
} from '../../../shared/artifact-packaging/release-carrier.mts';
import { assertWasixTypescriptNpmArchive } from './wasix-typescript-package.mts';
import { assertWasixToolsTypescriptNpmArchive } from '../tools-package/tools/wasix-tools-typescript-package.mts';

export async function checkWasixTypescriptPackage(root) {
  const product = 'oliphaunt-wasix-ts';
  let checked = false;

  const tarballs = readdirSync(root)
    .filter((name) => name.endsWith('.tgz'))
    .map((name) => path.join(root, name))
    .sort(compareText);
  if (tarballs.length !== 2) {
    fail(`${product} must stage the binding and tools npm tarballs under ${rel(root)}`);
  }
  try {
    const binding = tarballs.find((file) => path.basename(file).startsWith('oliphaunt-wasix-ts-'));
    const tools = tarballs.find((file) => path.basename(file).startsWith('oliphaunt-wasix-tools-'));
    if (binding === undefined || tools === undefined) {
      fail(`${product} staged unexpected npm tarball names`);
    }
    assertWasixTypescriptNpmArchive(binding);
    assertWasixToolsTypescriptNpmArchive(tools);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  checked = true;

  return checked;
}

if (import.meta.main) await inspectSdkProduct('oliphaunt-wasix-ts', checkWasixTypescriptPackage);
