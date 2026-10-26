/** Validate every requested desktop member; this proves construction, not SQL execution. */
import { readFileSync } from 'node:fs';
import { inspect } from './validate_member_payload.mts';

type ConstructionLicenseFile = { declared: boolean; mode: number; data: Buffer };

/** Shared license resources retain each member's exact declared bytes and mode. */
export function assertSharedDesktopLicense(
  name: string,
  original: ConstructionLicenseFile,
  incoming: ConstructionLicenseFile,
): void {
  if (
    !name.startsWith('share/licenses/') ||
    !original.declared ||
    !incoming.declared ||
    original.mode !== incoming.mode ||
    !original.data.equals(incoming.data)
  ) {
    throw new Error('candidate members overlap outside identical declared construction licenses');
  }
}

/** Read only current control declarations and their exact default install SQL. */
export function desktopMemberModuleRoots(
  entries: ReadonlyMap<string, { data(): Buffer }>,
  primaryModuleFile: string,
): string[] {
  const suffix = primaryModuleFile.slice(primaryModuleFile.lastIndexOf('.'));
  const roots = new Set<string>();
  const add = (library: string) => {
    if (!/^\$libdir\/[A-Za-z_][A-Za-z0-9_.-]*$/u.test(library))
      throw new Error(
        `candidate control or install SQL declares an unsupported module: ${library}`,
      );
    const stem = library.slice('$libdir/'.length);
    const filename = stem.endsWith(suffix) ? stem : stem + suffix;
    if (!entries.has(`lib/postgresql/${filename}`))
      throw new Error(`control or install SQL must name a candidate PG module: ${filename}`);
    roots.add(filename);
  };
  for (const [name, entry] of entries) {
    const sqlName = /^share\/postgresql\/extension\/([^/]+)[.]control$/u.exec(name)?.[1];
    if (sqlName === undefined) continue;
    const control = entry.data().toString('utf8');
    const module = /^\s*module_pathname\s*=\s*'([^']+)'/mu.exec(control)?.[1];
    if (module !== undefined) add(module);
    const version = /^\s*default_version\s*=\s*'([^']+)'/mu.exec(control)?.[1];
    const sql =
      version === undefined
        ? undefined
        : entries.get(`share/postgresql/extension/${sqlName}--${version}.sql`);
    if (sql === undefined) continue;
    for (const match of sql
      .data()
      .toString('utf8')
      .matchAll(/\bAS\s+'([^']+)'\s*,\s*'([^']+)'/giu)) {
      const library = match[1].toUpperCase() === 'MODULE_PATHNAME' ? module : match[1];
      if (library === undefined)
        throw new Error(`${name} has MODULE_PATHNAME SQL without a control module_pathname`);
      add(library);
    }
  }
  return [...roots].sort();
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('desktop construction inventory must contain objects');
  }
  return value as Record<string, unknown>;
}

export function validateDesktopConstruction(inventory: unknown, archives: readonly string[]) {
  const plan = record(inventory);
  const configuration = plan.configuration;
  const includePostgis = plan.include_postgis ?? false;
  if (
    plan.schema !== 'oliphaunt-desktop-extension-construction-v1' ||
    !['linux-x64-gnu', 'linux-arm64-gnu', 'macos-arm64', 'windows-x64-msvc'].includes(
      configuration as string,
    ) ||
    !Array.isArray(plan.excluded) ||
    typeof includePostgis !== 'boolean' ||
    (includePostgis
      ? plan.excluded.length !== 0
      : plan.excluded.length !== 1 || plan.excluded[0] !== 'postgis') ||
    !Array.isArray(plan.members) ||
    plan.members.length === 0
  ) {
    throw new Error('desktop construction inventory has an unsupported profile or membership');
  }
  if (archives.length !== plan.members.length) {
    throw new Error('desktop construction requires one actual archive for every requested member');
  }
  const selected = new Set<string>();
  let compiled = 0;
  for (const [index, value] of plan.members.entries()) {
    const member = record(value);
    const name = member.sql_name;
    if (
      typeof name !== 'string' ||
      !/^[a-z][a-z0-9_-]*$/u.test(name) ||
      (name === 'postgis' && !includePostgis) ||
      selected.has(name) ||
      typeof member.owner !== 'string' ||
      !member.owner ||
      typeof member.label !== 'string' ||
      !member.label.startsWith('//src/extensions/') ||
      typeof member.version !== 'string' ||
      typeof member.source_kind !== 'string' ||
      typeof member.creates_extension !== 'boolean' ||
      (member.default_version !== null && typeof member.default_version !== 'string') ||
      typeof member.module_file !== 'string'
    ) {
      throw new Error('desktop construction inventory has a repeated or invalid member');
    }
    selected.add(name);
    const descriptor = inspect(archives[index], name, member.owner);
    for (const key of [
      'version',
      'source_kind',
      'default_version',
      'creates_extension',
      'module_file',
    ]) {
      // Starlark serializes an absent contrib default version as JSON null.
      if ((descriptor[key] ?? null) !== (member[key] ?? null)) {
        throw new Error(`${name} archive disagrees with canonical ${key}`);
      }
    }
    if (descriptor.configuration !== configuration) {
      throw new Error(`${name} archive differs from the requested construction configuration`);
    }
    if (member.module_file) compiled += 1;
  }
  if (selected.has('postgis') !== includePostgis)
    throw new Error('desktop construction differs from explicit PostGIS selection');
  return { configuration, members: [...selected], compiled, sqlOnly: selected.size - compiled };
}

if (import.meta.main) {
  try {
    const [inventory, ...archives] = process.argv.slice(2);
    if (!inventory)
      throw new Error('usage: construction.mts <inventory.json> <member-archives...>');
    const plan = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(inventory)),
    );
    console.log(JSON.stringify(validateDesktopConstruction(plan, archives)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
