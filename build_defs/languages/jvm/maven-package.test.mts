import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateKotlinMavenStagingClosure } from '../../../src/native/sdks/kotlin/tools/kotlin-maven-staging.mts';
import { createDeterministicZip } from '../../../tools/packaging/archive-directory.mts';
import { readPortableArchiveEntries } from '../../../tools/packaging/portable-archive.mts';
import { elfFixture } from '../../../tools/packaging/testdata/release-fixture-utils.mts';
import { zipArchive } from '../../../tools/packaging/testdata/zip-fixture.mts';
import { kotlinSdkMetadata } from './kotlin-sdk-metadata.mts';
import { packageKotlinMaven } from './maven-package.mts';

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
  const androidAar = path.join(scratch, 'base.aar');
  const androidManifest = `<?xml version="1.0" encoding="utf-8"?>\n<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="dev.oliphaunt">\n    <uses-sdk android:minSdkVersion="${kotlin.minSdk}" android:targetSdkVersion="${kotlin.compileSdk}" />\n    <application />\n</manifest>\n`;
  // Maintained Android construction emits FAT attributes=0, deflated entries
  // with signed data descriptors, including an empty res/ directory.
  writeFileSync(
    androidAar,
    zipArchive(
      [
        {
          name: 'AndroidManifest.xml',
          data: androidManifest,
        },
        { name: 'classes.jar', data: readFileSync(compiled) },
        { name: 'res/', data: '' },
        { name: 'R.txt', data: '' },
        { name: 'proguard.txt', data: '-keep class dev.oliphaunt.** { *; }\n' },
      ].map((entry) => ({
        ...entry,
        versionMadeBy: 0x0014,
        externalAttributes: 0,
        method: 8,
        descriptor: 'signed',
      })),
    ),
  );
  const coroutinesJvm = await zip(
    `processed_kotlinx-coroutines-core-jvm-${kotlin.libraries['kotlinx-coroutines-core'].version}.jar`,
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
    androidManifest,
    coroutinesJvm,
    coroutinesCoordinates: `${kotlin.libraries['kotlinx-coroutines-core'].module}-jvm:${kotlin.libraries['kotlinx-coroutines-core'].version}`,
    sources: { 'generated/Source.kt': source },
    javadoc: { 'index.html': html },
    legalSources: Object.fromEntries(members.map((member) => [member, path.join(ROOT, member)])),
  };
}
test('three native envelopes preserve the exact existing ten-file Maven closure', async () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-native-maven-'));
  try {
    const values = await fixture(scratch);
    expect(() => readPortableArchiveEntries(values.androidAar, { format: 'zip' })).toThrow(
      'inconsistent FAT directory metadata',
    );
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
    expect(entries.get('AndroidManifest.xml')?.data().toString()).toBe(values.androidManifest);
    expect(entries.get('R.txt')?.data()).toHaveLength(0);
    expect(entries.get('proguard.txt')?.data().toString()).toBe(
      '-keep class dev.oliphaunt.** { *; }\n',
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
test('compiler AAR input keeps directory, link and native payload checks', async () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-native-maven-aar-bad-'));
  try {
    const values = await fixture(scratch);
    for (const [entry, message] of [
      [
        { name: 'res/', data: 'payload', versionMadeBy: 0x0014, externalAttributes: 0 },
        'non-empty ZIP directory',
      ],
      [
        { name: 'res/link', data: '../escape', externalAttributes: 0o120777 << 16 },
        'link or special',
      ],
      [{ name: 'jni/arm64-v8a/undeclared.so', data: 'payload' }, 'smuggle native runtime'],
    ] as const) {
      writeFileSync(values.androidAar, zipArchive([entry]));
      await expect(
        packageKotlinMaven(path.join(scratch, 'maven'), {
          ...values,
          coordinate: REGISTRY[0],
        }),
      ).rejects.toThrow(message);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
test('requires one self-closing uses-sdk with exactly the canonical Android attributes', async () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-native-maven-manifest-bad-'));
  try {
    const values = await fixture(scratch);
    const sdk = values.androidManifest.match(/<uses-sdk\b[^>]*>/u)?.[0];
    if (!sdk) throw new Error('Fixture must declare uses-sdk');
    for (const [manifest, message] of [
      [values.androidManifest.replace(sdk, ''), 'exactly one uses-sdk'],
      [values.androidManifest.replace(sdk, `${sdk}\n${sdk}`), 'exactly one uses-sdk'],
      [values.androidManifest.replace(sdk, sdk.replace('/>', '>')), 'self-closing'],
      [
        values.androidManifest.replace('android:minSdkVersion="24"', 'android:minSdkVersion="23"'),
        'canonical Android SDK attributes',
      ],
      [
        values.androidManifest.replace(
          'android:targetSdkVersion="36"',
          'android:targetSdkVersion="35"',
        ),
        'canonical Android SDK attributes',
      ],
      [
        values.androidManifest.replace(sdk, sdk.replace('/>', 'android:maxSdkVersion="36" />')),
        'canonical Android SDK attributes',
      ],
      [
        values.androidManifest.replace(sdk, sdk.replace('android:minSdkVersion', 'minSdkVersion')),
        'canonical Android SDK attributes',
      ],
      [
        values.androidManifest.replace(sdk, sdk.replace('/>', 'android:minSdkVersion="24" />')),
        'canonical Android SDK attributes',
      ],
      [
        values.androidManifest.replace(
          'http://schemas.android.com/apk/res/android',
          'https://example.com',
        ),
        'canonical Android namespace',
      ],
    ]) {
      writeFileSync(
        values.androidAar,
        zipArchive([{ name: 'AndroidManifest.xml', data: manifest }]),
      );
      await expect(
        packageKotlinMaven(path.join(scratch, 'maven'), {
          ...values,
          coordinate: REGISTRY[0],
        }),
      ).rejects.toThrow(message);
    }
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
    ).rejects.toThrow('actual JVM library');
    for (const coroutinesCoordinates of [
      values.coroutinesCoordinates.replace(
        'kotlinx-coroutines-core-jvm',
        'kotlinx-coroutines-core',
      ),
      values.coroutinesCoordinates.replace(/:[^:]+$/u, ':0.0.0'),
      undefined,
    ])
      await expect(
        packageKotlinMaven(output, {
          ...values,
          coordinate: REGISTRY[0],
          coroutinesCoordinates,
        }),
      ).rejects.toThrow('canonical JVM Maven coordinates');
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
