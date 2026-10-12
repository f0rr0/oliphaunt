import { expect, test } from 'bun:test';
import { swiftExtensionReleaseConsumerFiles } from './extension-release-consumer.mts';
import { localizeSwiftExtensionFixturePackage } from './swift-extension-fixture-consumer.mts';

test('private fixture localization preserves the actual SDK adoption and rejects substituted requirements', () => {
  const products = {
    basePackage: { url: 'https://github.com/f0rr0/oliphaunt.git', version: '0.8.2' },
  };
  const manifest = '.package(\nurl: "https://github.com/f0rr0/oliphaunt.git", exact: "0.8.2"\n)';
  expect(
    localizeSwiftExtensionFixturePackage(manifest, products, '0.8.2', '/private/sdk'),
  ).toContain('path: "/private/sdk"');
  expect(() =>
    localizeSwiftExtensionFixturePackage(manifest, products, '0.8.3', '/private/sdk'),
  ).toThrow();
  expect(() =>
    localizeSwiftExtensionFixturePackage(
      manifest.replace('0.8.2', '0.8.3'),
      products,
      '0.8.2',
      '/private/sdk',
    ),
  ).toThrow();
  expect(() =>
    localizeSwiftExtensionFixturePackage(manifest + manifest, products, '0.8.2', '/private/sdk'),
  ).toThrow();
});

test('the real Swift consumer checks packaged SQL, native registration and exact linked runtime', () => {
  const plan = {
    extensions: ['vector'],
    extensionProducts: ['oliphaunt-extension-vector'],
    finalLink: {
      kind: 'native-extension',
      nativeExtension: 'vector',
      nativeModuleStem: 'vector',
      runtimeProduct: 'liboliphaunt-native',
      runtimeVersion: '0.3.3',
    },
  };
  const products = {
    nativeRuntime: { product: 'liboliphaunt-native', version: '0.3.3' },
    selected: [
      {
        swiftProduct: 'OliphauntVector',
        sqlName: 'vector',
        product: 'oliphaunt-extension-vector',
        nativeModuleStem: 'vector',
      },
    ],
  };
  const result = swiftExtensionReleaseConsumerFiles({
    plan,
    products,
    selectedPackage: '/private/selected',
    releasePackage: '/private/sdk',
  });
  expect(result.main).toContain('try OliphauntVector.register()');
  expect(result.main).toContain('linkedNativeRuntimeVersion == "0.3.3"');
  expect(result.packageFile).toContain('path: "/private/selected"');
  expect(() =>
    swiftExtensionReleaseConsumerFiles({
      plan,
      products: {
        ...products,
        nativeRuntime: { product: 'liboliphaunt-native', version: '0.3.4' },
      },
      selectedPackage: '/private/selected',
      releasePackage: '/private/sdk',
    }),
  ).toThrow();
});
