import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
} from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { strictGunzip } from '../../../../../tools/packaging/portable-archive.mts';
import {
  releaseNoticeDeclaration,
  releaseNoticeRows,
} from '../../../../../tools/packaging/release-notices.mts';
import { extensionProductForSqlName } from '../../../../../tools/release/release-artifact-targets.mts';
import { EXTENSION_VERSIONING_BY_CLASS } from '../../../../../tools/release/extension-release-metadata.mts';
import {
  isPortableNpmExtensionLicensePath,
  parseNpmExtensionLicenseFiles,
} from '../../../../native/sdks/ts/src/native/extension-contract.ts';
import {
  nativeExtensionDependencyModulePaths,
  nativeExtensionModuleHostTarget,
} from '../../../contracts/extension-target-profiles.mts';
import { EXTENSION_ARTIFACT_ARCHIVE_POLICY } from '../../../tools/extension-artifact-archive-policy.mts';
import {
  extensionCarrierLegalContract,
  extensionUpstreamLicenseRow,
  validateNativeExtensionConstructionLicenseInventory,
} from '../../../tools/extension-upstream-licenses.mts';

export const EXTENSION_ARTIFACT_PROPERTY_KEYS = Object.freeze([
  'packageLayout',
  'pgMajor',
  'sqlName',
  'createsExtension',
  'nativeModuleStem',
  'nativeModuleFile',
  'nativeTarget',
  'nativeRuntimeProduct',
  'nativeRuntimeVersion',
  'dependencies',
  'dataFiles',
  'extensionSqlFileNames',
  'extensionSqlFilePrefixes',
  'sharedPreloadLibraries',
  'mobilePrebuilt',
  'mobileStaticArchives',
  'mobileStaticDependencyArchives',
  'staticSymbolPrefix',
  'staticSymbolAliases',
  'licenseFiles',
  'licenseProfile',
  'sqlMembers',
  'nativeModuleStems',
  'files',
]);

const PORTABLE_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const C_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const {
  maxCompressedBytes: MAX_COMPRESSED_ARCHIVE_BYTES,
  maxExpandedBytes: MAX_EXPANDED_ARCHIVE_BYTES,
  maxMemberBytes: MAX_ARCHIVE_MEMBER_BYTES,
  maxMembers: MAX_ARCHIVE_MEMBERS,
} = EXTENSION_ARTIFACT_ARCHIVE_POLICY;
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const DESKTOP_NATIVE_TARGETS = new Set([
  'linux-x64-gnu',
  'linux-arm64-gnu',
  'macos-arm64',
  'windows-x64-msvc',
]);

function inventoryError(label, message) {
  return new Error(`${label}: ${message}`);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Only complete absence identifies the immutable primary-only manifest shape. */
export function hasDeclaredExtensionArtifactClosure(value, label = 'extension member') {
  const fields = [
    ['sqlMembers', 'sql-members'],
    ['nativeModuleStems', 'native-module-stems'],
  ];
  const present = fields.map((names) => names.some((name) => Object.hasOwn(value, name)));
  if (present[0] !== present[1])
    throw inventoryError(label, 'sqlMembers and nativeModuleStems must be declared together');
  return present[0];
}

export function assertExtensionArtifactClosureShape(metadata, label) {
  for (const field of ['sqlMembers', 'nativeModuleStems']) {
    const values = metadata[field];
    if (
      !Array.isArray(values) ||
      values.some((value) => typeof value !== 'string' || !PORTABLE_ID.test(value)) ||
      JSON.stringify(values) !== JSON.stringify([...new Set(values)].sort(compareText))
    ) {
      throw inventoryError(label, `${field} must be sorted unique portable identifiers`);
    }
  }
  if (metadata.sqlMembers.includes(metadata.sqlName) !== metadata.createsExtension)
    throw inventoryError(
      label,
      'sqlMembers must include sqlName exactly when createsExtension is true',
    );
  if (!metadata.createsExtension && metadata.sqlMembers.length !== 0)
    throw inventoryError(label, 'sqlMembers must be empty when createsExtension is false');
  if (metadata.nativeModuleStem === null && metadata.nativeModuleStems.length !== 0)
    throw inventoryError(label, 'nativeModuleStems must be empty when nativeModuleStem is null');
  if (
    metadata.nativeModuleStem !== null &&
    !metadata.nativeModuleStems.includes(metadata.nativeModuleStem)
  )
    throw inventoryError(label, 'nativeModuleStems must include nativeModuleStem');
}

/** Mobile archives merge all owned native code into the primary static module. */
export function rewriteMobileExtensionModuleReferences(
  sql: string,
  nativeModuleStem: string | null,
  nativeModuleStems: readonly string[],
) {
  if (!nativeModuleStem) return sql;
  for (const stem of nativeModuleStems) {
    if (stem !== nativeModuleStem)
      sql = sql.replaceAll(`'$libdir/${stem}'`, `'$libdir/${nativeModuleStem}'`);
  }
  return sql;
}

/** Original carrier hashes authenticate these bytes; current source pins govern new carriers. */
export function validateFrozenExtensionLegalInventory(
  { profile, licenseFiles, files, constructionLicenseFiles = [], extensionClass = undefined },
  label,
) {
  if (
    typeof profile !== 'string' ||
    !/^(?:external|contrib)-(?:native|wasix)(?:-openssl)?$/u.test(profile)
  )
    throw inventoryError(label, 'frozen legal profile must identify an extension carrier');
  const notices = releaseNoticeDeclaration(profile).members;
  if (
    extensionClass !== undefined &&
    (!Object.hasOwn(EXTENSION_VERSIONING_BY_CLASS, extensionClass) ||
      !profile.startsWith(`${extensionClass === 'contrib' ? 'contrib' : 'external'}-`))
  )
    throw inventoryError(label, 'frozen legal profile differs from the original extension class');
  if (
    !Array.isArray(licenseFiles) ||
    licenseFiles.some((file) => !isPortableNpmExtensionLicensePath(file)) ||
    JSON.stringify(licenseFiles) !== JSON.stringify([...new Set(licenseFiles)].sort(compareText))
  )
    throw inventoryError(
      label,
      'frozen licenseFiles must be sorted unique portable share/licenses paths',
    );
  if (!Array.isArray(files)) throw inventoryError(label, 'frozen legal files must be an array');
  const rows = files.map((row) => {
    if (
      row === null ||
      typeof row !== 'object' ||
      Array.isArray(row) ||
      JSON.stringify(Object.keys(row).sort(compareText)) !==
        JSON.stringify(['bytes', 'mode', 'path', 'sha256']) ||
      row.mode !== '0644' ||
      !Number.isSafeInteger(row.bytes) ||
      row.bytes <= 0 ||
      typeof row.sha256 !== 'string' ||
      !SHA256.test(row.sha256)
    )
      throw inventoryError(
        label,
        'frozen legal files require exact path, 0644 mode, positive size and SHA-256',
      );
    return {
      path: safeRelativePath(row.path, label),
      mode: '0644',
      bytes: row.bytes,
      sha256: row.sha256,
    };
  });
  const expected = [...notices, ...licenseFiles].sort(compareText);
  if (JSON.stringify(rows.map((row) => row.path)) !== JSON.stringify(expected))
    throw inventoryError(
      label,
      'frozen legal files must exactly cover the declared notices and licenseFiles',
    );
  parseNpmExtensionLicenseFiles(
    rows.filter((row) => licenseFiles.includes(row.path)).map(({ bytes: _bytes, ...row }) => row),
    `${label} licenseFiles`,
  );
  for (const construction of parseNpmExtensionLicenseFiles(
    constructionLicenseFiles,
    `${label} construction licenses`,
  )) {
    const row = rows.find((row) => row.path === construction.path);
    if (!row || row.sha256 !== construction.sha256 || row.mode !== construction.mode)
      throw inventoryError(
        label,
        `frozen construction license ${construction.path} differs from its original legal inventory`,
      );
  }
  return {
    profile,
    licenseFiles: [...licenseFiles],
    files: rows,
    ...(extensionClass === undefined ? {} : { extensionClass }),
  };
}

/** Capture the legal inventory from an already authenticated original native member. */
export function frozenExtensionArtifactLegalInventory(entries, label) {
  const manifest = entries.get('manifest.properties');
  if (!manifest) throw inventoryError(label, 'is missing manifest.properties');
  const properties = parseExtensionArtifactProperties(decodeUtf8(manifest.data, label), label);
  const profile = properties.get('licenseProfile');
  const licenseFiles = csv(properties.get('licenseFiles'), `${label} licenseFiles`);
  const files = [...releaseNoticeDeclaration(profile).members, ...licenseFiles]
    .sort(compareText)
    .map((file) => {
      const name = file.startsWith('share/licenses/') ? `files/${file}` : file;
      const entry = entries.get(name);
      if (!entry) throw inventoryError(label, `missing original legal member ${name}`);
      return {
        path: file,
        mode: entry.mode === 0o644 ? '0644' : entry.mode.toString(8),
        bytes: entry.bytes,
        sha256: entry.sha256,
      };
    });
  return validateFrozenExtensionLegalInventory({ profile, licenseFiles, files }, label);
}

function safeRelativePath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw inventoryError(label, 'must be a non-empty relative path');
  }
  if (
    value.includes('\\') ||
    value !== value.normalize('NFC') ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw inventoryError(
      label,
      'must use NFC UTF-8 text without backslashes or control characters',
    );
  }
  const parts = value.split('/');
  if (
    value.startsWith('/') ||
    /^[A-Za-z]:/u.test(value) ||
    parts.some((part) => part.length === 0 || part === '.' || part === '..')
  ) {
    throw inventoryError(label, `must be a canonical relative path; got ${JSON.stringify(value)}`);
  }
  return parts.join('/');
}

