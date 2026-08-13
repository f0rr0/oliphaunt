import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { findPackageManifest, sha256, stableJson } from './plan.mjs';

const DEPENDENCY_FIELDS = [
  ['dependencies', true],
  ['optionalDependencies', false],
  ['peerDependencies', false],
];

export async function installedPackageClosure(entry, expectedName) {
  const rootPackage = await installedPackage(entry, expectedName);
  const pending = [rootPackage];
  const packagesByDirectory = new Map();

  while (pending.length > 0) {
    const current = pending.shift();
    if (packagesByDirectory.has(current.directory)) continue;
    packagesByDirectory.set(current.directory, current);
    const dependencies = declaredDependencies(current.manifest);
    const require = createRequire(current.manifestFile);
    for (const dependency of dependencies) {
      let dependencyEntry;
      try {
        dependencyEntry = require.resolve(dependency.name);
      } catch (error) {
        if (!dependency.required && error?.code === 'MODULE_NOT_FOUND') {
          dependency.installed = false;
          continue;
        }
        throw new Error(
          `${current.manifest.name}@${current.manifest.version} cannot resolve installed dependency ${dependency.name}`,
          { cause: error },
        );
      }
      const installed = await installedPackage(dependencyEntry, dependency.name);
      dependency.installed = true;
      dependency.targetDirectory = installed.directory;
      pending.push(installed);
    }
    current.dependencies = dependencies;
  }

  for (const current of packagesByDirectory.values()) {
    current.treeSha256 = await directoryTreeSha256(current.directory);
    current.id = packageId(current.manifest, current.treeSha256);
  }
  const packages = [...packagesByDirectory.values()]
    .map((current) => ({
      id: current.id,
      name: current.manifest.name,
      version: current.manifest.version,
      installedTreeSha256: current.treeSha256,
      dependencies: current.dependencies.map((dependency) => ({
        name: dependency.name,
        specifier: dependency.specifier,
        kinds: dependency.kinds,
        installed: dependency.installed,
        target:
          dependency.targetDirectory === undefined
            ? null
            : packagesByDirectory.get(dependency.targetDirectory).id,
      })),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const root = packages.find((candidate) => candidate.id === rootPackage.id);
  if (root === undefined) throw new Error(`installed closure lost root package ${expectedName}`);
  return {
    schema: 'oliphaunt-installed-node-package-closure-v1',
    treeHashSchema: 'oliphaunt-path-size-content-sha256-v1',
    root: root.id,
    sha256: sha256(stableJson(packages)),
    packages,
  };
}

export async function directoryTreeSha256(root) {
  const hash = createHash('sha256');
  await visit(await realpath(root), '');
  return hash.digest('hex');

  async function visit(directory, prefix) {
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      const absolute = resolve(directory, name);
      const child = prefix === '' ? name : `${prefix}/${name}`;
      const stats = await lstat(absolute);
      if (stats.isDirectory()) {
        hash.update(`d ${child}\n`);
        await visit(absolute, child);
      } else if (stats.isSymbolicLink()) {
        hash.update(`l ${child} ${await readlink(absolute)}\n`);
      } else if (stats.isFile()) {
        hash.update(`f ${child} ${stats.size}\n`);
        hash.update(await readFile(absolute));
        hash.update('\n');
      } else {
        throw new Error(`unsupported installed package member ${absolute}`);
      }
    }
  }
}

async function installedPackage(entry, expectedName) {
  const { file: manifestFile, manifest } = await findPackageManifest(entry, expectedName);
  if (
    typeof manifest.name !== 'string' ||
    typeof manifest.version !== 'string' ||
    manifest.name !== expectedName
  ) {
    throw new Error(`installed package from ${entry} has an invalid ${expectedName} identity`);
  }
  return {
    directory: await realpath(resolve(manifestFile, '..')),
    manifestFile: await realpath(manifestFile),
    manifest,
  };
}

function declaredDependencies(manifest) {
  const dependencies = new Map();
  for (const [field, required] of DEPENDENCY_FIELDS) {
    for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
      const existing = dependencies.get(name) ?? {
        name,
        specifier,
        kinds: [],
        required: false,
      };
      if (existing.specifier !== specifier) {
        throw new Error(
          `${manifest.name}@${manifest.version} declares conflicting ${name} dependency specifiers`,
        );
      }
      existing.kinds.push(field);
      existing.required ||= required;
      dependencies.set(name, existing);
    }
  }
  return [...dependencies.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function packageId(manifest, treeSha256) {
  return `${manifest.name}@${manifest.version}#${treeSha256.slice(0, 16)}`;
}
