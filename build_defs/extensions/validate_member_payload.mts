/** Inspect actual internal member archives independently of their writer. */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  DEFAULT_PORTABLE_ARCHIVE_LIMITS,
  readPortableArchiveEntries,
  strictGunzip,
} from '../../tools/packaging/portable-archive.mts';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('member descriptor must be an object');
  }
  return value as Record<string, unknown>;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error('member descriptor must declare resource arrays');
  }
  return value;
}

function fullMatch(pattern: RegExp, value: unknown): value is string {
  return typeof value === 'string' && pattern.exec(value)?.[0] === value;
}

// The portable reader permits and omits tar's conventional root directory
// marker and normalizes './' prefixes. Internal members permit neither.
// Check physical header spelling too, after the independent reader bounds and
// validates their sizes/checksums/paths/compression before exposing any bytes.
function requireRegularHeaders(archive: string, entryPaths: ReadonlySet<string>): void {
  const tar = strictGunzip(
    readFileSync(archive),
    archive,
    DEFAULT_PORTABLE_ARCHIVE_LIMITS.maxExpandedBytes,
  );
  for (let offset = 0; offset < tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    if (header[156] !== 0 && header[156] !== 0x30) {
      throw new Error('member archive must contain safe regular files only');
    }
    const name = header.subarray(0, 100).toString('utf8').split('\0')[0];
    const prefix = header.subarray(345, 500).toString('utf8').split('\0')[0];
    const physicalPath = prefix ? `${prefix}/${name}` : name;
    if (
      physicalPath.startsWith('/') ||
      physicalPath.includes('\\') ||
      physicalPath.split('/').some((part) => !part || part === '.' || part === '..') ||
      !entryPaths.has(physicalPath)
    ) {
      throw new Error('member archive must contain safe regular files only');
    }
    const size = Number.parseInt(
      header.subarray(124, 136).toString('ascii').replace(/[\0 ]/g, ''),
      8,
    );
    offset += 512 + Math.ceil(size / 512) * 512;
  }
}