function csv(value, label, { paths = false } = {}) {
  if (typeof value !== 'string') throw inventoryError(label, 'must be a string');
  if (value.length === 0) return [];
  const rows = value.split(',').map((row, index) => {
    if (row.length === 0 || row.trim() !== row) {
      throw inventoryError(label, `contains a malformed item at index ${index}`);
    }
    return paths ? safeRelativePath(row, `${label}[${index}]`) : row;
  });
  if (new Set(rows).size !== rows.length)
    throw inventoryError(label, 'must not contain duplicates');
  const sorted = [...rows].sort(compareText);
  if (JSON.stringify(rows) !== JSON.stringify(sorted)) {
    throw inventoryError(label, 'must be sorted deterministically');
  }
  return rows;
}

export function parseExtensionArtifactProperties(text, label) {
  if (
    typeof text !== 'string' ||
    text.startsWith('\uFEFF') ||
    text.includes('\r') ||
    text.includes('\\') ||
    text !== text.normalize('NFC') ||
    /[\u0000-\u0009\u000b-\u001f\u007f]/u.test(text) ||
    !text.endsWith('\n') ||
    text.endsWith('\n\n')
  ) {
    throw inventoryError(
      label,
      'must be canonical NFC UTF-8 key=value text with LF lines and exactly one final newline',
    );
  }
  const properties = new Map();
  const lines = text.slice(0, -1).split('\n');
  for (const [index, rawLine] of lines.entries()) {
    if (rawLine.length === 0) {
      throw inventoryError(label, `has an internal blank line at ${index + 1}`);
    }
    const separator = rawLine.indexOf('=');
    if (separator <= 0 || rawLine.trim() !== rawLine) {
      throw inventoryError(label, `has malformed properties line ${index + 1}`);
    }
    const key = rawLine.slice(0, separator);
    if (properties.has(key)) {
      throw inventoryError(label, `repeats property ${key}`);
    }
    properties.set(key, rawLine.slice(separator + 1));
  }
  const actual = [...properties.keys()].sort(compareText);
  const keys =
    !properties.has('sqlMembers') && !properties.has('nativeModuleStems')
      ? EXTENSION_ARTIFACT_PROPERTY_KEYS.filter(
          (key) => key !== 'sqlMembers' && key !== 'nativeModuleStems',
        )
      : EXTENSION_ARTIFACT_PROPERTY_KEYS;
  const expected = [...keys].sort(compareText);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw inventoryError(
      label,
      `property fields must be exactly ${expected.join(',')}; got ${actual.join(',')}`,
    );
  }
  if (JSON.stringify([...properties.keys()]) !== JSON.stringify(keys)) {
    throw inventoryError(label, 'properties must use the canonical field order');
  }
  return properties;
}

function decodeUtf8(bytes, label) {
  try {
    return UTF8.decode(bytes);
  } catch (error) {
    throw inventoryError(label, `contains invalid UTF-8: ${error.message}`);
  }
}

function tarString(buffer, offset, length, label, field) {
  const bytes = buffer.subarray(offset, offset + length);
  const end = bytes.indexOf(0);
  if (end >= 0 && !bytes.subarray(end).every((byte) => byte === 0)) {
    throw inventoryError(label, `tar ${field} has nonzero bytes after its terminator`);
  }
  return decodeUtf8(bytes.subarray(0, end < 0 ? bytes.length : end), `${label} tar ${field}`);
}

