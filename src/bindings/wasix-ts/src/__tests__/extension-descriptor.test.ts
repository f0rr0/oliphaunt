import { describe, expect, it } from 'vitest';

import {
  defineWasixExtension,
  serializeWasixExtensionDescriptors,
} from '../extension-descriptor.js';
import type {
  WasixExtensionCarrier,
  WasixExtensionDescriptor,
  WasixExtensionDescriptorInput,
  WasixExtensionInstall,
} from '../types.js';

describe('WASIX extension descriptors', () => {
  it('selects only roots while registering their dependency-complete carrier closures', () => {
    const cube = carrier('cube');
    const earthdistance = carrier('earthdistance', {
      install: install('earthdistance', ['cube']),
    });
    const descriptor = extension('earthdistance', [earthdistance, cube]);

    const serialized = serializeWasixExtensionDescriptors([descriptor]);

    expect(serialized.selectedSqlNames).toEqual(['earthdistance']);
    expect(Object.keys(serialized.carriers)).toEqual(['cube', 'earthdistance']);
    expect(serialized.carriers.cube).toMatchObject({
      archive: 'extensions/cube.tar.zst',
      sha256: '2'.repeat(64),
      size: 100,
    });
  });

  it('deduplicates immutable carrier identities shared by imported roots', () => {
    const sharedFromFirst = carrier('shared', {
      source: '/first/shared.tar.zst',
    });
    const sharedFromSecond = carrier('shared', {
      source: '/second/shared.tar.zst',
    });
    const first = extension('first', [
      carrier('first', { install: install('first', ['shared']) }),
      sharedFromFirst,
    ]);
    const second = extension('second', [
      carrier('second', { install: install('second', ['shared']) }),
      sharedFromSecond,
    ]);

    const serialized = serializeWasixExtensionDescriptors([first, second]);

    expect(serialized.selectedSqlNames).toEqual(['first', 'second']);
    expect(Object.keys(serialized.carriers)).toEqual(['first', 'second', 'shared']);
    expect(serialized.carriers.shared?.source).toBe('/first/shared.tar.zst');
  });

  it('rejects duplicate roots and conflicting carrier identities', () => {
    const first = extension('first');
    expect(() => serializeWasixExtensionDescriptors([first, first])).toThrow(
      "repeat root SQL name 'first'",
    );

    const conflictingShared = carrier('shared', { sha256: '3'.repeat(64) });
    expect(() =>
      serializeWasixExtensionDescriptors([
        extension('first', [
          carrier('first', { install: install('first', ['shared']) }),
          carrier('shared'),
        ]),
        extension('second', [
          carrier('second', { install: install('second', ['shared']) }),
          conflictingShared,
        ]),
      ]),
    ).toThrow("carrier 'shared' has conflicting");
  });

  it('rejects malformed or non-WASIX descriptors at the runtime boundary', () => {
    expect(() =>
      serializeWasixExtensionDescriptors([
        {
          ...descriptorInput('pgtap'),
          runtime: 'native',
        } as unknown as WasixExtensionDescriptor,
      ]),
    ).toThrow("must target runtime 'wasix'");

    expect(() =>
      serializeWasixExtensionDescriptors([
        {
          ...descriptorInput('pgtap'),
          surprise: true,
        } as unknown as WasixExtensionDescriptor,
      ]),
    ).toThrow('fields must be exactly');

    expect(() =>
      defineWasixExtension({
        ...descriptorInput('pgtap'),
        carriers: [carrier('other')],
      }),
    ).toThrow("do not contain root SQL name 'pgtap'");

    expect(() =>
      defineWasixExtension({
        ...descriptorInput('pgtap'),
        carriers: [carrier('pgtap'), carrier('pgtap')],
      }),
    ).toThrow("repeats carrier SQL name 'pgtap'");

    expect(() =>
      defineWasixExtension({
        ...descriptorInput('pgtap'),
        carriers: [
          carrier('pgtap', {
            size: 101,
            source: Uint8Array.from({ length: 100 }),
          }),
        ],
      }),
    ).toThrow('byte length must match declared carrier size 101');

    expect(() =>
      defineWasixExtension({
        ...descriptorInput('pgtap'),
        carriers: [carrier('pgtap', { archive: 'extensions/renamed.tar.zst' })],
      }),
    ).toThrow('archive must be extensions/pgtap.tar.zst');

    expect(() =>
      defineWasixExtension({
        ...descriptorInput('pgtap'),
        compatibility: { ...compatibility(), postgresMajor: 'not-a-major' },
      }),
    ).toThrow('PostgreSQL major must be a positive integer string');

    expect(() =>
      defineWasixExtension({
        ...descriptorInput('pgtap'),
        carriers: [carrier('pgtap'), carrier('unused')],
      }),
    ).toThrow("exact dependency closure for 'pgtap'; unexpected unused");

    const missingCreateSchema = install('pgtap') as unknown as {
      lifecycle: Record<string, unknown>;
    };
    delete missingCreateSchema.lifecycle.createSchema;
    expect(() =>
      defineWasixExtension({
        ...descriptorInput('pgtap'),
        carriers: [
          carrier('pgtap', {
            install: missingCreateSchema as unknown as WasixExtensionInstall,
          }),
        ],
      }),
    ).toThrow('lifecycle fields must be exactly');

    const duplicateStartupConfig = install('pgtap');
    duplicateStartupConfig.lifecycle.startupConfig = ['work_mem=4MB', 'work_mem=4MB'];
    expect(() =>
      defineWasixExtension({
        ...descriptorInput('pgtap'),
        carriers: [carrier('pgtap', { install: duplicateStartupConfig })],
      }),
    ).toThrow('startupConfig must not repeat values');

    const missingLoadOrderFile = {
      ...install('pgtap'),
      loadOrder: ['lib/postgresql/pgtap.so'],
    };
    expect(() =>
      defineWasixExtension({
        ...descriptorInput('pgtap'),
        carriers: [carrier('pgtap', { install: missingLoadOrderFile })],
      }),
    ).toThrow('load-order path is absent from installedFiles');
  });

  it('freezes package-authored descriptors and their carrier rows', () => {
    const descriptor = extension('pgtap');
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.carriers)).toBe(true);
    expect(Object.isFrozen(descriptor.carriers[0])).toBe(true);
    expect(Object.isFrozen(descriptor.compatibility)).toBe(true);
    expect(Object.isFrozen(descriptor.carriers[0]?.install)).toBe(true);
    expect(Object.isFrozen(descriptor.carriers[0]?.install.lifecycle.loadSql)).toBe(true);
  });
});

