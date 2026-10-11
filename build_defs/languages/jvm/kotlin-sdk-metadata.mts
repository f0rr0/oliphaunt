import { readFileSync, writeFileSync } from 'node:fs';
import { conventionalPomMetadata } from './maven-pom.mts';

export function kotlinSdkMetadata({
  catalog,
  gradle,
  pluginGradle,
  properties,
  version,
  androidSdk,
}) {
  const single = (pattern, label) => {
    const matches = [...gradle.matchAll(pattern)];
    if (matches.length !== 1)
      throw new Error(`Kotlin SDK requires one conventional ${label} declaration`);
    return matches[0][1];
  };
  const compileSdk = Number(single(/\bcompileSdk\s*=\s*(\d+)/gu, 'compileSdk'));
  const minSdk = Number(single(/\bminSdk\s*=\s*(\d+)/gu, 'minSdk'));
  const namespace = single(/\bnamespace\s*=\s*"([^"]+)"/gu, 'Android namespace');
  const jvmTarget = single(
    /gradleProperty\("oliphauntJvmToolchain"\)\s*[.]orElse\("(\d+)"\)/gu,
    'JVM target',
  );
  const props = Object.fromEntries(
    properties
      .split('\n')
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => line.split('=', 2)),
  );
  if (
    compileSdk !== Number(androidSdk.packages.compile_sdk) ||
    !Number.isSafeInteger(minSdk) ||
    minSdk < 1 ||
    minSdk > compileSdk ||
    namespace !== 'dev.oliphaunt' ||
    props.VERSION_NAME !== version ||
    props.GROUP !== 'dev.oliphaunt'
  )
    throw new Error(
      'Kotlin SDK compiler/publication defaults differ from the conventional Android and product manifests',
    );
  if (!/^\d+[.]\d+[.]\d+$/u.test(catalog.versions.kotlin) || !/^\d+$/u.test(jvmTarget))
    throw new Error('Kotlin SDK requires exact compiler and JVM target versions');
  function library(alias) {
    const raw = catalog.libraries[alias];
    const version =
      typeof raw?.version === 'string' ? raw.version : catalog.versions[raw?.version?.ref];
    if (
      !raw ||
      !/^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$/u.test(raw.module) ||
      typeof version !== 'string' ||
      version.length === 0
    )
      throw new Error(
        `Kotlin SDK catalog library ${alias} must have one exact conventional coordinate`,
      );
    return { module: raw.module, version };
  }
  const libraries = Object.fromEntries(
    ['kotlin-stdlib', 'jna', 'kotlinx-coroutines-core'].map((alias) => [alias, library(alias)]),
  );
  if (libraries['kotlin-stdlib'].version !== catalog.versions.kotlin)
    throw new Error('Kotlin stdlib must retain the compiler version owner');
  return {
    compilerVersion: catalog.versions.kotlin,
    languageVersion: catalog.versions.kotlin.split('.').slice(0, 2).join('.'),
    jvmTarget,
    compileSdk,
    minSdk,
    namespace,
    libraries,
    sdkPom: conventionalPomMetadata(gradle, version),
    pluginPom: conventionalPomMetadata(pluginGradle, version),
  };
}

if (import.meta.main) {
  const [catalog, gradle, pluginGradle, properties, version, sdk, output] = process.argv.slice(2);
  if (!output || process.argv.length !== 9)
    throw new Error(
      'usage: kotlin-sdk-metadata.mts CATALOG GRADLE PLUGIN_GRADLE PROPERTIES VERSION ANDROID_SDK OUTPUT',
    );
  const metadata = kotlinSdkMetadata({
    catalog: Bun.TOML.parse(readFileSync(catalog, 'utf8')),
    gradle: readFileSync(gradle, 'utf8'),
    pluginGradle: readFileSync(pluginGradle, 'utf8'),
    properties: readFileSync(properties, 'utf8'),
    version: readFileSync(version, 'utf8').trim(),
    androidSdk: Bun.TOML.parse(readFileSync(sdk, 'utf8')),
  });
  writeFileSync(output, `KOTLIN = ${JSON.stringify(metadata, null, 2)}\n`);
}
