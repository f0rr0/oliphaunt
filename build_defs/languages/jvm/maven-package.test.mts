import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { kotlinSdkMetadata } from './kotlin-sdk-metadata.mts';
import { packageKotlinMaven } from './maven-package.mts';
import { createDeterministicZip } from '../../../tools/packaging/archive-directory.mts';
import { readPortableArchiveEntries } from '../../../tools/packaging/portable-archive.mts';
import { elfFixture } from '../../../tools/packaging/testdata/release-fixture-utils.mts';
import { validateKotlinMavenStagingClosure } from '../../../src/native/sdks/kotlin/tools/kotlin-maven-staging.mts';

const ROOT = path.resolve(import.meta.dir, '../../..');
const read = (member: string) => readFileSync(path.join(ROOT, member), 'utf8');
const OWNER = 'src/native/mobile-bindings';
const REGISTRY = [
  'dev.oliphaunt:oliphaunt-android',
  'dev.oliphaunt:oliphaunt-android-gradle-plugin',
  'dev.oliphaunt.android:dev.oliphaunt.android.gradle.plugin',
];
async function fixture(scratch: string) {
  const kotlin = kotlinSdkMetadata({
    catalog: Bun.TOML.parse(read('src/native/sdks/kotlin/gradle/libs.versions.toml')),
    gradle: read('src/native/sdks/kotlin/oliphaunt/build.gradle.kts'),
    pluginGradle: read('src/native/sdks/kotlin/oliphaunt-android-gradle-plugin/build.gradle.kts'),
    properties: read('src/native/sdks/kotlin/gradle.properties'),
    version: read('src/native/sdks/kotlin/VERSION').trim(),
    androidSdk: Bun.TOML.parse(read('tools/dev/android-sdk.toml')),
  });
  async function zip(name: string, entries: Record<string, string | Buffer>) {
    const tree = path.join(scratch, `${name}-tree`);
    for (const [member, bytes] of Object.entries(entries)) {
      const file = path.join(tree, member);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, bytes);
    }
    const archive = path.join(scratch, name);
    writeFileSync(archive, await createDeterministicZip(tree));
    return archive;
  }
  const compiled = await zip('sdk.jar', { 'dev/oliphaunt/Oliphaunt.class': 'compiled fixture' });
  const plugin = await zip('plugin.jar', {
    'dev/oliphaunt/android/OliphauntAndroidPlugin.class': 'compiled fixture',
    'META-INF/gradle-plugins/dev.oliphaunt.android.properties':
      'implementation-class=dev.oliphaunt.android.OliphauntAndroidPlugin\n',
  });
  const androidAar = await zip('base.aar', {
    'AndroidManifest.xml':
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="dev.oliphaunt"><application /></manifest>',
    'R.txt': '',
  });
  const coroutinesJvm = await zip(
    `kotlinx-coroutines-core-jvm-${kotlin.libraries['kotlinx-coroutines-core'].version}.jar`,
    { 'kotlinx/coroutines/Job.class': 'dependency fixture' },
  );
  const nativeLibraries = {};
  for (const [abi, machine] of [
    ['arm64-v8a', 183],
    ['x86_64', 62],
  ] as const) {
    const file = path.join(scratch, `${abi}.so`);
    writeFileSync(file, elfFixture({ machine, androidApi: 24 }));
    nativeLibraries[abi] = file;
  }
  const source = path.join(scratch, 'Source.kt');
  writeFileSync(source, 'package dev.oliphaunt\nclass Source\n');
  const html = path.join(scratch, 'index.html');
  writeFileSync(html, '<html>Fixture generated documentation</html>');
  const members = [
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    'Cargo.lock',
    `${OWNER}/dependency-licenses.json`,
    ...readdirSync(path.join(ROOT, OWNER, 'dependency-license-blobs')).map(
      (name) => `${OWNER}/dependency-license-blobs/${name}`,
    ),
  ];
  return {
    version: read('src/native/sdks/kotlin/VERSION').trim(),
    registryPackages: REGISTRY.map((coordinate) => `maven:${coordinate}`),
    kotlin,
    classJars: [compiled],
    plugin,
    nativeLibraries,
    androidAar,
    coroutinesJvm,
    sources: { 'generated/Source.kt': source },
    javadoc: { 'index.html': html },
    legalSources: Object.fromEntries(members.map((member) => [member, path.join(ROOT, member)])),
  };
}
test('three native envelopes preserve the exact existing ten-file Maven closure', async () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-native-maven-'));
  try {
    const values = await fixture(scratch);
    const output = path.join(scratch, 'maven');
    for (const coordinate of REGISTRY)
      await packageKotlinMaven(output, {
        ...values,
        coordinate,
        classJars: [coordinate === REGISTRY[1] ? values.plugin : values.classJars[0]],
      });
    const publication = validateKotlinMavenStagingClosure(output, values.version, {
      allowLocalMetadata: false,
    });
    expect(publication.publicationFiles).toHaveLength(10);
    const aar = path.join(
      output,
      publication.publicationFiles.find((name) => name.endsWith('.aar'))!,
    );
    const entries = readPortableArchiveEntries(aar, { format: 'zip' });
    expect(entries.get('AndroidManifest.xml')!.data().toString()).toContain(
      'android:minSdkVersion="24"',
    );
    expect(entries.has('jni/arm64-v8a/liboliphaunt_mobile_bindings.so')).toBeTrue();
    expect(entries.has('jni/x86_64/liboliphaunt_mobile_bindings.so')).toBeTrue();
    expect(
      entries.has(
        'assets/oliphaunt-native-bindings/android-arm64/THIRD_PARTY_LICENSES/rust/DEPENDENCIES.json',
      ),
    ).toBeTrue();
    const before = readFileSync(aar);
    await packageKotlinMaven(output, { ...values, coordinate: REGISTRY[0] });
    expect(readFileSync(aar).equals(before)).toBeTrue();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
test('rejects unowned coordinates, incomplete ABI inputs, wrong resolved dependencies and malformed native bytes', async () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-native-maven-bad-'));
  try {
    const values = await fixture(scratch);
    const output = path.join(scratch, 'maven');
    await expect(
      packageKotlinMaven(output, { ...values, coordinate: 'org.example:other' }),
    ).rejects.toThrow('canonical Kotlin owner');
    await expect(
      packageKotlinMaven(output, {
        ...values,
        coordinate: REGISTRY[0],
        nativeLibraries: { 'arm64-v8a': values.nativeLibraries['arm64-v8a'] },
      }),
    ).rejects.toThrow('both exact declared');
    const bad = readFileSync(values.nativeLibraries['arm64-v8a']);
    bad.writeBigUInt64LE(4096n, 112);
    writeFileSync(values.nativeLibraries['arm64-v8a'], bad);
    await expect(
      packageKotlinMaven(output, { ...values, coordinate: REGISTRY[0] }),
    ).rejects.toThrow('alignment');
    writeFileSync(
      values.nativeLibraries['arm64-v8a'],
      elfFixture({ machine: 183, androidApi: 24 }),
    );
    await expect(
      packageKotlinMaven(output, {
        ...values,
        coordinate: REGISTRY[0],
        coroutinesJvm: values.classJars[0],
      }),
    ).rejects.toThrow();
    await expect(
      packageKotlinMaven(output, {
        ...values,
        coordinate: REGISTRY[1],
        classJars: [values.plugin],
        javadoc: {},
      }),
    ).rejects.toThrow('real Javadoc');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