export function inspect(
  archivePath: string,
  expectedName?: string,
  expectedOwner?: string,
): Record<string, unknown> {
  // Bazel runfiles are projected links; inspect the resolved regular artifact.
  const archive = realpathSync(archivePath);
  const entries = readPortableArchiveEntries(archive, { format: 'tar.gz' });
  requireRegularHeaders(archive, new Set(entries.keys()));
  const files = new Map<string, Buffer>();
  for (const [name, entry] of entries) {
    if (
      !entry.isFile ||
      name.startsWith('/') ||
      name.includes('\\') ||
      name.split('/').some((part) => !part || part === '.' || part === '..')
    ) {
      throw new Error('member archive must contain safe regular files only');
    }
    files.set(name, entry.data());
  }
  const descriptorBytes = files.get('extension.json');
  if (!descriptorBytes) throw new Error('member archive has no descriptor');
  files.delete('extension.json');
  const descriptor = record(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(descriptorBytes)),
  );
  if (descriptor.schema !== 'oliphaunt-extension-member-payload-v1') {
    throw new Error('unknown member payload schema');
  }
  const architecture =
    descriptor.configuration === 'linux-x64-gnu'
      ? { machine: 62, name: 'x86_64' }
      : descriptor.configuration === 'linux-arm64-gnu'
        ? { machine: 183, name: 'aarch64' }
        : undefined;
  if (!architecture || descriptor.family !== 'native') {
    throw new Error('member payload configuration is unsupported by this native slice');
  }
  const name = descriptor.sql_name;
  if (!fullMatch(/^[a-z][a-z0-9_-]*$/u, name)) throw new Error('invalid member SQL identity');
  if (expectedName !== undefined && name !== expectedName) {
    throw new Error('member SQL identity disagrees with the requested extension');
  }
  if (expectedOwner !== undefined && descriptor.owner !== expectedOwner) {
    throw new Error('member carrier owner disagrees with canonical ownership');
  }
  if (!Array.isArray(descriptor.files)) throw new Error('member descriptor inventory is missing');
  const recorded = descriptor.files.map(record);
  const recordedPaths = recorded.map((item) => item.path);
  if (
    new Set(recordedPaths).size !== recordedPaths.length ||
    recordedPaths.length !== files.size ||
    recordedPaths.some((item) => typeof item !== 'string' || !files.has(item))
  ) {
    throw new Error('member descriptor inventory disagrees with the actual archive');
  }
  for (const item of recorded) {
    const data = files.get(item.path as string);
    if (!data || item.sha256 !== createHash('sha256').update(data).digest('hex')) {
      throw new Error('member payload checksum mismatch');
    }
  }
  const sqlPrefix = 'share/postgresql/extension/';
  const profiles = strings(descriptor.module_profiles);
  if (
    profiles.length !== 0 &&
    (profiles.length !== 2 || profiles[0] !== 'postgresql' || profiles[1] !== 'modules')
  ) {
    throw new Error('member archive has an unsupported ABI profile declaration');
  }
  const moduleFile = descriptor.module_file ?? '';
  if (profiles.length && !fullMatch(/^[a-z_][a-z0-9_-]*\.so$/u, moduleFile)) {
    throw new Error('compiled member has an invalid module file declaration');
  }
  if (Boolean(moduleFile) !== Boolean(profiles.length)) {
    throw new Error('compiled member must declare both ABI profiles');
  }
  const modules = new Set(profiles.map((profile) => `lib/${profile}/${moduleFile}`));
  const dependencyModules = strings(descriptor.dependency_modules ?? []);
  if (
    dependencyModules.length &&
    (!profiles.length ||
      new Set(dependencyModules).size !== dependencyModules.length ||
      dependencyModules.some((module) => !fullMatch(/^[a-z_][a-z0-9_-]*\.so$/u, module)))
  ) {
    throw new Error('member archive has invalid native dependency modules');
  }
  for (const profile of profiles) {
    for (const module of dependencyModules) modules.add(`lib/${profile}/${module}`);
  }
  const dataFiles = new Set(
    strings(descriptor.data_files === undefined ? [] : descriptor.data_files),
  );
  const constructionLicenses = new Set(strings(descriptor.construction_licenses ?? []));
  if ([...constructionLicenses].some((file) => !file.startsWith('share/licenses/'))) {
    throw new Error('construction licenses must be beneath share/licenses');
  }
  const sqlPrefixes = strings(descriptor.sql_prefixes === undefined ? [] : descriptor.sql_prefixes);
  const sqlFiles = strings(descriptor.sql_files === undefined ? [] : descriptor.sql_files);
  for (const filename of files.keys()) {
    if (filename.startsWith(sqlPrefix)) {
      const basename = filename.slice(sqlPrefix.length);
      const valid =
        basename === `${name}.control` ||
        (basename.endsWith('.sql') && basename.startsWith(`${name}--`)) ||
        sqlPrefixes.some((prefix) => basename.startsWith(prefix) && basename.endsWith('.sql')) ||
        sqlFiles.includes(basename);
      if (!valid) throw new Error('member archive contains foreign SQL/control resources');
    } else if (
      !modules.has(filename) &&
      !dataFiles.has(filename) &&
      !constructionLicenses.has(filename)
    ) {
      throw new Error('member archive contains an undeclared resource');
    }
  }
  if ([...modules].some((module) => !files.has(module))) {
    throw new Error('member archive is missing a required ABI profile');
  }
  if ([...dataFiles].some((file) => !files.has(file))) {
    throw new Error('member archive is missing a required data resource');
  }
  if ([...constructionLicenses].some((file) => !files.has(file))) {
    throw new Error('member archive is missing a required construction license');
  }
  for (const receipt of constructionLicenses) {
    if (!receipt.endsWith('/SOURCE.json')) continue;
    const source = record(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(files.get(receipt))),
    );
    if (source.schema !== 'oliphaunt-compiler-runtime-source-v1' || !Array.isArray(source.files)) {
      throw new Error('construction license has an invalid source receipt');
    }
    const license = source.files.map(record).find((file) => file.destination === 'LICENSE.TXT');
    const destination = receipt.replace(/SOURCE\.json$/u, 'LICENSE.TXT');
    const data = files.get(destination);
    if (
      !license ||
      !constructionLicenses.has(destination) ||
      !data ||
      license.sha256 !== createHash('sha256').update(data).digest('hex')
    ) {
      throw new Error('construction license bytes differ from their upstream source pin');
    }
  }
  for (const module of modules) {
    const data = files.get(module);
    if (
      !data ||
      data.length < 64 ||
      !data.subarray(0, 6).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1])) ||
      data.readUInt16LE(16) !== 3 ||
      data.readUInt16LE(18) !== architecture.machine
    ) {
      throw new Error(`native module must be an ELF ${architecture.name} shared object`);
    }
  }
  if (typeof descriptor.creates_extension !== 'boolean') {
    throw new Error('member descriptor must declare creates_extension');
  }
  if (descriptor.creates_extension) {
    const controlBytes = files.get(`${sqlPrefix}${name}.control`);
    if (!controlBytes) throw new Error('member has no required extension control');
    const control = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(controlBytes);
    const match = /^default_version\s*=\s*'([^']+)'/m.exec(control);
    if (!match || match[1] !== descriptor.default_version) {
      throw new Error('member control disagrees with the canonical default version');
    }
    const reachable = new Set<string>();
    const edges = new Map<string, string[]>();
    const prefix = `${sqlPrefix}${name}--`;
    for (const filename of files.keys()) {
      if (!filename.startsWith(prefix) || !filename.endsWith('.sql')) continue;
      const versionsPart = filename.slice(prefix.length, -'.sql'.length);
      if (!versionsPart || versionsPart.includes('/')) continue;
      // Upstream extensions/upgrade-paths-rules.mk installs this PostGIS
      // template beside its real version-to-ANY edges. It is not a version edge.
      if (name === 'postgis' && versionsPart === 'TEMPLATED--TO--ANY') continue;
      const versions = versionsPart.split('--');
      if (versions.length === 1) reachable.add(versions[0]);
      else if (versions.length === 2)
        edges.set(versions[0], [...(edges.get(versions[0]) ?? []), versions[1]]);
      else throw new Error('invalid member SQL version path');
    }
    const queue = [...reachable];
    for (let index = 0; index < queue.length; index += 1) {
      for (const target of edges.get(queue[index]) ?? []) {
        if (!reachable.has(target)) {
          reachable.add(target);
          queue.push(target);
        }
      }
    }
    if (
      typeof descriptor.default_version !== 'string' ||
      !reachable.has(descriptor.default_version)
    ) {
      throw new Error('member default SQL version is not installable');
    }
  }
  return descriptor;
}

if (import.meta.main) {
  try {
    const { positionals, values } = parseArgs({
      allowPositionals: true,
      options: { 'sql-name': { type: 'string' }, owner: { type: 'string' } },
    });
    if (positionals.length !== 1) {
      throw new Error(
        'usage: validate_member_payload.mts <archive> [--sql-name <name>] [--owner <product>]',
      );
    }
    inspect(positionals[0], values['sql-name'], values.owner);
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 2;
  }
}