type CarrierOverrides = Partial<Omit<WasixExtensionCarrier, 'install'>> & {
  install?: WasixExtensionInstall;
};

function carrier(sqlName: string, overrides: CarrierOverrides = {}): WasixExtensionCarrier {
  const { install: installOverride, ...fields } = overrides;
  return {
    product: `oliphaunt-extension-${sqlName.replaceAll('_', '-')}`,
    version: '0.1.1',
    sqlName,
    archive: `extensions/${sqlName}.tar.zst`,
    sha256: '2'.repeat(64),
    size: 100,
    source: '/extensions/carrier.tar.zst',
    ...fields,
    install: installOverride ?? install(sqlName),
  };
}

function install(sqlName: string, dependencies: readonly string[] = []): WasixExtensionInstall {
  return {
    schema: 'oliphaunt-wasix-extension-install-v1',
    name: sqlName,
    nativeModule: null,
    nativeModules: [],
    dependencies,
    coreExportsRequired: [],
    loadOrder: [],
    lifecycle: {
      createExtension: true,
      createSchema: 'pg_catalog',
      loadSql: [],
      postCreateSql: [],
      startupConfig: [],
      preloadRequired: false,
      restartRequired: false,
      sharedMemoryRequired: false,
    },
    installedFiles: [`share/postgresql/extension/${sqlName}.control`],
    unresolvedImports: [],
  };
}

function compatibility(): WasixExtensionDescriptorInput['compatibility'] {
  return {
    extensionRuntimeContract: 'oliphaunt-extension-runtime-contract-v1',
    postgresMajor: '18',
    wasixRuntimeProduct: 'liboliphaunt-wasix',
    wasixRuntimeVersion: '0.1.1',
  };
}

function descriptorInput(
  sqlName: string,
  carriers: readonly WasixExtensionCarrier[] = [carrier(sqlName)],
): WasixExtensionDescriptorInput {
  const root = carriers.find((candidate) => candidate.sqlName === sqlName) ?? carrier(sqlName);
  return {
    schema: 'oliphaunt-wasix-extension-v1',
    runtime: 'wasix',
    product: root.product,
    version: root.version,
    compatibility: compatibility(),
    sqlName,
    carriers,
  };
}

function extension(
  sqlName: string,
  carriers: readonly WasixExtensionCarrier[] = [carrier(sqlName)],
): WasixExtensionDescriptor {
  return defineWasixExtension(descriptorInput(sqlName, carriers));
}
