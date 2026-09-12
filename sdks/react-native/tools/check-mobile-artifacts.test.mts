import test from 'node:test';
import assert from 'node:assert/strict';
import {
  iosCocoaPodsExtensionLinkEvidence,
  validateMobileExtensionManifestDomains,
  validatePackagedMobileRuntimeFiles,
  validatePackagedMobileRuntimeManifest,
} from './check-mobile-artifacts.mts';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CORE_SNOWBALL_RUNTIME_DATA_FILES } from './validate-mobile-runtime-files.mts';

const REACT_NATIVE_METADATA = JSON.parse(
  readFileSync(
    path.join(import.meta.dir, '../../../extensions/generated/sdk/extensions.json'),
    'utf8',
  ),
);

const MOBILE_STATIC_REGISTRY = JSON.parse(
  readFileSync(
    path.join(import.meta.dir, '../../../extensions/generated/mobile/static-registry.json'),
    'utf8',
  ),
);

function packagedMobileRuntimeNames(prefix, extensionAssets) {
  return [
    ...CORE_SNOWBALL_RUNTIME_DATA_FILES.map((name) => `${prefix}runtime/files/${name}`),
    ...extensionAssets.map((name) => `${prefix}runtime/files/share/postgresql/extension/${name}`),
  ];
}

test('packaged mobile apps require the native-direct runtime contract', () => {
  assert.doesNotThrow(() =>
    validatePackagedMobileRuntimeManifest({
      schema: 'oliphaunt-runtime-resources-v1',
      mode: 'native-direct',
    }),
  );
  assert.throws(
    () =>
      validatePackagedMobileRuntimeManifest({
        schema: 'oliphaunt-runtime-resources-v1',
        mode: 'native-server',
      }),
    /mode=native-direct/u,
  );
});

test('matches CocoaPods iOS link inputs exactly for all generated extension identities', () => {
  const bySqlName = new Map(
    REACT_NATIVE_METADATA.extensions.map((row) => [row['sql-name'], row['native-module-stem']]),
  );
  assert.equal(bySqlName.get('intarray'), '_int');
  assert.equal(bySqlName.get('pgtap'), null);
  assert.equal(bySqlName.get('postgis'), 'postgis-3');
  assert.equal(bySqlName.get('uuid-ossp'), 'uuid-ossp');

  const expectedStems = [...bySqlName.values()].filter((stem) => stem !== null).sort();
  assert.equal(expectedStems.length, 38);
  const evidence = iosCocoaPodsExtensionLinkEvidence({
    expectedStems,
    inputText: expectedStems
      .map(
        (stem) =>
          `\${PODS_ROOT}/../oliphaunt/frameworks/extensions/liboliphaunt_extension_${stem}.xcframework`,
      )
      .join('\r\n'),
    outputText: expectedStems
      .map(
        (stem, index) =>
          `\${PODS_XCFRAMEWORKS_BUILD_DIR}/OliphauntReactNativePayload/liboliphaunt_extension_${stem}${index === 0 ? '.framework' : '.a'}`,
      )
      .join('\n'),
  });
  const expectedArtifacts = expectedStems.map((stem) => `liboliphaunt_extension_${stem}`).sort();

  assert.deepEqual(evidence, {
    expectedArtifacts,
    inputArtifacts: expectedArtifacts,
    missingInput: [],
    missingOutput: [],
    outputArtifacts: expectedArtifacts,
    unexpectedInput: [],
    unexpectedOutput: [],
  });
});

