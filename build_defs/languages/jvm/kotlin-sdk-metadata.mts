import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
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

/** Import source formatter scope without adding tooling to production metadata. */
export function kotlinQualityMetadata({ catalog, gradle }) {
  const library = catalog.libraries['ktlint-cli'];
  const version = catalog.versions[library?.version?.ref];
  if (
    library?.module !== 'com.pinterest.ktlint:ktlint-cli' ||
    library?.version?.ref !== 'ktlint' ||
    typeof version !== 'string' ||
    !/^\d+[.]\d+[.]\d+$/u.test(version)
  )
    throw new Error('Kotlin formatter requires its exact conventional ktlint-cli catalog pin');
  const blocks = [...gradle.matchAll(/^spotless\s*\{\n([\s\S]*?)^\}/gmu)];
  if (blocks.length !== 1)
    throw new Error('Kotlin formatter requires one conventional Spotless block');
  let remainder = blocks[0][1];
  const formats = [
    ...remainder.matchAll(/^ {4}(kotlin|kotlinGradle)\s*\{\n([\s\S]*?)^ {4}\}/gmu),
  ].map(([block, name, content]) => {
    remainder = remainder.replace(block, '');
    const declaration = content.match(
      /^\s*target\(([\s\S]*?)\)\s*ktlint\(\s*libs[.]versions[.]ktlint[.]get\(\)\s*,?\s*\)\s*(?:[.]editorConfigOverride\(\s*mapOf\(([\s\S]*?)\)\s*,?\s*\))?\s*$/u,
    );
    if (!declaration)
      throw new Error(
        `Kotlin formatter requires literal targets and canonical ktlint pin for ${name}`,
      );
    function literals(value: string, pattern: RegExp) {
      const matches = [...value.matchAll(pattern)];
      if (!matches.length || value.replace(pattern, '').replaceAll(',', '').trim())
        throw new Error('Kotlin formatter requires literal conventional scope/configuration');
      return matches;
    }
    const targets = literals(declaration[1], /"([^"\n]+)"/gu).map(([, target]) => {
      const relative = path.posix.normalize(`oliphaunt/${target}`);
      if (
        /[$\\\u0000-\u001f]/u.test(target) ||
        target.startsWith('/') ||
        relative === '..' ||
        relative.startsWith('../') ||
        !relative.endsWith(name === 'kotlin' ? '.kt' : '.gradle.kts')
      )
        throw new Error('Kotlin formatter targets must stay in the conventional SDK source tree');
      return relative;
    });
    const editorConfig = declaration[2]
      ? Object.fromEntries(
          literals(declaration[2], /"([A-Za-z0-9_.-]+)"\s+to\s+"([A-Za-z0-9_.-]+)"/gu).map(
            ([, key, value]) => [key, value],
          ),
        )
      : {};
    return { name, targets, editorConfig };
  });
  if (
    remainder.trim() ||
    formats
      .map(({ name }) => name)
      .sort()
      .join(',') !== 'kotlin,kotlinGradle'
  )
    throw new Error('Kotlin formatter requires exactly the conventional Kotlin and Gradle scopes');
  const lintVersion = catalog.versions['android-lint'];
  const agp = catalog.plugins['android-library'];
  const agpVersion = catalog.versions[agp?.version?.ref];
  if (
    typeof lintVersion !== 'string' ||
    !/^\d+[.]\d+[.]\d+$/u.test(lintVersion) ||
    agp?.id !== 'com.android.library' ||
    typeof agpVersion !== 'string' ||
    !/^\d+[.]\d+[.]\d+$/u.test(agpVersion)
  )
    throw new Error('Android Lint requires exact conventional Lint and Android plugin pins');
  return {
    ktlint: { module: library.module, version, formats },
    // lint-gradle declares the Groovy runtime used by GradleDetector. The
    // plain lint POM omits that official CLI detector dependency closure.
    lint: { module: 'com.android.tools.lint:lint-gradle', version: lintVersion, agpVersion },
  };
}

/** Keep the standalone Lint dependency resolver separate from SDK/formatter libraries. */
export function kotlinLintCatalog(inputs: Parameters<typeof kotlinQualityMetadata>[0]) {
  const { lint } = kotlinQualityMetadata(inputs);
  return `[versions]\nandroid-lint = "${lint.version}"\n\n[libraries]\nandroid-lint = { module = "${lint.module}", version.ref = "android-lint" }\n`;
}

if (import.meta.main) {
  const [catalog, gradle, pluginGradle, properties, version, sdk, output] = process.argv.slice(2);
  if (!output || process.argv.length !== 9)
    throw new Error(
      'usage: kotlin-sdk-metadata.mts CATALOG GRADLE PLUGIN_GRADLE PROPERTIES VERSION ANDROID_SDK OUTPUT',
    );
  const inputs = {
    catalog: Bun.TOML.parse(readFileSync(catalog, 'utf8')),
    gradle: readFileSync(gradle, 'utf8'),
    pluginGradle: readFileSync(pluginGradle, 'utf8'),
    properties: readFileSync(properties, 'utf8'),
    version: readFileSync(version, 'utf8').trim(),
    androidSdk: Bun.TOML.parse(readFileSync(sdk, 'utf8')),
  };
  writeFileSync(
    output,
    `KOTLIN = ${JSON.stringify(kotlinSdkMetadata(inputs), null, 2)}\nKOTLIN_QUALITY = ${JSON.stringify(kotlinQualityMetadata(inputs), null, 2)}\n`,
  );
  writeFileSync(path.join(path.dirname(output), 'lint.versions.toml'), kotlinLintCatalog(inputs));
}