function canonicalTarOctal(length, value) {
  return Buffer.from(`${value.toString(8).padStart(length - 1, '0')}\0`, 'ascii');
}

function tarOctal(buffer, offset, length, label, field) {
  if (field === 'checksum') {
    const bytes = buffer.subarray(offset, offset + length);
    if (length !== 8 || bytes[6] !== 0 || bytes[7] !== 0x20) {
      throw inventoryError(label, 'has noncanonical tar checksum encoding');
    }
    const digits = decodeUtf8(bytes.subarray(0, 6), `${label} tar checksum`);
    if (!/^[0-7]{6}$/u.test(digits)) {
      throw inventoryError(label, `has invalid tar checksum field ${JSON.stringify(digits)}`);
    }
    return Number.parseInt(digits, 8);
  }
  const value = tarString(buffer, offset, length, label, field).trim();
  if (!/^[0-7]+$/u.test(value)) {
    throw inventoryError(label, `has invalid tar ${field} field ${JSON.stringify(value)}`);
  }
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw inventoryError(label, `has out-of-range tar ${field}`);
  }
  return parsed;
}

function readExact(descriptor, position, length, label) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const bytes = readSync(descriptor, buffer, offset, length - offset, position + offset);
    if (bytes === 0) throw inventoryError(label, 'tar stream ended unexpectedly');
    offset += bytes;
  }
  return buffer;
}

function canonicalTarPathParts(archiveName, label) {
  if (Buffer.byteLength(archiveName) <= 100) {
    return { name: archiveName, prefix: '' };
  }
  const parts = archiveName.split('/');
  for (let index = 1; index < parts.length; index += 1) {
    const prefix = parts.slice(0, index).join('/');
    const name = parts.slice(index).join('/');
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  throw inventoryError(
    label,
    `member ${archiveName} cannot use the canonical producer ustar split`,
  );
}

function validateCanonicalHeader(header, label, block, collisionNames, entries) {
  const storedChecksum = tarOctal(header, 148, 8, label, 'checksum');
  const checksumHeader = Buffer.from(header);
  checksumHeader.fill(0x20, 148, 156);
  const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
  if (storedChecksum !== actualChecksum) {
    throw inventoryError(label, `has a tar header checksum mismatch at block ${block}`);
  }
  if (tarString(header, 257, 6, label, 'magic') !== 'ustar') {
    throw inventoryError(label, 'must use canonical ustar headers');
  }
  const name = tarString(header, 0, 100, label, 'name');
  const prefix = tarString(header, 345, 155, label, 'prefix');
  const archiveName = safeRelativePath(prefix ? `${prefix}/${name}` : name, `${label} tar member`);
  const canonicalPath = canonicalTarPathParts(archiveName, label);
  if (name !== canonicalPath.name || prefix !== canonicalPath.prefix) {
    throw inventoryError(
      label,
      `member ${archiveName} must use canonical ustar name/prefix split ${JSON.stringify(canonicalPath)}`,
    );
  }
  const collisionKey = archiveName.normalize('NFC').toLowerCase();
  const collision = collisionNames.get(collisionKey);
  if (collision !== undefined && collision !== archiveName) {
    throw inventoryError(
      label,
      `contains case/NFC-colliding members ${collision} and ${archiveName}`,
    );
  }
  collisionNames.set(collisionKey, archiveName);
  if (header[156] !== 0x30) {
    throw inventoryError(label, `member ${archiveName} must be a regular file`);
  }
  const mode = tarOctal(header, 100, 8, label, 'mode');
  const uid = tarOctal(header, 108, 8, label, 'uid');
  const gid = tarOctal(header, 116, 8, label, 'gid');
  const size = tarOctal(header, 124, 12, label, 'size');
  const mtime = tarOctal(header, 136, 12, label, 'mtime');
  if (size > MAX_ARCHIVE_MEMBER_BYTES) {
    throw inventoryError(label, `member ${archiveName} exceeds ${MAX_ARCHIVE_MEMBER_BYTES} bytes`);
  }
  if (![0o644, 0o755].includes(mode) || uid !== 0 || gid !== 0 || mtime !== 0) {
    throw inventoryError(
      label,
      `member ${archiveName} must use mode 0644/0755, uid=0, gid=0 and mtime=0`,
    );
  }
  for (const [field, offset, length, value] of [
    ['mode', 100, 8, mode],
    ['uid', 108, 8, uid],
    ['gid', 116, 8, gid],
    ['size', 124, 12, size],
    ['mtime', 136, 12, mtime],
  ]) {
    if (!header.subarray(offset, offset + length).equals(canonicalTarOctal(length, value))) {
      throw inventoryError(label, `member ${archiveName} has noncanonical tar ${field} encoding`);
    }
  }
  if (
    !header
      .subarray(148, 156)
      .equals(Buffer.from(`${storedChecksum.toString(8).padStart(6, '0')}\0 `, 'ascii')) ||
    !header.subarray(157, 257).every((byte) => byte === 0) ||
    !header.subarray(257, 263).equals(Buffer.from('ustar\0', 'ascii')) ||
    !header.subarray(263, 265).equals(Buffer.from('00', 'ascii')) ||
    tarString(header, 265, 32, label, 'uname') !== 'root' ||
    tarString(header, 297, 32, label, 'gname') !== 'root' ||
    !header.subarray(329, 345).every((byte) => byte === 0) ||
    !header.subarray(500, 512).every((byte) => byte === 0)
  ) {
    throw inventoryError(
      label,
      `member ${archiveName} does not use the canonical producer ustar header`,
    );
  }
  if (entries.has(archiveName)) {
    throw inventoryError(label, `contains duplicate member ${archiveName}`);
  }
  return { archiveName, mode, size };
}

/** Read exactly the bounded deterministic gzip+ustar emitted by extension-artifact-packager.mts. */
export function readCanonicalExtensionArtifactArchive(file, label = file) {
  const carrierMetadata = lstatSync(file, { bigint: true });
  if (carrierMetadata.isSymbolicLink() || !carrierMetadata.isFile()) {
    throw inventoryError(label, 'carrier input must be a regular non-symlink file');
  }
  let compressed;
  const descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.dev !== carrierMetadata.dev ||
      opened.ino !== carrierMetadata.ino
    ) {
      throw inventoryError(label, 'carrier changed between path inspection and no-follow open');
    }
    const size = Number(opened.size);
    if (!Number.isSafeInteger(size) || size < 18 || size > MAX_COMPRESSED_ARCHIVE_BYTES) {
      throw inventoryError(
        label,
        'archive bytes must be between 18 and ' + MAX_COMPRESSED_ARCHIVE_BYTES,
      );
    }
    compressed = readExact(descriptor, 0, size, label);
    const after = fstatSync(descriptor, { bigint: true });
    if (
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs
    ) {
      throw inventoryError(label, 'carrier metadata changed while taking its private snapshot');
    }
  } finally {
    closeSync(descriptor);
  }
  if (compressed.subarray(0, 10).toString('hex') !== '1f8b0800000000000003') {
    throw inventoryError(label, 'must use the canonical cross-platform gzip header');
  }
  const tar = strictGunzip(compressed, label, MAX_EXPANDED_ARCHIVE_BYTES);
  const expandedBytes = tar.length;
  if (expandedBytes < 1024 || expandedBytes % 512 !== 0) {
    throw inventoryError(label, 'must contain a bounded block-aligned ustar stream');
  }
  const entries = new Map();
  const collisionNames = new Map();
  let offset = 0;
  let ended = false;
  while (offset < expandedBytes) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (expandedBytes - offset !== 1024 || !tar.subarray(offset).every((byte) => byte === 0)) {
        throw inventoryError(label, 'tar end marker or trailing padding is not canonical');
      }
      ended = true;
      break;
    }
    const { archiveName, mode, size } = validateCanonicalHeader(
      header,
      label,
      offset / 512,
      collisionNames,
      entries,
    );
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    const paddedEnd = dataStart + Math.ceil(size / 512) * 512;
    if (dataEnd > expandedBytes || paddedEnd > expandedBytes) {
      throw inventoryError(label, `member ${archiveName} exceeds the tar stream`);
    }
    const data = tar.subarray(dataStart, dataEnd);
    if (!tar.subarray(dataEnd, paddedEnd).every((byte) => byte === 0)) {
      throw inventoryError(label, `member ${archiveName} has nonzero tar padding`);
    }
    entries.set(archiveName, {
      bytes: data.length,
      data,
      mode,
      sha256: createHash('sha256').update(data).digest('hex'),
    });
    if (entries.size > MAX_ARCHIVE_MEMBERS) {
      throw inventoryError(label, `contains more than ${MAX_ARCHIVE_MEMBERS} members`);
    }
    offset = paddedEnd;
  }
  if (!ended || entries.size === 0) {
    throw inventoryError(label, 'must contain regular files and a canonical tar end marker');
  }
  const names = [...entries.keys()];
  if (JSON.stringify(names) !== JSON.stringify([...names].sort(compareText))) {
    throw inventoryError(label, 'tar members must be sorted deterministically');
  }
  return entries;
}

