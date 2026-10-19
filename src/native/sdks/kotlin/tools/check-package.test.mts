import { expect, test } from 'bun:test';

import { validateKotlinGradlePluginJar } from './check-package.mts';

const descriptor = 'META-INF/gradle-plugins/dev.oliphaunt.android.properties';
const implementation = 'dev.oliphaunt.android.OliphauntAndroidPlugin';
const implementationEntry = 'dev/oliphaunt/android/OliphauntAndroidPlugin.class';

function entry(value = '') {
  return { data: () => Buffer.from(value) };
}

function pluginEntries({
  implementationClass = implementation,
  includeImplementation = true,
} = {}) {
  const entries = new Map([[descriptor, entry(`implementation-class=${implementationClass}\n`)]]);
  if (includeImplementation) entries.set(implementationEntry, entry());
  return entries;
}

test('accepts the Gradle plugin descriptor with its implementation class', () => {
  expect(validateKotlinGradlePluginJar('plugin.jar', pluginEntries())).toBe(true);
});

test('rejects a Gradle plugin JAR without its declared implementation', () => {
  expect(() =>
    validateKotlinGradlePluginJar('plugin.jar', pluginEntries({ includeImplementation: false })),
  ).toThrow(/does not contain.*OliphauntAndroidPlugin[.]class/u);
});

test('rejects an unexpected Gradle plugin implementation declaration', () => {
  expect(() =>
    validateKotlinGradlePluginJar(
      'plugin.jar',
      pluginEntries({ implementationClass: 'dev.oliphaunt.android.UnexpectedPlugin' }),
    ),
  ).toThrow(/must declare exactly implementation-class/u);
});
