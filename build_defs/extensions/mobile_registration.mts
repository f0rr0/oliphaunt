/** Registration is derived from the actual target archive's global definitions. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  assertDefinedRegistrationAddresses,
  assertStaticMemberAliases,
  staticSymbolPrefix,
} from '../../src/extensions/artifacts/native/tools/ios-extension-registration.mts';

export { staticSymbolPrefix } from '../../src/extensions/artifacts/native/tools/ios-extension-registration.mts';

const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const portable = /^[A-Za-z0-9._-]{1,128}$/u;
export interface StaticRegistration {
  schema: 'oliphaunt-ios-extension-registration-v1';
  sqlName: string;
  nativeModuleStem: string;
  magicSymbol: string;
  initSymbol: string | null;
  symbols: { name: string; address: string }[];
}

/** LLVM and Apple nm use the same trailing address/type/name columns. */
export function globalDefinitions(text: string, apple: boolean) {
  assert(Buffer.byteLength(text) <= 64 * 1024 * 1024, 'nm output exceeds 64 MiB');
  const definitions = new Map<string, string>();
  for (const raw of text.split(/\r?\n/u)) {
    const fields = raw.trim().split(/\s+/u);
    if (fields.length < 2) continue;
    const type = fields[fields.length - 2];
    const external = fields[fields.length - 1];
    if (!/^[A-Z]$/u.test(type) || type === 'U') continue;
    const name = apple && external.startsWith('_') ? external.slice(1) : external;
    if (!identifier.test(name)) continue;
    const previous = definitions.get(name);
    // C++ template instantiations may repeat weak definitions in ordinary
    // archives. They are not SQL registrations; repeated strong symbols fail.
    assert(
      previous === undefined || (previous === type && (type === 'W' || type === 'V')),
      `static archive repeats global definition ${name}`,
    );
    definitions.set(name, type);
  }
  return definitions;
}

export function deriveStaticRegistration(
  sqlName: string,
  nativeModuleStem: string,
  text: string,
  apple: boolean,
  aliases: { name: string; address: string }[] = [],
): StaticRegistration {
  assert(portable.test(sqlName), 'SQL member name must be portable');
  const prefix = staticSymbolPrefix(nativeModuleStem);
  const definitions = globalDefinitions(text, apple);
  const magicSymbol = `${prefix}_Pg_magic_func`;
  const init = `${prefix}__PG_init`;
  assert.equal(
    definitions.get(magicSymbol),
    'T',
    'static member lacks its prefixed magic function',
  );
  assert(
    !definitions.has('Pg_magic_func') && !definitions.has('_PG_init'),
    'static member retains an unprefixed PostgreSQL hook',
  );
  if (definitions.has(init))
    assert.equal(definitions.get(init), 'T', 'static init hook must be a function');
  const symbols = [...definitions]
    .filter(([name, type]) => type === 'T' && !name.startsWith(`${prefix}_`))
    .map(([name]) => ({ name, address: name }));
  for (const alias of aliases) {
    assert(
      identifier.test(alias.name) && identifier.test(alias.address),
      'registration alias must contain C identifiers',
    );
    assert.notEqual(alias.name, alias.address, 'registration alias must change the linked address');
    assert.equal(
      definitions.get(alias.address),
      'T',
      `registration alias address ${alias.address} must be a defined function`,
    );
  }
  symbols.push(...aliases);
  symbols.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  assert.equal(
    new Set(symbols.map(({ name }) => name)).size,
    symbols.length,
    'static registration repeats a SQL symbol',
  );
  assertStaticMemberAliases(sqlName, nativeModuleStem, aliases);
  assert(
    symbols.length > 0 || definitions.has(init),
    'static member has neither SQL functions nor an init hook',
  );
  assertDefinedRegistrationAddresses(symbols, new Set(definitions.keys()), sqlName);
  return {
    schema: 'oliphaunt-ios-extension-registration-v1',
    sqlName,
    nativeModuleStem,
    magicSymbol,
    initSymbol: definitions.has(init) ? init : null,
    symbols,
  };
}