function normalizeMetadata(row, label) {
  const sqlName = row?.sqlName ?? row?.['sql-name'];
  if (typeof sqlName !== 'string' || !PORTABLE_ID.test(sqlName)) {
    throw inventoryError(label, 'has an invalid sqlName');
  }
  const list = (camel, kebab, explicitValue = undefined) => {
    const value = explicitValue ?? row?.[camel] ?? row?.[kebab];
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw inventoryError(label, `${kebab} must be a string array`);
    }
    const sorted = [...value].sort(compareText);
    if (new Set(sorted).size !== sorted.length) {
      throw inventoryError(label, `${kebab} must not contain duplicates`);
    }
    return sorted;
  };
  const nativeModuleStem = row?.nativeModuleStem ?? row?.['native-module-stem'] ?? null;
  if (
    nativeModuleStem !== null &&
    (typeof nativeModuleStem !== 'string' || !PORTABLE_ID.test(nativeModuleStem))
  ) {
    throw inventoryError(label, 'native-module-stem must be null or a portable identifier');
  }
  const createsExtension = row?.createsExtension ?? row?.['creates-extension'];
  if (typeof createsExtension !== 'boolean') {
    throw inventoryError(label, 'creates-extension must be boolean');
  }
  const declaredClosure = hasDeclaredExtensionArtifactClosure(row, label);
  const metadata = {
    sqlName,
    createsExtension,
    nativeModuleStem,
    sqlMembers: list(
      'sqlMembers',
      'sql-members',
      declaredClosure ? undefined : createsExtension ? [sqlName] : [],
    ),
    nativeModuleStems: list(
      'nativeModuleStems',
      'native-module-stems',
      declaredClosure ? undefined : nativeModuleStem === null ? [] : [nativeModuleStem],
    ),
    dependencies: (() => {
      const selected =
        row?.selectedExtensionDependencies ??
        row?.['selected-extension-dependencies'] ??
        row?.dependencies;
      return list('selectedExtensionDependencies', 'selected-extension-dependencies', selected);
    })(),
    dataFiles: list(
      'runtimeShareDataFiles',
      'runtime-share-data-files',
      row?.runtimeShareDataFiles ?? row?.['runtime-share-data-files'] ?? row?.dataFiles,
    ).map((item, index) => safeRelativePath(item, `${label}.runtime-share-data-files[${index}]`)),
    extensionSqlFileNames: list('extensionSqlFileNames', 'extension-sql-file-names'),
    extensionSqlFilePrefixes: list('extensionSqlFilePrefixes', 'extension-sql-file-prefixes'),
    sharedPreloadLibraries: list('sharedPreloadLibraries', 'shared-preload-libraries'),
    nativeDependencyModules: list(
      'nativeDependencyModules',
      'native-dependency-modules',
      row?.nativeDependencyModules ?? [],
    ),
    nativeConstructionLicenseFiles: row?.nativeConstructionLicenseFiles ?? [],
  };
  for (const [field, values] of [
    ['selected-extension-dependencies', metadata.dependencies],
    ['shared-preload-libraries', metadata.sharedPreloadLibraries],
    ['sql-members', metadata.sqlMembers],
    ['native-module-stems', metadata.nativeModuleStems],
  ]) {
    if (values.some((item) => !PORTABLE_ID.test(item))) {
      throw inventoryError(label, `${field} contains a non-portable identifier`);
    }
  }
  if (declaredClosure) assertExtensionArtifactClosureShape(metadata, label);
  if (
    metadata.nativeDependencyModules.some(
      (file) => !/^[A-Za-z0-9_-]+\.(?:so|dylib|dll)$/u.test(file),
    )
  ) {
    throw inventoryError(label, 'native-dependency-modules must contain portable module basenames');
  }
  if (
    metadata.extensionSqlFileNames.some(
      (item) => path.posix.basename(item) !== item || !item.endsWith('.sql'),
    )
  ) {
    throw inventoryError(label, 'extension-sql-file-names must contain SQL basenames');
  }
  if (
    metadata.extensionSqlFilePrefixes.some((item) => !PORTABLE_ID.test(item) || item.includes('.'))
  ) {
    throw inventoryError(
      label,
      'extension-sql-file-prefixes must contain portable basename prefixes',
    );
  }
  return metadata;
}

