import { describe, expect, test } from 'bun:test';
import { staticMemberAliases } from '../../src/extensions/artifacts/native/tools/ios-extension-registration.mts';
import {
  deriveStaticRegistration,
  globalDefinitions,
  staticRegistrySource,
} from './mobile_registration.mts';

const llvm = `member.o:\n0000000000000000 T oliphaunt_static_cube_Pg_magic_func\n0000000000000040 T cube_in\n0000000000000080 T pg_finfo_cube_in\n                 U palloc\n0000000000000020 t internal\n0000000000000100 D cube_data\n`;
const apple = `member.o:\n0000000000000000 (__TEXT,__text) external _oliphaunt_static_cube_Pg_magic_func\n0000000000000040 (__TEXT,__text) external _cube_in\n0000000000000080 (__TEXT,__text) external _pg_finfo_cube_in\n0000000000000100 (__DATA,__data) external _cube_data\n`;
describe('actual mobile archive registration', () => {
  test('uses global functions and preserves the ELF underscore spelling', () => {
    const row = deriveStaticRegistration('cube', 'cube', llvm, false);
    expect(row.initSymbol).toBeNull();
    expect(row.symbols).toEqual([
      { name: 'cube_in', address: 'cube_in' },
      { name: 'pg_finfo_cube_in', address: 'pg_finfo_cube_in' },
    ]);
    expect(globalDefinitions('00000000 T _call\n', false).has('_call')).toBe(true);
  });
  test('Apple removes exactly its external-symbol underscore', () => {
    expect(deriveStaticRegistration('cube', 'cube', apple, true)).toEqual(
      deriveStaticRegistration('cube', 'cube', llvm, false),
    );
    expect(globalDefinitions('00000000 (__TEXT,__text) external __call\n', true).has('_call')).toBe(
      true,
    );
  });
  test('coalesces repeated weak archive definitions without registering them', () => {
    const text = `${llvm}0 W template_instantiation\n0 W template_instantiation\n0 V weak_data\n0 V weak_data\n`;
    expect(deriveStaticRegistration('cube', 'cube', text, false)).toEqual(
      deriveStaticRegistration('cube', 'cube', llvm, false),
    );
    expect(() => globalDefinitions('0 W collision\n1 T collision\n', false)).toThrow(
      'repeats global',
    );
  });
  test('Darwin output preserves weak private bindings and rejects strong or mixed collisions', () => {
    // Captured from real Clang 21 Mach-O arm64 objects with nm -g -U -m.
    const weak = `000000000000002c (__TEXT,__text) weak private external __ZNSt12length_errorC1B9nqe210106EPKc\n0000000000000088 (__DATA,__data) weak external _weak_data\n0000000000000060 (__TEXT,__text) weak external _weak_function\n`;
    expect(deriveStaticRegistration('cube', 'cube', apple + weak + weak, true)).toEqual(
      deriveStaticRegistration('cube', 'cube', apple, true),
    );
    expect(globalDefinitions(weak, true).get('_ZNSt12length_errorC1B9nqe210106EPKc')).toBe('W');
    expect(
      globalDefinitions('0 (__TEXT,__text) non-external (was a private external) _local\n', true)
        .size,
    ).toBe(0);
    for (const bindings of [
      ['external', 'external'],
      ['weak external', 'external'],
      ['external', 'weak external'],
    ])
      expect(() =>
        globalDefinitions(
          bindings
            .map((binding, index) => `${index} (__TEXT,__text) ${binding} _collision\n`)
            .join(''),
          true,
        ),
      ).toThrow('repeats global');
    for (const name of ['weak', 'external'])
      expect(() =>
        globalDefinitions(
          `0 (__TEXT,__text) external ${name}\n1 (__TEXT,__text) external ${name}\n`,
          true,
        ),
      ).toThrow('repeats global');
    expect(() =>
      deriveStaticRegistration(
        'cube',
        'cube',
        apple.replace(
          'external _oliphaunt_static_cube_Pg_magic_func',
          'weak external _oliphaunt_static_cube_Pg_magic_func',
        ),
        true,
      ),
    ).toThrow('magic');
    expect(() =>
      deriveStaticRegistration(
        'cube',
        'cube',
        `${apple}0 (__TEXT,__text) external _Pg_magic_func\n`,
        true,
      ),
    ).toThrow('unprefixed');
  });
  test('an init-only member has a null function table', () => {
    const row = deriveStaticRegistration(
      'auto_explain',
      'auto_explain',
      '0 T oliphaunt_static_auto_explain_Pg_magic_func\n1 T oliphaunt_static_auto_explain__PG_init\n',
      false,
    );
    expect(row.symbols).toEqual([]);
    expect(staticRegistrySource([row])).toContain('.symbols = NULL,\n        .symbol_count = 0,');
  });
  test('PostGIS aliases point to actual prefixed definitions', () => {
    const aliases = [
      { name: 'difference', address: 'oliphaunt_static_postgis_3_difference' },
      { name: 'pg_finfo_difference', address: 'pg_finfo_oliphaunt_static_postgis_3_difference' },
    ];
    const text =
      '0 T oliphaunt_static_postgis_3_Pg_magic_func\n1 T oliphaunt_static_postgis_3_difference\n2 T pg_finfo_oliphaunt_static_postgis_3_difference\n';
    const row = deriveStaticRegistration('postgis', 'postgis-3', text, false, aliases);
    expect(row.symbols).toContainEqual(aliases[0]);
    expect(row.symbols).toContainEqual(aliases[1]);
    expect(() =>
      deriveStaticRegistration('postgis', 'postgis-3', text.replace('1 T', '1 D'), false, aliases),
    ).toThrow('defined function');
    expect(staticMemberAliases('postgis', 'postgis-3')).toEqual(aliases);
    for (const apple of [false, true]) {
      const symbols = apple ? text.replaceAll(' T ', ' (__TEXT,__text) external _') : text;
      expect(deriveStaticRegistration('postgis', 'postgis-3', symbols, apple, aliases)).toEqual(
        row,
      );
      for (const incorrect of [
        [],
        aliases.slice(0, 1),
        [...aliases, { name: 'extra', address: aliases[0].address }],
      ])
        expect(() =>
          deriveStaticRegistration('postgis', 'postgis-3', symbols, apple, incorrect),
        ).toThrow('canonical namespace');
      const wrong = aliases.map((alias) => ({ ...alias, address: `${alias.address}_wrong` }));
      const wrongSymbols = `${symbols}${wrong.map(({ address }) => `3 ${apple ? '(__TEXT,__text) external _' : 'T '}${address}\n`).join('')}`;
      expect(() =>
        deriveStaticRegistration('postgis', 'postgis-3', wrongSymbols, apple, wrong),
      ).toThrow('canonical namespace');
    }
    expect(staticMemberAliases('cube', 'cube')).toEqual([]);
    expect(staticMemberAliases('pgtap', null)).toEqual([]);
  });
  test('rejects incomplete, duplicate and unprefixed hooks', () => {
    expect(() =>
      deriveStaticRegistration(
        'cube',
        'cube',
        llvm.replace(
          'T oliphaunt_static_cube_Pg_magic_func',
          'U oliphaunt_static_cube_Pg_magic_func',
        ),
        false,
      ),
    ).toThrow('magic');
    expect(() =>
      deriveStaticRegistration('cube', 'cube', `${llvm}0 T Pg_magic_func\n`, false),
    ).toThrow('unprefixed');
    expect(() => deriveStaticRegistration('cube', 'cube', `${llvm}0 T cube_in\n`, false)).toThrow(
      'repeats global',
    );
    expect(() =>
      deriveStaticRegistration('cube', 'cube', llvm, false, [
        { name: 'cube_in', address: 'pg_finfo_cube_in' },
      ]),
    ).toThrow('repeats a SQL symbol');
  });
  test('generated source uses the public ABI with the actual magic and addresses', () => {
    const row = deriveStaticRegistration('cube', 'cube', llvm, false);
    const source = staticRegistrySource([row]);
    expect(source).toContain('#include "oliphaunt.h"');
    expect(source).toContain('.magic = oliphaunt_static_cube_Pg_magic_func,');
    expect(source).toContain('{ .name = "cube_in", .address = (void *)cube_in },');
    expect(source).toContain('OLIPHAUNT_STATIC_EXTENSION_ABI_VERSION');
    expect(() => staticRegistrySource([row, row])).toThrow('repeats a module');
  });
});
