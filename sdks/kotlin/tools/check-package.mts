#!/usr/bin/env bun
import {
  archiveZipNames,
  fail,
  inspectSdkProduct,
  isDirectory,
  rejectSdkRuntimePayload,
  rel,
  walkFiles,
} from '../../../tools/packaging/release-carrier.mts';
import { compareText } from '../../../tools/release/release-artifact-targets.mts';
import path from 'node:path';
import { readPortableArchiveEntries } from '../../../tools/packaging/portable-archive.mts';
import { assertRustDependencyLicensesInEntries } from '../../rust/mobile-bindings/tools/dependency-license-contract.mts';

const KOTLIN_RELEASE_ABIS = new Set(['arm64-v8a', 'x86_64']);

function validateKotlinAndroidAar(artifact, names) {
  const presentAbis = new Set(
    names
      .map((name) => name.split('/'))
      .filter(
        (parts) =>
          parts.length === 3 &&
          parts[0] === 'jni' &&
          parts[2] === 'liboliphaunt_mobile_bindings.so',
      )
      .map((parts) => parts[1]),
  );
  if (
    presentAbis.size !== KOTLIN_RELEASE_ABIS.size ||
    [...presentAbis].some((abi) => !KOTLIN_RELEASE_ABIS.has(abi))
  ) {
    fail(
      `Kotlin Android release AAR ${rel(artifact)} must contain generated native bindings for ` +
        `${[...KOTLIN_RELEASE_ABIS].sort(compareText).join(', ')}; got ${[...presentAbis].sort(compareText).join(', ') || '(none)'}`,
    );
  }
}

export async function checkKotlinPackage(root) {
  const product = 'oliphaunt-kotlin';
  let checked = false;

  const mavenRoot = path.join(root, 'maven');
  if (!isDirectory(mavenRoot)) {
    fail(`${product} must stage a Maven repository under ${rel(mavenRoot)}`);
  }
  for (const archive of walkFiles(root)
    .filter((file) => file.endsWith('.aar') || file.endsWith('.jar'))
    .sort(compareText)) {
    const names = archiveZipNames(archive);
    rejectSdkRuntimePayload(product, archive, names);
    if (archive.endsWith('.aar')) {
      validateKotlinAndroidAar(archive, names);
      const entries = readPortableArchiveEntries(archive, { format: 'zip' });
      for (const target of ['android-arm64', 'android-x86_64']) {
        assertRustDependencyLicensesInEntries(entries, {
          target,
          prefix: `assets/oliphaunt-native-bindings/${target}`,
          label: archive,
        });
      }
    }
    checked = true;
  }

  return checked;
}

if (import.meta.main) await inspectSdkProduct('oliphaunt-kotlin', checkKotlinPackage);