export function moduleSuffix(target) {
  if (target === 'windows-x64-msvc') return '.dll';
  if (target === 'macos-arm64' || target === 'ios-xcframework') return '.dylib';
  return '.so';
}

export function isDesktopNativeTarget(target) {
  return DESKTOP_NATIVE_TARGETS.has(target);
}

/** Project the canonical recipe's module stems into an existing desktop profile. */
export const nativeModuleHostTarget = nativeExtensionModuleHostTarget;

export function nativeDependencyModuleBasenames(files = [], target, byTarget = {}) {
  const hostTarget = nativeModuleHostTarget(target);
  if (!isDesktopNativeTarget(hostTarget)) {
    if (files.length === 0) return [];
    throw inventoryError(
      'native dependency modules',
      `target ${target} has no desktop module contract`,
    );
  }
  return nativeExtensionDependencyModulePaths(files, target, byTarget)
    .map((file) => {
      const match = /^lib\/postgresql\/([A-Za-z0-9_-]+)\.(?:so|dylib|dll)$/u.exec(file);
      if (!match)
        throw inventoryError(
          'native dependency modules',
          'canonical recipe requires a portable PostgreSQL module destination',
        );
      return match[1] + moduleSuffix(hostTarget);
    })
    .sort(compareText);
}

// The target recipe owns native modules; the common recipe also lists WASIX-only dependencies.
export function extensionNativeArtifactClosure(sqlName, target) {
  if (!PORTABLE_ID.test(sqlName)) throw inventoryError(sqlName, 'invalid extension SQL name');
  const directory = path.resolve(import.meta.dir, '../../../external', sqlName);
  const read = (file) => {
    const full = path.join(directory, file);
    return existsSync(full) ? Bun.TOML.parse(readFileSync(full, 'utf8')) : {};
  };
  const controls = (read('recipe.toml').artifacts?.control_files ?? []).map((file) => {
    const normalized = safeRelativePath(file, `${sqlName} control file`);
    const name = normalized.slice('share/postgresql/extension/'.length);
    if (
      normalized !== `share/postgresql/extension/${name}` ||
      !name.endsWith('.control') ||
      !PORTABLE_ID.test(name.slice(0, -'.control'.length))
    ) {
      throw inventoryError(sqlName, `invalid extension control file ${file}`);
    }
    return name;
  });
  const modules = (read('targets/native.toml').module_files ?? []).map((file) => {
    const normalized = safeRelativePath(file, `${sqlName} native module`);
    const name = normalized.slice('lib/postgresql/'.length);
    if (normalized !== `lib/postgresql/${name}` || !PORTABLE_ID.test(name)) {
      throw inventoryError(sqlName, `invalid native module ${file}`);
    }
    if (!/\.(so|dylib|dll)$/u.test(name)) {
      throw inventoryError(sqlName, `invalid native module suffix ${file}`);
    }
    return name.replace(/\.(so|dylib|dll)$/u, moduleSuffix(target));
  });
  return {
    controls: [...new Set(controls)].sort(compareText),
    modules: [...new Set(modules)].sort(compareText),
  };
}

export function extensionArtifactMemberClosure(metadata, target = 'linux-x64-gnu') {
  const closure = extensionNativeArtifactClosure(metadata.sqlName, target);
  return {
    sqlMembers: [
      ...new Set([
        ...(metadata.createsExtension ? [metadata.sqlName] : []),
        ...closure.controls.map((name) => name.slice(0, -'.control'.length)),
      ]),
    ].sort(compareText),
    nativeModuleStems: [
      ...new Set([
        ...(metadata.nativeModuleStem === null ? [] : [metadata.nativeModuleStem]),
        ...closure.modules.map((name) => name.slice(0, -moduleSuffix(target).length)),
      ]),
    ].sort(compareText),
  };
}

export function assertExtensionArtifactClosure(metadata, target, label) {
  assertExtensionArtifactClosureShape(metadata, label);
  const expected = extensionArtifactMemberClosure(metadata, target);
  for (const [field, values] of Object.entries(expected)) {
    if (JSON.stringify(metadata[field]) !== JSON.stringify(values)) {
      throw inventoryError(
        label,
        `${field} must match the current source-owned closure ${JSON.stringify(values)}`,
      );
    }
  }
}

function sqlFileOwned(fileName, metadata) {
  return (
    metadata.companionControls?.includes(fileName) ||
    metadata.companionControls?.some(
      (control) =>
        fileName.startsWith(`${control.slice(0, -'.control'.length)}--`) &&
        fileName.endsWith('.sql'),
    ) ||
    (metadata.createsExtension && fileName === `${metadata.sqlName}.control`) ||
    (metadata.createsExtension && fileName === `${metadata.sqlName}.sql`) ||
    (metadata.createsExtension &&
      fileName.startsWith(`${metadata.sqlName}--`) &&
      fileName.endsWith('.sql')) ||
    metadata.extensionSqlFileNames.includes(fileName) ||
    (fileName.endsWith('.sql') &&
      metadata.extensionSqlFilePrefixes.some((prefix) => fileName.startsWith(prefix)))
  );
}

export function isCanonicalExtensionInstallSql(fileName, sqlName) {
  const prefix = `${sqlName}--`;
  if (!fileName.startsWith(prefix) || !fileName.endsWith('.sql')) return false;
  const version = fileName.slice(prefix.length, -'.sql'.length);
  return /^[0-9][A-Za-z0-9._-]*$/u.test(version) && !version.includes('--');
}

function extensionSqlVersion(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value) && !value.includes('--');
}

export function extensionControlDefaultVersion(control, sqlName, label) {
  const values = [];
  for (const [index, raw] of control.split(/\r?\n/u).entries()) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    if (!/^default_version(?:\s|=)/u.test(line)) continue;
    const match = line.match(/^default_version\s*=\s*'([^']+)'\s*(?:#.*)?$/u);
    if (match === null || !extensionSqlVersion(match[1])) {
      throw inventoryError(
        label,
        `${sqlName}.control has invalid default_version on line ${index + 1}`,
      );
    }
    values.push(match[1]);
  }
  if (values.length !== 1) {
    throw inventoryError(label, `${sqlName}.control must declare default_version exactly once`);
  }
  return values[0];
}

