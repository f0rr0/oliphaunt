#!/usr/bin/env bun
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { compareText } from '../../../shared/product-metadata/release-artifact-targets.mts';
import {
  archiveTarNames,
  fail,
  inspectSdkProduct,
  rejectSdkRuntimePayload,
  rel,
} from '../../../shared/artifact-packaging/release-carrier.mts';
import {
  SOURCE_ONLY_NPM_PROFILES,
  assertSourceOnlyNpmArchive,
} from '../../../shared/artifact-packaging/source-only-sdk-package.mts';

export async function checkJavascriptPackage(root) {
  const product = 'oliphaunt-js';
  let checked = false;

  const tarballs = readdirSync(root)
    .filter((name) => name.endsWith('.tgz'))
    .map((name) => path.join(root, name))
    .sort(compareText);
  if (tarballs.length === 0) {
    fail(`${product} must stage an npm tarball under ${rel(root)}`);
  }
  for (const tarball of tarballs) {
    const names = archiveTarNames(tarball);
    rejectSdkRuntimePayload(product, tarball, names);
    try {
      assertSourceOnlyNpmArchive(tarball, SOURCE_ONLY_NPM_PROFILES.js);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }

    checked = true;
  }

  return checked;
}

if (import.meta.main) await inspectSdkProduct('oliphaunt-js', checkJavascriptPackage);
