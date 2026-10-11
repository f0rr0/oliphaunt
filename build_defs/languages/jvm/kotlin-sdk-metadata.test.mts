import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { kotlinSdkMetadata } from './kotlin-sdk-metadata.mts';
import { mavenPom } from './maven-pom.mts';
import { validateMavenCentralPublication } from '../../../tools/packaging/maven-central-contract.mts';

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