function canonicalInstallVersion(fileName, sqlName) {
  if (!isCanonicalExtensionInstallSql(fileName, sqlName)) return null;
  return fileName.slice(`${sqlName}--`.length, -'.sql'.length);
}

function canonicalUpdateEdge(fileName, sqlName) {
  const prefix = `${sqlName}--`;
  if (!fileName.startsWith(prefix) || !fileName.endsWith('.sql')) return null;
  const versions = fileName.slice(prefix.length, -'.sql'.length).split('--');
  if (versions.length !== 2 || !versions.every(extensionSqlVersion)) return null;
  return versions;
}

/** Prove that PostgreSQL can install the control file's default version. */
export function validateExtensionInstallSqlReachability({ sqlName, control, fileNames, label }) {
  const defaultVersion = extensionControlDefaultVersion(control, sqlName, label);
  const installVersions = new Set();
  const updateTargets = new Map();
  for (const fileName of [...new Set(fileNames)].sort(compareText)) {
    const installVersion = canonicalInstallVersion(fileName, sqlName);
    if (installVersion !== null) installVersions.add(installVersion);
    const edge = canonicalUpdateEdge(fileName, sqlName);
    if (edge !== null) {
      const [from, to] = edge;
      const targets = updateTargets.get(from) ?? new Set();
      targets.add(to);
      updateTargets.set(from, targets);
    }
  }
  if (installVersions.has(defaultVersion)) return;

  const reachable = new Set(installVersions);
  const pending = [...installVersions].sort(compareText);
  for (let index = 0; index < pending.length; index += 1) {
    const current = pending[index];
    for (const next of [...(updateTargets.get(current) ?? [])].sort(compareText)) {
      if (reachable.has(next)) continue;
      reachable.add(next);
      pending.push(next);
    }
  }
  if (reachable.has(defaultVersion)) return;

  const updates = [...updateTargets]
    .flatMap(([from, targets]) => [...targets].map((to) => `${from}->${to}`))
    .sort(compareText);
  throw inventoryError(
    label,
    `${sqlName} default_version '${defaultVersion}' has no canonical installation script or update path; ` +
      `install versions=${[...installVersions].sort(compareText).join(',') || '-'}; updates=${updates.join(',') || '-'}`,
  );
}

function declaredMobilePaths(properties, metadata, label) {
  const paths = [];
  const staticRows = csv(properties.get('mobileStaticArchives'), `${label} mobileStaticArchives`);
  for (const [index, row] of staticRows.entries()) {
    const separator = row.indexOf(':');
    if (separator <= 0 || metadata.nativeModuleStem === null) {
      throw inventoryError(label, `mobileStaticArchives[${index}] is malformed`);
    }
    const target = row.slice(0, separator);
    const member = safeRelativePath(
      row.slice(separator + 1),
      `${label} mobileStaticArchives[${index}]`,
    );
    if (!PORTABLE_ID.test(target))
      throw inventoryError(label, `mobile static target ${target} is invalid`);
    const expected = `mobile-static/${target}/extensions/${metadata.nativeModuleStem}/liboliphaunt_extension_${metadata.nativeModuleStem}.a`;
    if (member !== expected) {
      throw inventoryError(label, `mobile static member ${member} must be ${expected}`);
    }
    paths.push(member);
  }
  const dependencyRows = csv(
    properties.get('mobileStaticDependencyArchives'),
    `${label} mobileStaticDependencyArchives`,
  );
  for (const [index, row] of dependencyRows.entries()) {
    const first = row.indexOf(':');
    const second = row.indexOf(':', first + 1);
    if (first <= 0 || second <= first + 1) {
      throw inventoryError(label, `mobileStaticDependencyArchives[${index}] is malformed`);
    }
    const target = row.slice(0, first);
    const dependency = row.slice(first + 1, second);
    const member = safeRelativePath(
      row.slice(second + 1),
      `${label} mobileStaticDependencyArchives[${index}]`,
    );
    if (!PORTABLE_ID.test(target) || !PORTABLE_ID.test(dependency)) {
      throw inventoryError(
        label,
        `mobile static dependency identity ${target}:${dependency} is invalid`,
      );
    }
    const prefix = `mobile-static/${target}/dependencies/${dependency}/`;
    if (!member.startsWith(prefix) || path.posix.basename(member) !== member.slice(prefix.length)) {
      throw inventoryError(label, `mobile static dependency member ${member} is not canonical`);
    }
    paths.push(member);
  }
  if (new Set(paths).size !== paths.length) {
    throw inventoryError(label, 'mobile static archive paths must not repeat');
  }
  return paths;
}

function validateStaticLinkage(properties, metadata, target, label) {
  const prefix = properties.get('staticSymbolPrefix');
  if (prefix !== '' && !C_IDENTIFIER.test(prefix)) {
    throw inventoryError(label, 'staticSymbolPrefix must be empty or a C identifier');
  }
  const aliases = csv(properties.get('staticSymbolAliases'), `${label} staticSymbolAliases`);
  const sqlSymbols = new Set();
  for (const [index, alias] of aliases.entries()) {
    const fields = alias.split(':');
    if (fields.length !== 2 || fields.some((field) => !C_IDENTIFIER.test(field))) {
      throw inventoryError(label, `staticSymbolAliases[${index}] must be a C-identifier pair`);
    }
    if (sqlSymbols.has(fields[0])) {
      throw inventoryError(label, `staticSymbolAliases repeats SQL-visible symbol ${fields[0]}`);
    }
    sqlSymbols.add(fields[0]);
  }
  if (DESKTOP_NATIVE_TARGETS.has(target) && (prefix !== '' || aliases.length !== 0)) {
    throw inventoryError(label, 'desktop artifacts must not declare static symbol linkage');
  }
  if (metadata.nativeModuleStem === null && (prefix !== '' || aliases.length !== 0)) {
    throw inventoryError(label, 'SQL-only artifacts must not declare static symbol linkage');
  }
}

