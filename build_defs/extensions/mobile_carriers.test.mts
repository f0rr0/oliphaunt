import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { validateNativeComponentContract } from '../../src/extensions/tools/native-component-contract.mts';
import { type MobileCarrierSpec, mobileArchivePlan } from './mobile_carriers.mts';

// These synthetic inputs test contract boundaries; they are not construction evidence.
const source = { name: 'fixture', commit: '1'.repeat(40) };
const dependencySource = { name: 'dependency', commit: '2'.repeat(40) };
const profiles = [
  { target: 'ios-xcframework', family: 'native', kind: 'native-static-registry' },
  { target: 'android-arm64-v8a', family: 'native', kind: 'native-static-registry' },
  { target: 'android-x86_64', family: 'native', kind: 'native-static-registry' },
];
const graph = (local = false) =>
  validateNativeComponentContract(
    {
      schema: 'oliphaunt-native-components-v1',
      components: [
        {
          id: 'dependency',
          ...(local ? { 'source-path': 'src/fixture' } : { source: 'dependency' }),
          'depends-on': [],
          'runtime-files': [],
          'link-units': [
            { id: 'dependency-c', 'archive-candidates': ['dependency/lib/libdependency_c.a'] },
            { id: 'dependency', 'archive-candidates': ['dependency/lib/libdependency.a'] },
          ],
        },
      ],
      requirements: [
        {
          extension: 'fixture',
          family: 'native',
          kind: 'native-static-registry',
          targets: profiles.map((row) => row.target),
          roots: ['dependency'],
        },
      ],
    },
    {
      checkSourcePaths: false,
      knownExtensions: new Set(['fixture', 'sql_only']),
      targetProfiles: new Map(profiles.map((row) => [row.target, `${row.family}\0${row.kind}`])),
    },
  );

function specification(target = 'android-arm64-v8a'): MobileCarrierSpec {
  const cohorts =
    target === 'ios-xcframework' ? ['macos-arm64', 'ios-device', 'ios-simulator'] : [target];
  return {
    product: 'fixture-product',
    version: '1.0.0',
    sqlName: 'fixture',
    target,
    runtimeVersion: '0.3.3',
    descriptor: { 'native-module-file': 'fixture.so' },
    recipe: {},
    source,
    selectedDependencies: [],
    compatibility: {},
    carriers: [],
    hostArchive: '/declared/host.tar.gz',
    components: '/declared/components.toml',
    catalogSqlNames: ['fixture', 'sql_only'],
    allProfiles: profiles,
    dependencySources: { dependency: dependencySource },
    staticArchives: cohorts.map((cohort) => ({
      target: cohort,
      archive: `/declared/${cohort}/fixture.a`,
      registration: `/declared/${cohort}/registration.json`,
      nm: { path: '/declared/nm', apple: target === 'ios-xcframework' },
      sqlName: 'fixture',
      owner: 'fixture-product',
      version: '1.0.0',
      runtimeVersion: '0.3.3',
      source,
    })),
    dependencyArchives: cohorts.flatMap((cohort) =>
      ['dependency', 'dependency-c'].map((identity) => ({
        target: cohort,
        identity,
        archive: `/declared/${cohort}/${identity}.a`,
        source: dependencySource,
      })),
    ),
  };
}

test('Android paths use each canonical component archive basename and actual target', () => {
  for (const target of ['android-arm64-v8a', 'android-x86_64']) {
    const plan = mobileArchivePlan(specification(target), graph());
    assert.equal(plan.stem, 'fixture');
    assert.equal(plan.mobileContract.symbolPrefix, 'oliphaunt_static_fixture');
    assert.deepEqual(plan.mobileContract.archives, [
      `${target}:mobile-static/${target}/extensions/fixture/liboliphaunt_extension_fixture.a`,
    ]);
    assert.deepEqual(plan.mobileContract.dependencies, [
      `${target}:dependency-c:mobile-static/${target}/dependencies/dependency-c/libdependency_c.a`,
      `${target}:dependency:mobile-static/${target}/dependencies/dependency/libdependency.a`,
    ]);
    assert.equal(plan.files.length, 3);
  }
});

