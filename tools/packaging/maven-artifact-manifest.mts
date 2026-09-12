import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
const ROOT = path.resolve(import.meta.dir, '../..');
function error(message) {
  return new Error('maven-artifact-manifest: ' + message);
}
const TOKEN = /^[A-Za-z0-9_.-]+$/u;
const GROUP_SEGMENT = /^[A-Za-z0-9_-]+$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
function relative(file) {
  const value = path.relative(ROOT, file);
  return value.startsWith('..') || path.isAbsolute(value)
    ? file.split(path.sep).join('/')
    : value.split(path.sep).join('/');
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0 || CONTROL.test(value)) {
    throw error(`${label} must be non-empty text without control characters`);
  }
  return value;
}

function token(value, label) {
  requiredText(value, label);
  if (!TOKEN.test(value) || value === '.' || value === '..') {
    throw error(`${label} must be a portable non-dot Maven coordinate token`);
  }
  return value;
}

function mavenGroupId(value, label) {
  requiredText(value, label);
  const segments = value.split('.');
  if (segments.some((segment) => !GROUP_SEGMENT.test(segment))) {
    throw error(`${label} must contain non-empty dot-separated portable Maven coordinate segments`);
  }
  return value;
}

function parseLicenses(raw, label) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw error(`${label} must be valid JSON: ${cause.message}`);
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw error(`${label} must be a non-empty JSON array`);
  }
  for (const [index, license] of value.entries()) {
    const entry = `${label} entry ${index + 1}`;
    if (
      license === null ||
      Array.isArray(license) ||
      typeof license !== 'object' ||
      JSON.stringify(Object.keys(license).sort()) !==
        JSON.stringify(['distribution', 'name', 'url'])
    ) {
      throw error(`${entry} must contain exactly name, url, distribution`);
    }
    requiredText(license.name, `${entry}.name`);
    const url = requiredText(license.url, `${entry}.url`);
    if (!url.startsWith('https://')) throw error(`${entry}.url must use HTTPS`);
    if (license.distribution !== 'repo') throw error(`${entry}.distribution must be repo`);
  }
  return value;
}

function requireArtifact(file, label) {
  let metadata;
  try {
    metadata = lstatSync(file);
  } catch (cause) {
    throw error(`${label} is missing: ${cause.message}`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0) {
    throw error(`${label} must be a non-empty regular non-symlink file`);
  }
}

export function parseMavenArtifactManifest(file) {
  requireArtifact(file, `${relative(file)} Maven artifact manifest`);
  const rows = readFileSync(file, 'utf8')
    .split(/\r?\n/u)
    .filter((line) => line.length > 0);
  if (rows.length === 0) throw error(`${relative(file)} Maven artifact manifest is empty`);
  const coordinates = new Set();
  return rows.map((line, index) => {
    const label = `${relative(file)} line ${index + 1}`;
    const fields = line.split('\t');
    if (fields.length !== 10) throw error(`${label} must contain exactly ten tab-separated fields`);
    const [
      groupId,
      artifactId,
      version,
      rawArtifact,
      name,
      description,
      runtimeProduct,
      runtimeVersion,
      licenseSpdx,
      licensesJson,
    ] = fields;
    mavenGroupId(groupId, `${label} groupId`);
    token(artifactId, `${label} artifactId`);
    token(version, `${label} version`);
    const coordinate = `${groupId}:${artifactId}:${version}`;
    if (coordinates.has(coordinate)) throw error(`${label} repeats Maven coordinate ${coordinate}`);
    coordinates.add(coordinate);
    requiredText(rawArtifact, `${label} artifact path`);
    if (!rawArtifact.endsWith('.tar.gz'))
      throw error(`${label} artifact must be a .tar.gz payload`);
    const artifact = path.isAbsolute(rawArtifact) ? rawArtifact : path.resolve(ROOT, rawArtifact);
    requireArtifact(artifact, `${label} artifact ${relative(artifact)}`);
    requiredText(name, `${label} name`);
    requiredText(description, `${label} description`);
    if ((runtimeProduct.length === 0) !== (runtimeVersion.length === 0)) {
      throw error(`${label} must declare both runtime product and version or neither`);
    }
    if (runtimeProduct.length > 0) {
      token(runtimeProduct, `${label} runtime product`);
      token(runtimeVersion, `${label} runtime version`);
    }
    if (
      groupId === 'dev.oliphaunt.extensions' &&
      (runtimeProduct !== 'liboliphaunt-native' ||
        !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(runtimeVersion))
    ) {
      throw error(
        label + ' extension carrier must bind an exact stable liboliphaunt-native runtime version',
      );
    }
    requiredText(licenseSpdx, `${label} SPDX expression`);
    const licenses = parseLicenses(licensesJson, `${label} licenses`);
    return Object.freeze({
      artifact,
      artifactId,
      description,
      groupId,
      licenses,
      licenseSpdx,
      name,
      runtimeProduct: runtimeProduct || null,
      runtimeVersion: runtimeVersion || null,
      version,
    });
  });
}