function canonicalLegalContract(metadata, target, label, product) {
  let contract;
  try {
    product ??= extensionProductForSqlName(metadata.sqlName, 'extension-artifact-inventory.mts');
    contract = extensionCarrierLegalContract(product, [metadata.sqlName], {
      family: 'native',
      target,
      memberContracts: [metadata],
    });
  } catch (cause) {
    throw inventoryError(label, `cannot resolve canonical legal contract: ${cause.message}`);
  }
  const members = new Map();
  const add = (member, sha256, source) => {
    const prior = members.get(member);
    if (prior !== undefined && prior.sha256 !== sha256) {
      throw inventoryError(label, `canonical legal member collision at ${member}`);
    }
    members.set(member, { sha256, source });
  };
  for (const row of releaseNoticeRows({ profile: contract.profile })) {
    add(
      row.member,
      createHash('sha256').update(readFileSync(row.source)).digest('hex'),
      row.source,
    );
  }
  const upstreamFiles = contract.upstreamMembers.flatMap(
    (sqlName) => extensionUpstreamLicenseRow(sqlName).files,
  );
  const destinations = upstreamFiles.map(({ destination }) => destination).sort(compareText);
  if (JSON.stringify(destinations) !== JSON.stringify([...contract.licenseFiles])) {
    throw inventoryError(
      label,
      'canonical upstream legal files disagree with the carrier contract',
    );
  }
  for (const row of upstreamFiles) {
    add(`files/${row.destination}`, row.sha256, `${metadata.sqlName}:${row.path}`);
  }
  const construction = validateNativeExtensionConstructionLicenseInventory(
    metadata.sqlName,
    target,
    metadata.nativeConstructionLicenseFiles,
  );
  for (const row of construction)
    add(`files/${row.path}`, row.sha256, 'immutable construction source');
  if (construction.length > 0)
    contract = {
      ...contract,
      licenseFiles: [...contract.licenseFiles, ...construction.map((row) => row.path)].sort(
        compareText,
      ),
    };
  return { contract, members };
}

function originalLegalContract(metadata, inventory, label) {
  if (typeof inventory.extensionClass !== 'string')
    throw inventoryError(
      label,
      'original legal inventory must identify its frozen extension class',
    );
  const legal = validateFrozenExtensionLegalInventory(
    {
      ...inventory,
      constructionLicenseFiles: metadata.nativeConstructionLicenseFiles,
    },
    label,
  );
  if (!/^(?:external|contrib)-native(?:-openssl)?$/u.test(legal.profile))
    throw inventoryError(
      label,
      'original native artifact must declare a native extension legal profile',
    );
  return {
    contract: { profile: legal.profile, licenseFiles: legal.licenseFiles },
    members: new Map(
      legal.files.map((row) => [
        row.path.startsWith('share/licenses/') ? `files/${row.path}` : row.path,
        { ...row, source: 'authenticated original legal inventory' },
      ]),
    ),
  };
}

/**
 * Validate both manifest semantics and the exact leaf inventory of a native extension artifact.
 * Returns the runtime `files/` rows used by npm staging.
 */
