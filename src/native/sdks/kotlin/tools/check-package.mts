#!/usr/bin/env bun
import {
  archiveZipNames,
  fail,
  inspectSdkProduct,
  isDirectory,
  rejectSdkRuntimePayload,
  rel,
  walkFiles,
} from '../../../../../tools/packaging/release-carrier.mts';
import { compareText } from '../../../../../tools/release/release-artifact-targets.mts';
import path from 'node:path';
import { readPortableArchiveEntries } from '../../../../../tools/packaging/portable-archive.mts';
import { assertRustDependencyLicensesInEntries } from '../../../mobile-bindings/tools/dependency-license-contract.mts';

const KOTLIN_RELEASE_ABIS = new Set(['arm64-v8a', 'x86_64']);
const GRADLE_PLUGIN_DESCRIPTOR = 'META-INF/gradle-plugins/dev.oliphaunt.android.properties';
const GRADLE_PLUGIN_IMPLEMENTATION = 'dev.oliphaunt.android.OliphauntAndroidPlugin';
const GRADLE_PLUGIN_IMPLEMENTATION_ENTRY = `${GRADLE_PLUGIN_IMPLEMENTATION.replaceAll('.', '/')}.class`;

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

export function validateKotlinGradlePluginJar(artifact, entries) {
  const descriptor = entries.get(GRADLE_PLUGIN_DESCRIPTOR);
  if (!descriptor) return false;

  const implementations = descriptor
    .data()
    .toString('utf8')
    .split(/\r?\n/u)
    .map((line) => line.match(/^implementation-class\s*[:=]\s*(\S+)\s*$/u)?.[1])
    .filter(Boolean);
  if (implementations.length !== 1 || implementations[0] !== GRADLE_PLUGIN_IMPLEMENTATION) {
    throw new Error(
      `Kotlin Android Gradle plugin ${rel(artifact)} must declare exactly ` +
        `implementation-class=${GRADLE_PLUGIN_IMPLEMENTATION}`,
    );
  }
  if (!entries.has(GRADLE_PLUGIN_IMPLEMENTATION_ENTRY)) {
    throw new Error(
      `Kotlin Android Gradle plugin ${rel(artifact)} declares ` +
        `${GRADLE_PLUGIN_IMPLEMENTATION} but does not contain ${GRADLE_PLUGIN_IMPLEMENTATION_ENTRY}`,
    );
  }
  return true;
}

export async function checkKotlinPackage(root) {
  const product = 'oliphaunt-kotlin';
  let checked = false;
  let checkedGradlePlugin = false;

  const mavenRoot = path.join(root, 'maven');
  if (!isDirectory(mavenRoot)) {
    fail(`${product} must stage a Maven repository under ${rel(mavenRoot)}`);
  }
  for (const archive of walkFiles(root)
    .filter((file) => file.endsWith('.aar') || file.endsWith('.jar'))
    .sort(compareText)) {
    const names = archiveZipNames(archive);
    const entries = readPortableArchiveEntries(archive, { format: 'zip' });
    rejectSdkRuntimePayload(product, archive, names);
    try {
      checkedGradlePlugin = validateKotlinGradlePluginJar(archive, entries) || checkedGradlePlugin;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    if (archive.endsWith('.aar')) {
      validateKotlinAndroidAar(archive, names);
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
  if (!checkedGradlePlugin) {
    fail(`${product} must contain the dev.oliphaunt.android Gradle plugin JAR`);
  }

  return checked;
}

if (import.meta.main) await inspectSdkProduct('oliphaunt-kotlin', checkKotlinPackage);