/** This unit links against oliphaunt.h; it does not duplicate the public ABI. */
export function staticRegistrySource(registrations: StaticRegistration[]) {
  assert(registrations.length > 0, 'a static registry requires actual compiled members');
  const ordered = [...registrations].sort((a, b) =>
    a.sqlName < b.sqlName ? -1 : a.sqlName > b.sqlName ? 1 : 0,
  );
  assert.equal(
    new Set(ordered.map((row) => row.nativeModuleStem)).size,
    ordered.length,
    'static registry repeats a module',
  );
  const lines = [
    '/* Generated from declared target archive definitions. */',
    '#include <stddef.h>',
    '#include "oliphaunt.h"',
    '',
  ];
  const addresses = new Set<string>();
  for (const row of ordered) {
    assert.equal(row.magicSymbol, `${staticSymbolPrefix(row.nativeModuleStem)}_Pg_magic_func`);
    assert.equal(
      row.initSymbol === null ||
        row.initSymbol === `${staticSymbolPrefix(row.nativeModuleStem)}__PG_init`,
      true,
    );
    lines.push(`extern const void *${row.magicSymbol}(void);`);
    if (row.initSymbol) lines.push(`extern void ${row.initSymbol}(void);`);
    for (const { name, address } of row.symbols) {
      assert(identifier.test(name) && identifier.test(address));
      if (!addresses.has(address)) lines.push(`extern void ${address}(void);`);
      addresses.add(address);
    }
  }
  for (const row of ordered) {
    if (row.symbols.length === 0) continue;
    const prefix = staticSymbolPrefix(row.nativeModuleStem);
    lines.push('', `static const OliphauntStaticExtensionSymbol ${prefix}_symbols[] = {`);
    for (const { name, address } of row.symbols)
      lines.push(`    { .name = "${name}", .address = (void *)${address} },`);
    lines.push('};');
  }
  lines.push('', 'static const OliphauntStaticExtension liboliphaunt_static_extensions[] = {');
  for (const row of ordered) {
    const symbols =
      row.symbols.length === 0 ? 'NULL' : `${staticSymbolPrefix(row.nativeModuleStem)}_symbols`;
    const count = row.symbols.length === 0 ? '0' : `sizeof(${symbols}) / sizeof(${symbols}[0])`;
    lines.push(
      '    {',
      '        .abi_version = OLIPHAUNT_STATIC_EXTENSION_ABI_VERSION,',
      `        .name = "${row.nativeModuleStem}",`,
      `        .magic = ${row.magicSymbol},`,
      `        .init = ${row.initSymbol ?? 'NULL'},`,
      `        .symbols = ${symbols},`,
      `        .symbol_count = ${count},`,
      '        .reserved_flags = 0,',
      '    },',
    );
  }
  lines.push(
    '};',
    '',
    'const OliphauntStaticExtension *liboliphaunt_selected_static_extensions(size_t *count) {',
    '    if (count != NULL) {',
    '        *count = sizeof(liboliphaunt_static_extensions) / sizeof(liboliphaunt_static_extensions[0]);',
    '    }',
    '    return liboliphaunt_static_extensions;',
    '}',
    '',
  );
  return lines.join('\n');
}

if (import.meta.main) {
  assert.equal(process.argv.length, 3, 'usage: mobile_registration.mts <declared-inputs.json>');
  const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  if (spec.registrations) {
    writeFileSync(
      spec.source,
      staticRegistrySource(
        spec.registrations.map((file: string) => JSON.parse(readFileSync(file, 'utf8'))),
      ),
    );
    process.exit(0);
  }
  if (spec.nm) {
    const result = Bun.spawnSync(
      [spec.nm, ...(spec.apple ? ['-g', '-U'] : ['-g', '--defined-only']), spec.archive],
      { env: { LC_ALL: 'C', LANG: 'C' }, stdout: 'pipe', stderr: 'pipe' },
    );
    assert.equal(result.exitCode, 0, `declared nm failed: ${result.stderr.toString('utf8')}`);
    writeFileSync(spec.symbols, result.stdout);
  }
  const registration = deriveStaticRegistration(
    spec.sqlName,
    spec.stem,
    readFileSync(spec.symbols, 'utf8'),
    spec.apple,
    spec.aliases,
  );
  writeFileSync(spec.registration, `${JSON.stringify(registration, null, 2)}\n`);
  writeFileSync(spec.source, staticRegistrySource([registration]));
}