test('iOS requires real three-slice inputs and stages only device and simulator archives', () => {
  const spec = specification('ios-xcframework');
  const plan = mobileArchivePlan(spec, graph());
  assert.equal(plan.files.length, 6);
  assert(plan.files.every((row) => !row.destination.includes('macos-arm64')));
  assert.deepEqual(plan.mobileContract.archives, [
    'ios-device:mobile-static/ios-device/extensions/fixture/liboliphaunt_extension_fixture.a',
    'ios-simulator:mobile-static/ios-simulator/extensions/fixture/liboliphaunt_extension_fixture.a',
  ]);
  assert.throws(
    () => mobileArchivePlan({ ...spec, staticArchives: spec.staticArchives.slice(1) }, graph()),
    /exact target cohorts/u,
  );
  assert.throws(
    () =>
      mobileArchivePlan({ ...spec, dependencyArchives: spec.dependencyArchives.slice(2) }, graph()),
    /component closure/u,
  );
});

test('producer owner, runtime and immutable source must match canonical member metadata', () => {
  const spec = specification();
  for (const changed of [
    { owner: 'foreign-owner' },
    { runtimeVersion: '0.3.2' },
    { source: { ...source, commit: '3'.repeat(40) } },
  ]) {
    assert.throws(
      () =>
        mobileArchivePlan(
          { ...spec, staticArchives: [{ ...spec.staticArchives[0], ...changed }] },
          graph(),
        ),
      /differs from canonical member/u,
    );
  }
  assert.throws(
    () =>
      mobileArchivePlan(
        { ...spec, dependencyArchives: spec.dependencyArchives.map((row) => ({ ...row, source })) },
        graph(),
      ),
    /canonical acquisition/u,
  );
  assert.throws(
    () => mobileArchivePlan({ ...spec, dependencySources: {} }, graph()),
    /canonical source identity/u,
  );
});

test('missing, duplicate, foreign and incorrectly named target archives fail closed', () => {
  const spec = specification();
  assert.throws(
    () => mobileArchivePlan({ ...spec, target: 'linux-x64-gnu' }, graph()),
    /canonical static target/u,
  );
  assert.throws(
    () => mobileArchivePlan({ ...spec, staticArchives: [] }, graph()),
    /exact target cohorts/u,
  );
  assert.throws(
    () =>
      mobileArchivePlan(
        { ...spec, staticArchives: [...spec.staticArchives, ...spec.staticArchives] },
        graph(),
      ),
    /exact target cohorts/u,
  );
  assert.throws(
    () =>
      mobileArchivePlan(
        { ...spec, dependencyArchives: [...spec.dependencyArchives, spec.dependencyArchives[0]] },
        graph(),
      ),
    /component closure/u,
  );
  assert.throws(
    () =>
      mobileArchivePlan(
        {
          ...spec,
          staticArchives: [
            { ...spec.staticArchives[0], nm: { path: '/declared/nm', apple: true } },
          ],
        },
        graph(),
      ),
    /nm convention/u,
  );
  assert.throws(
    () =>
      mobileArchivePlan(
        { ...spec, descriptor: { 'native-module-file': 'fixture.dylib' } },
        graph(),
      ),
    /canonical mobile module/u,
  );
  assert.throws(
    () =>
      mobileArchivePlan(
        { ...spec, descriptor: { 'native-module-file': '../fixture.so' } },
        graph(),
      ),
    /module stem/u,
  );
});

test('local component source identity comes from its declared source path', () => {
  const spec = specification();
  const actual = {
    ...spec,
    dependencyArchives: spec.dependencyArchives.map((row) => ({
      ...row,
      source: { path: 'src/fixture' },
    })),
  };
  assert.equal(mobileArchivePlan(actual, graph(true)).files.length, 3);
  assert.throws(() => mobileArchivePlan(spec, graph(true)), /canonical acquisition/u);
});

test('SQL-only members carry no static or registration roles', () => {
  const spec = {
    ...specification('ios-xcframework'),
    sqlName: 'sql_only',
    descriptor: {},
    staticArchives: [],
    dependencyArchives: [],
  };
  const plan = mobileArchivePlan(spec, graph());
  assert.equal(plan.stem, null);
  assert.equal(plan.mobileContract.symbolPrefix, '');
  assert.deepEqual(plan.files, []);
  assert.throws(
    () =>
      mobileArchivePlan(
        { ...spec, staticArchives: specification('ios-xcframework').staticArchives },
        graph(),
      ),
    /exact target cohorts/u,
  );
});