export function validateExtensionArtifactEntries({
  entries,
  metadata: rawMetadata,
  target,
  nativeRuntimeVersion,
  product,
  label,
  mobileContract,
  legalInventory,
}) {
  const desktop = DESKTOP_NATIVE_TARGETS.has(target);
  if (!desktop && mobileContract?.target !== target) {
    throw inventoryError(
      label,
      `native target ${JSON.stringify(target)} requires its declared mobile inventory contract`,
    );
  }
  if (
    typeof nativeRuntimeVersion !== 'string' ||
    !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(nativeRuntimeVersion)
  ) {
    throw inventoryError(label, 'native runtime version must be stable SemVer X.Y.Z');
  }
  const metadata = normalizeMetadata(rawMetadata, `${label} canonical metadata`);
  const manifestEntry = entries.get('manifest.properties');
  if (manifestEntry === undefined) throw inventoryError(label, 'is missing manifest.properties');
  const properties = parseExtensionArtifactProperties(
    decodeUtf8(manifestEntry.data, `${label} manifest.properties`),
    `${label} manifest.properties`,
  );
  const declaredClosure = hasDeclaredExtensionArtifactClosure(rawMetadata, label);
  if (properties.has('sqlMembers') !== declaredClosure)
    throw inventoryError(label, 'manifest closure fields must match the frozen release inventory');
  const sqlMembers = declaredClosure
    ? csv(properties.get('sqlMembers'), `${label} sqlMembers`)
    : metadata.sqlMembers;
  const nativeModuleStems = declaredClosure
    ? csv(properties.get('nativeModuleStems'), `${label} nativeModuleStems`)
    : metadata.nativeModuleStems;
  for (const [key, actual] of [
    ['sqlMembers', sqlMembers],
    ['nativeModuleStems', nativeModuleStems],
  ]) {
    if (JSON.stringify(metadata[key]) !== JSON.stringify(actual)) {
      throw inventoryError(label, `manifest ${key} must match the frozen release inventory`);
    }
  }
  metadata.companionControls = sqlMembers
    .filter((name) => name !== metadata.sqlName)
    .map((name) => `${name}.control`);
  const legal =
    legalInventory === undefined
      ? canonicalLegalContract(metadata, target, label, product)
      : originalLegalContract(metadata, legalInventory, label);
  const expectedProperties = new Map([
    ['packageLayout', 'oliphaunt-extension-artifact-v1'],
    ['pgMajor', '18'],
    ['sqlName', metadata.sqlName],
    ['createsExtension', metadata.createsExtension ? 'yes' : 'no'],
    ['nativeModuleStem', metadata.nativeModuleStem ?? ''],
    [
      'nativeModuleFile',
      metadata.nativeModuleStem === null
        ? ''
        : `${metadata.nativeModuleStem}${moduleSuffix(target)}`,
    ],
    ['nativeTarget', target],
    ['nativeRuntimeProduct', 'liboliphaunt-native'],
    ['nativeRuntimeVersion', nativeRuntimeVersion],
    ['dependencies', metadata.dependencies.join(',')],
    ['dataFiles', metadata.dataFiles.join(',')],
    ['extensionSqlFileNames', metadata.extensionSqlFileNames.join(',')],
    ['extensionSqlFilePrefixes', metadata.extensionSqlFilePrefixes.join(',')],
    ['sharedPreloadLibraries', metadata.sharedPreloadLibraries.join(',')],
    ['licenseFiles', legal.contract.licenseFiles.join(',')],
    ['licenseProfile', legal.contract.profile],
    ['files', 'files'],
  ]);
  for (const [key, expected] of expectedProperties) {
    if (properties.get(key) !== expected) {
      throw inventoryError(
        label,
        `manifest ${key} must be ${JSON.stringify(expected)}; got ${JSON.stringify(properties.get(key))}`,
      );
    }
  }
  if (!new Set(['yes', 'no']).has(properties.get('mobilePrebuilt'))) {
    throw inventoryError(label, 'manifest mobilePrebuilt must be yes or no');
  }
  validateStaticLinkage(properties, metadata, target, label);
  if (!desktop) {
    const expectedMobile = new Map([
      ['mobilePrebuilt', metadata.nativeModuleStem === null ? 'no' : 'yes'],
      ['mobileStaticArchives', mobileContract.archives.join(',')],
      ['mobileStaticDependencyArchives', mobileContract.dependencies.join(',')],
      ['staticSymbolPrefix', mobileContract.symbolPrefix],
    ]);
    if (mobileContract.symbolAliases !== undefined)
      expectedMobile.set('staticSymbolAliases', mobileContract.symbolAliases.join(','));
    for (const [key, expected] of expectedMobile) {
      if (properties.get(key) !== expected)
        throw inventoryError(
          label,
          `manifest ${key} differs from its declared mobile inventory contract`,
        );
    }
  }

  const allowed = new Set(['manifest.properties']);
  for (const [member, expected] of legal.members) {
    allowed.add(member);
    const entry = entries.get(member);
    if (entry !== undefined) {
      if (entry.mode !== 0o644) {
        throw inventoryError(label, `legal member ${member} must have mode 0644`);
      }
      if (entry.sha256 !== expected.sha256) {
        throw inventoryError(
          label,
          `legal member ${member} does not match canonical bytes from ${expected.source}`,
        );
      }
      if (expected.bytes !== undefined && entry.bytes !== expected.bytes)
        throw inventoryError(label, `legal member ${member} differs from its original byte count`);
    }
  }
  const extensionPrefix = 'files/share/postgresql/extension/';
  let hasControl = false;
  let hasInstallSql = false;
  const extensionFileNames = [];
  for (const name of entries.keys()) {
    if (!name.startsWith(extensionPrefix)) continue;
    const fileName = name.slice(extensionPrefix.length);
    if (fileName.includes('/') || !sqlFileOwned(fileName, metadata)) {
      throw inventoryError(label, `contains undeclared extension SQL/control file ${name}`);
    }
    allowed.add(name);
    extensionFileNames.push(fileName);
    if (fileName === `${metadata.sqlName}.control`) hasControl = true;
    if (isCanonicalExtensionInstallSql(fileName, metadata.sqlName)) hasInstallSql = true;
  }
  if (metadata.createsExtension && (!hasControl || !hasInstallSql)) {
    throw inventoryError(
      label,
      `must contain ${metadata.sqlName}.control and canonical base installation SQL`,
    );
  }
  if (metadata.createsExtension) {
    const controlName = `${extensionPrefix}${metadata.sqlName}.control`;
    validateExtensionInstallSqlReachability({
      sqlName: metadata.sqlName,
      control: decodeUtf8(entries.get(controlName).data, `${label} ${controlName}`),
      fileNames: extensionFileNames,
      label,
    });
  }
  for (const controlFile of metadata.companionControls) {
    const controlName = `${extensionPrefix}${controlFile}`;
    const control = entries.get(controlName);
    if (control === undefined)
      throw inventoryError(label, `missing companion control ${controlName}`);
    validateExtensionInstallSqlReachability({
      sqlName: controlFile.slice(0, -'.control'.length),
      control: decodeUtf8(control.data, `${label} ${controlName}`),
      fileNames: extensionFileNames,
      label,
    });
  }
  for (const dataFile of metadata.dataFiles) {
    allowed.add(`files/share/postgresql/${dataFile}`);
  }
  const modules = new Set(
    (DESKTOP_NATIVE_TARGETS.has(target)
      ? nativeModuleStems
      : metadata.nativeModuleStem === null
        ? []
        : [metadata.nativeModuleStem]
    ).map((stem) => `${stem}${moduleSuffix(target)}`),
  );
  for (const module of modules) {
    allowed.add(`files/lib/postgresql/${module}`);
    if (DESKTOP_NATIVE_TARGETS.has(target)) {
      allowed.add(`files/lib/modules/${module}`);
    }
  }
  if (metadata.nativeModuleStem !== null) {
    for (const dependency of metadata.nativeDependencyModules) {
      allowed.add(`files/lib/postgresql/${dependency}`);
      if (DESKTOP_NATIVE_TARGETS.has(target)) allowed.add(`files/lib/modules/${dependency}`);
    }
  } else if (metadata.nativeDependencyModules.length > 0) {
    throw inventoryError(label, 'SQL-only artifacts must not declare native dependency modules');
  }
  const mobilePaths = declaredMobilePaths(properties, metadata, label);
  if (
    DESKTOP_NATIVE_TARGETS.has(target) &&
    (properties.get('mobilePrebuilt') !== 'no' || mobilePaths.length !== 0)
  ) {
    throw inventoryError(label, 'desktop artifacts must not declare mobile prebuilt files');
  }
  for (const mobilePath of mobilePaths) {
    allowed.add(mobilePath);
  }
  const actual = [...entries.keys()].sort(compareText);
  const expected = [...allowed].sort(compareText);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const undeclared = actual.filter((name) => !allowed.has(name));
    const missing = expected.filter((name) => !entries.has(name));
    throw inventoryError(
      label,
      `leaf inventory mismatch${undeclared.length ? `; undeclared: ${undeclared.join(',')}` : ''}` +
        `${missing.length ? `; missing: ${missing.join(',')}` : ''}`,
    );
  }
  const runtimeFiles = actual
    .filter((name) => name.startsWith('files/'))
    .map((name) => {
      const entry = entries.get(name);
      return {
        path: name.slice('files/'.length),
        bytes: entry.bytes,
        sha256: entry.sha256,
      };
    });
  if (runtimeFiles.some((row) => !SHA256.test(row.sha256))) {
    throw inventoryError(label, 'computed an invalid runtime file digest');
  }
  const legalFiles = [...legal.members.keys()].sort(compareText).map((name) => {
    const entry = entries.get(name);
    return {
      path: name,
      bytes: entry.bytes,
      sha256: entry.sha256,
    };
  });
  return { metadata, properties, runtimeFiles, legalFiles };
}

export function validateExtensionArtifactArchive(options) {
  const entries = readCanonicalExtensionArtifactArchive(
    options.file,
    options.label ?? options.file,
  );
  return {
    entries,
    ...validateExtensionArtifactEntries({
      ...options,
      entries,
      label: options.label ?? options.file,
    }),
  };
}
