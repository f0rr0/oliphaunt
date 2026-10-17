import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { validateMavenCentralPublication } from '../../../tools/packaging/maven-central-contract.mts';
import {
  kotlinLintCatalog,
  kotlinQualityMetadata,
  kotlinSdkMetadata,
} from './kotlin-sdk-metadata.mts';
import { mavenPom } from './maven-pom.mts';

const read = (member: string) =>
  readFileSync(new URL(`../../../${member}`, import.meta.url), 'utf8');
function inputs() {
  return {
    catalog: Bun.TOML.parse(read('src/native/sdks/kotlin/gradle/libs.versions.toml')),
    gradle: read('src/native/sdks/kotlin/oliphaunt/build.gradle.kts'),
    pluginGradle: read('src/native/sdks/kotlin/oliphaunt-android-gradle-plugin/build.gradle.kts'),
    properties: read('src/native/sdks/kotlin/gradle.properties'),
    version: read('src/native/sdks/kotlin/VERSION').trim(),
    androidSdk: Bun.TOML.parse(read('tools/dev/android-sdk.toml')),
  };
}
test('imports compiler, Android and POM facts from the conventional manifests', () => {
  const source = inputs();
  const metadata = kotlinSdkMetadata(source);
  expect(metadata.compilerVersion).toBe(source.catalog.versions.kotlin);
  expect(metadata.jvmTarget).toBe('17');
  expect(metadata.languageVersion).toBe('2.2');
  expect(metadata.compileSdk).toBe(Number(source.androidSdk.packages.compile_sdk));
  expect(metadata.minSdk).toBe(24);
  expect(metadata.libraries.jna.version).toBe(source.catalog.versions.jna);
  expect(metadata.sdkPom.license.url).toContain(`oliphaunt-kotlin-v${source.version}/LICENSE`);
  expect(metadata.pluginPom.scm.developerConnection).toContain('github.com:f0rr0');
  const coordinate = {
    groupId: 'dev.oliphaunt',
    artifactId: 'oliphaunt-android',
    version: source.version,
    packaging: 'aar',
  };
  const validated = validateMavenCentralPublication({
    pomText: mavenPom({ coordinate, metadata: metadata.sdkPom }),
    files: [`.aar`, '.pom', '-sources.jar', '-javadoc.jar'].map((suffix) => ({
      name: `${coordinate.artifactId}-${source.version}${suffix}`,
      size: 1,
    })),
  });
  expect(validated.artifactId).toBe(coordinate.artifactId);
});

test('imports the existing Spotless formatter pin and scopes separately from production facts', () => {
  const source = inputs();
  const before = kotlinSdkMetadata(source);
  const metadata = kotlinQualityMetadata(source).ktlint;
  expect(metadata.version).toBe('1.8.0');
  expect(metadata.formats).toEqual([
    {
      name: 'kotlin',
      targets: ['oliphaunt/src/**/*.kt', 'tests/public-api-consumer/src/**/*.kt'],
      editorConfig: {
        'ktlint_standard_property-naming': 'disabled',
        ktlint_code_style: 'intellij_idea',
      },
    },
    {
      name: 'kotlinGradle',
      targets: ['oliphaunt/*.gradle.kts', '*.gradle.kts', 'tests/public-api-consumer/*.gradle.kts'],
      editorConfig: {},
    },
  ]);
  source.catalog.versions.ktlint = '99.0.0';
  expect(kotlinSdkMetadata(source)).toEqual(before);
  expect(kotlinQualityMetadata(source).ktlint.version).toBe('99.0.0');
  expect(Object.keys(before.libraries)).toEqual([
    'kotlin-stdlib',
    'jna',
    'kotlinx-coroutines-core',
  ]);
});

test('preserves literal formatter facts across conventional multiline formatting', () => {
  const source = inputs();
  const expected = kotlinQualityMetadata(source);
  source.gradle = source.gradle
    .replace(
      'ktlint(libs.versions.ktlint.get())',
      'ktlint(\n            libs.versions.ktlint.get(),\n        )',
    )
    .replace(
      'target("src/**/*.kt", "../tests/public-api-consumer/src/**/*.kt")',
      'target(\n            "src/**/*.kt",\n            "../tests/public-api-consumer/src/**/*.kt",\n        )',
    );
  expect(kotlinQualityMetadata(source)).toEqual(expected);
  expect(expected.ktlint.formats.find(({ name }) => name === 'kotlinGradle').editorConfig).toEqual(
    {},
  );
});

test('isolates the conventional Android Lint tool pin from production and formatter resolution', () => {
  const source = inputs();
  const production = kotlinSdkMetadata(source);
  const formatter = kotlinQualityMetadata(source).ktlint;
  const aliases = Object.keys(source.catalog.libraries);
  const quality = kotlinQualityMetadata(source);
  expect(quality.lint).toEqual({
    module: 'com.android.tools.lint:lint-gradle',
    version: '31.11.1',
    agpVersion: source.catalog.versions['android-gradle-plugin'],
  });
  expect(Bun.TOML.parse(kotlinLintCatalog(source))).toEqual({
    versions: { 'android-lint': '31.11.1' },
    libraries: {
      'android-lint': {
        module: quality.lint.module,
        version: { ref: 'android-lint' },
      },
    },
  });
  source.catalog.versions['android-lint'] = '99.0.0';
  expect(kotlinSdkMetadata(source)).toEqual(production);
  expect(kotlinQualityMetadata(source).ktlint).toEqual(formatter);
  expect(Object.keys(source.catalog.libraries)).toEqual(aliases);
  expect(kotlinQualityMetadata(source).lint.version).toBe('99.0.0');
  source.catalog.versions['android-lint'] = 'latest.release';
  expect(() => kotlinLintCatalog(source)).toThrow(/exact conventional/u);
});

test('rejects unsupported or escaping formatter declarations instead of silently losing scope', () => {
  for (const change of [
    (source) => {
      source.gradle = source.gradle.replace('ktlint(libs.versions.ktlint.get())', 'ktlint()');
    },
    (source) => {
      source.gradle = source.gradle.replace('"src/**/*.kt"', '"../../outside/**/*.kt"');
    },
    (source) => {
      source.gradle = source.gradle.replace('target("src/**/*.kt",', 'target(computedTargets,');
    },
    (source) => {
      source.gradle = source.gradle.replace('kotlinGradle {', 'unknownFormat {');
    },
    (source) => {
      source.catalog.libraries['ktlint-cli'].version.ref = 'spotless';
    },
  ]) {
    const source = inputs();
    change(source);
    expect(() => kotlinQualityMetadata(source)).toThrow();
  }
});
test('rejects ambiguous or contradictory imported construction/publication facts', () => {
  const changes = [
    (value) => {
      value.androidSdk.packages.compile_sdk = '37';
    },
    (value) => {
      value.version = '999.0.0';
    },
    (value) => {
      value.catalog.libraries['kotlin-stdlib'].version = '1.0.0';
    },
    (value) => {
      value.gradle += '\ncompileSdk = 36\n';
    },
    (value) => {
      value.gradle = value.gradle.replace('minSdk = 24', 'minSdk = 99');
    },
    (value) => {
      value.pluginGradle = value.pluginGradle.replace(
        'name.set("MIT License")',
        'name.set("${computedLicense}")',
      );
    },
    (value) => {
      value.catalog.libraries.jna.version.ref = 'not-declared';
    },
  ];
  for (const change of changes) {
    const source = inputs();
    change(source);
    expect(() => kotlinSdkMetadata(source)).toThrow();
  }
});