test('does not let prefix collisions or free-text fragments satisfy iOS link identities', () => {
  const evidence = iosCocoaPodsExtensionLinkEvidence({
    expectedStems: ['postgis-3', 'uuid-ossp'],
    inputText: [
      'note: liboliphaunt_extension_postgis-3.xcframework is not a path component',
      '${PODS_ROOT}/liboliphaunt_extension_postgis-30.xcframework',
      '${PODS_ROOT}/liboliphaunt_extension_uuid-ossp-extra.xcframework',
    ].join('\n'),
    outputText: [
      '${PODS_XCFRAMEWORKS_BUILD_DIR}/liboliphaunt_extension_postgis-30.a',
      '${PODS_XCFRAMEWORKS_BUILD_DIR}/liboliphaunt_extension_uuid-ossp-extra.a',
    ].join('\n'),
  });

  assert.deepEqual(evidence.missingInput, [
    'liboliphaunt_extension_postgis-3',
    'liboliphaunt_extension_uuid-ossp',
  ]);
  assert.deepEqual(evidence.unexpectedInput, [
    'liboliphaunt_extension_postgis-30',
    'liboliphaunt_extension_uuid-ossp-extra',
  ]);
  assert.deepEqual(evidence.missingOutput, evidence.missingInput);
  assert.deepEqual(evidence.unexpectedOutput, evidence.unexpectedInput);

  const inputOnly = iosCocoaPodsExtensionLinkEvidence({
    expectedStems: ['postgis-3'],
    inputText: '${PODS_ROOT}/liboliphaunt_extension_postgis-3.xcframework',
    outputText: '',
  });
  assert.deepEqual(inputOnly.missingInput, []);
  assert.deepEqual(inputOnly.missingOutput, ['liboliphaunt_extension_postgis-3']);

  const outputOnly = iosCocoaPodsExtensionLinkEvidence({
    expectedStems: ['postgis-3'],
    inputText: '',
    outputText: '${PODS_XCFRAMEWORKS_BUILD_DIR}/liboliphaunt_extension_postgis-3.a',
  });
  assert.deepEqual(outputOnly.missingInput, ['liboliphaunt_extension_postgis-3']);
  assert.deepEqual(outputOnly.missingOutput, []);

  assert.throws(
    () =>
      iosCocoaPodsExtensionLinkEvidence({
        expectedStems: ['postgis-3'],
        inputText: '${PODS_ROOT}/liboliphaunt_extension_postgis-3.xcframework.attacker',
        outputText: '${PODS_XCFRAMEWORKS_BUILD_DIR}/liboliphaunt_extension_postgis-3.a',
      }),
    /unsupported Oliphaunt extension artifact component/u,
  );
  assert.throws(
    () =>
      iosCocoaPodsExtensionLinkEvidence({
        expectedStems: ['postgis-3'],
        inputText: [
          '${PODS_ROOT}/liboliphaunt_extension_postgis-3.xcframework',
          '${PODS_ROOT}/liboliphaunt_extension_postgis-3.xcframework',
        ].join('\n'),
        outputText: '${PODS_XCFRAMEWORKS_BUILD_DIR}/liboliphaunt_extension_postgis-3.a',
      }),
    /input file list repeats Oliphaunt extension artifact/u,
  );
  assert.throws(
    () =>
      iosCocoaPodsExtensionLinkEvidence({
        expectedStems: ['postgis-3'],
        inputText: '${PODS_ROOT}/liboliphaunt_extension_postgis-3.xcframework\0',
        outputText: '${PODS_XCFRAMEWORKS_BUILD_DIR}/liboliphaunt_extension_postgis-3.a',
      }),
    /input file list line 1 contains NUL/u,
  );
  assert.throws(
    () =>
      iosCocoaPodsExtensionLinkEvidence({
        expectedStems: ['future-name', 'future_name'],
        inputText: '',
        outputText: '',
      }),
    /collide after registration-symbol normalization/u,
  );
});

test('mobile artifact gate uses generated ownership for ancillary extension SQL', () => {
  for (const [platform, prefix] of [
    ['Android', 'assets/oliphaunt/'],
    ['iOS', 'OliphauntReactNativeResources.bundle/oliphaunt/'],
  ]) {
    const artifactNames = packagedMobileRuntimeNames(prefix, [
      'pgtap.control',
      'pgtap--1.3.5.sql',
      'pgtap-core--1.3.5.sql',
      'pgtap-schema.sql',
      'uninstall_pgtap.sql',
      'plpgsql.control',
      'plpgsql--1.0.sql',
    ]);

    assert.doesNotThrow(() =>
      validatePackagedMobileRuntimeFiles({
        artifactNames,
        metadata: REACT_NATIVE_METADATA,
        platform,
        prefix,
        registry: MOBILE_STATIC_REGISTRY,
        selected: ['pgtap'],
      }),
    );
    assert.throws(
      () =>
        validatePackagedMobileRuntimeFiles({
          artifactNames: artifactNames.filter((name) => !name.endsWith('/english.stop')),
          metadata: REACT_NATIVE_METADATA,
          platform,
          prefix,
          registry: MOBILE_STATIC_REGISTRY,
          selected: ['pgtap'],
        }),
      /missing PostgreSQL core Snowball runtime data: .*english[.]stop/u,
    );
    assert.throws(
      () =>
        validatePackagedMobileRuntimeFiles({
          artifactNames,
          metadata: REACT_NATIVE_METADATA,
          platform,
          prefix,
          registry: MOBILE_STATIC_REGISTRY,
          selected: [],
        }),
      /unselected PostgreSQL extension asset/u,
    );
  }
});

test('mobile manifests keep full, createable, and native extension domains distinct', () => {
  const rows = new Map([
    [
      'auto_explain',
      {
        'creates-extension': false,
        'native-module-stem': 'auto_explain',
        'sql-name': 'auto_explain',
      },
    ],
    [
      'future_hook',
      {
        'creates-extension': false,
        'native-module-stem': '-',
        'sql-name': 'future_hook',
      },
    ],
    [
      'pgtap',
      {
        'creates-extension': true,
        'native-module-stem': '-',
        'sql-name': 'pgtap',
      },
    ],
  ]);
  const runtime = {
    extensions: 'pgtap',
    mobileStaticRegistryRegistered: 'auto_explain',
    mobileStaticRegistryPending: '',
    mobileStaticRegistryState: 'complete',
    nativeModuleStems: 'auto_explain',
    selectedExtensions: 'auto_explain,future_hook,pgtap',
  };
  const staticRegistry = {
    modules: 'auto_explain',
    nativeModuleStems: 'auto_explain',
    pendingExtensions: '',
    registeredExtensions: 'auto_explain',
    state: 'complete',
  };

  assert.deepEqual(validateMobileExtensionManifestDomains({ runtime, staticRegistry, rows }), {
    createableExtensions: ['pgtap'],
    nativeExtensions: ['auto_explain'],
    nativeModuleStems: ['auto_explain'],
    selectedExtensions: ['auto_explain', 'future_hook', 'pgtap'],
  });
  assert.throws(
    () =>
      validateMobileExtensionManifestDomains({
        runtime: Object.fromEntries(
          Object.entries(runtime).filter(([key]) => key !== 'selectedExtensions'),
        ),
        staticRegistry,
        rows,
      }),
    /must define the full selectedExtensions domain/u,
  );
  assert.throws(
    () =>
      validateMobileExtensionManifestDomains({
        runtime: { ...runtime, extensions: 'auto_explain,pgtap' },
        staticRegistry,
        rows,
      }),
    /createable extensions/u,
  );
  assert.throws(
    () =>
      validateMobileExtensionManifestDomains({
        runtime: { ...runtime, mobileStaticRegistryRegistered: 'pgtap' },
        staticRegistry,
        rows,
      }),
    /registered native extensions/u,
  );
  assert.throws(
    () =>
      validateMobileExtensionManifestDomains({
        runtime: { ...runtime, mobileStaticRegistryState: 'not-required' },
        staticRegistry,
        rows,
      }),
    /mobileStaticRegistryState/u,
  );
  assert.throws(
    () =>
      validateMobileExtensionManifestDomains({
        runtime,
        staticRegistry: { ...staticRegistry, modules: '' },
        rows,
      }),
    /static-registry modules/u,
  );
});
