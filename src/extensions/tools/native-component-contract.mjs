#!/usr/bin/env bun

import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { loadExtensionTargetProfiles } from '../../../tools/release/extension-target-profiles.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const NATIVE_COMPONENT_CONTRACT_PATH = path.join(
  ROOT,
  'src/extensions/catalog/native-components.toml',
);
const EXTENSION_CATALOG_PATH = path.join(ROOT, 'src/extensions/catalog/extensions.source.json');
const ID = /^[a-z][a-z0-9_-]*$/u;
const ALLOWED_COMPONENT_KEYS = new Set([
  'id',
  'source',
  'source-path',
  'depends-on',
  'runtime-files',
  'link-units',
]);
const ALLOWED_LINK_UNIT_KEYS = new Set(['id', 'archive-candidates']);
const ALLOWED_REQUIREMENT_KEYS = new Set(['extension', 'family', 'kind', 'targets', 'roots']);

function fail(message) {
  throw new Error(`native component contract: ${message}`);
}

function object(value, label) {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    fail(`${label} must be a table`);
  }
  return value;
}

function exactKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) {
    fail(`${label} has unknown fields: ${unknown.join(', ')}`);
  }
}

function portableId(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) {
    fail(`${label} must match ${ID}`);
  }
  return value;
}

function relativePath(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.includes('\\')
    || path.posix.isAbsolute(value)
    || value.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    fail(`${label} must be a canonical repository-relative path`);
  }
  return value;
}

function uniqueList(value, label, itemValidator = portableId) {
  if (!Array.isArray(value)) {
    fail(`${label} must be an array`);
  }
  const result = value.map((item, index) => itemValidator(item, `${label}[${index}]`));
  if (new Set(result).size !== result.length) {
    fail(`${label} must not contain duplicates`);
  }
  return result;
}

function targetProfiles() {
  try {
    const rows = loadExtensionTargetProfiles().targets;
    return new Map(rows.map((row) => [row.target, `${row.family}\0${row.kind}`]));
  } catch (error) {
    fail(`cannot read target profiles: ${error.message}`);
  }
}

function publicExtensionNames() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(EXTENSION_CATALOG_PATH, 'utf8'));
  } catch (error) {
    fail(`cannot read canonical extension catalog: ${error.message}`);
  }
  object(parsed, 'canonical extension catalog');
  if (parsed['format-version'] !== 1 || !Array.isArray(parsed.extensions)) {
    fail('canonical extension catalog must use format-version 1 and define extensions');
  }
  const names = new Set();
  for (const [index, row] of parsed.extensions.entries()) {
    object(row, `canonical extension catalog extensions[${index}]`);
    const name = portableId(row['sql-name'], `canonical extension catalog extensions[${index}].sql-name`);
    if (names.has(name)) fail(`canonical extension catalog repeats ${name}`);
    names.add(name);
  }
  return names;
}

function normalizeComponent(row, index, linkUnitOwners) {
  object(row, `components[${index}]`);
  exactKeys(row, ALLOWED_COMPONENT_KEYS, `components[${index}]`);
  const id = portableId(row.id, `components[${index}].id`);
  const source = row.source === undefined ? null : portableId(row.source, `component ${id} source`);
  const sourcePath = row['source-path'] === undefined
    ? null
    : relativePath(row['source-path'], `component ${id} source-path`);
  if ((source === null) === (sourcePath === null)) {
    fail(`component ${id} must define exactly one of source or source-path`);
  }
  const linkUnits = (row['link-units'] ?? []).map((unit, unitIndex) => {
    object(unit, `component ${id} link-units[${unitIndex}]`);
    exactKeys(unit, ALLOWED_LINK_UNIT_KEYS, `component ${id} link-units[${unitIndex}]`);
    const unitId = portableId(unit.id, `component ${id} link-units[${unitIndex}].id`);
    const owner = linkUnitOwners.get(unitId);
    if (owner !== undefined) {
      fail(`link unit ${unitId} is owned by both ${owner} and ${id}`);
    }
    linkUnitOwners.set(unitId, id);
    return {
      id: unitId,
      archiveCandidates: uniqueList(
        unit['archive-candidates'],
        `component ${id} link unit ${unitId} archive-candidates`,
        relativePath,
      ),
    };
  });
  if (linkUnits.length === 0) {
    fail(`component ${id} must declare at least one link unit`);
  }
  return {
    id,
    source,
    sourcePath,
    dependsOn: uniqueList(row['depends-on'], `component ${id} depends-on`),
    runtimeFiles: uniqueList(row['runtime-files'], `component ${id} runtime-files`, relativePath),
    linkUnits,
  };
}

function validateAcyclic(componentsById) {
  const visiting = new Set();
  const visited = new Set();
  const visit = (id, trail) => {
    if (visiting.has(id)) {
      fail(`component dependency cycle: ${[...trail, id].join(' -> ')}`);
    }
    if (visited.has(id)) return;
    visiting.add(id);
    const component = componentsById.get(id);
    for (const dependency of component.dependsOn) {
      if (!componentsById.has(dependency)) {
        fail(`component ${id} depends on unknown component ${dependency}`);
      }
      visit(dependency, [...trail, id]);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of componentsById.keys()) visit(id, []);
}

export function validateNativeComponentContract(raw, options = {}) {
  object(raw, 'root');
  const allowedRootKeys = new Set(['schema', 'components', 'requirements']);
  exactKeys(raw, allowedRootKeys, 'root');
  if (raw.schema !== 'oliphaunt-native-components-v1') {
    fail('schema must be oliphaunt-native-components-v1');
  }
  if (!Array.isArray(raw.components) || raw.components.length === 0) {
    fail('components must be a non-empty array');
  }
  if (!Array.isArray(raw.requirements)) {
    fail('requirements must be an array');
  }

  const linkUnitOwners = new Map();
  const archiveCandidateOwners = new Map();
  const components = raw.components.map((row, index) => normalizeComponent(row, index, linkUnitOwners));
  const componentsById = new Map();
  for (const component of components) {
    if (componentsById.has(component.id)) fail(`duplicate component ${component.id}`);
    componentsById.set(component.id, component);
    if (component.sourcePath !== null && options.checkSourcePaths !== false) {
      const absolute = path.join(options.root ?? ROOT, component.sourcePath);
      try {
        if (!statSync(absolute).isDirectory()) {
          fail(`component ${component.id} source-path must be a directory: ${component.sourcePath}`);
        }
      } catch (error) {
        if (error.message.startsWith('native component contract:')) throw error;
        fail(`component ${component.id} source-path does not exist: ${component.sourcePath}`);
      }
    }
    for (const linkUnit of component.linkUnits) {
      for (const candidate of linkUnit.archiveCandidates) {
        const owner = archiveCandidateOwners.get(candidate);
        if (owner !== undefined) {
          fail(`archive candidate ${candidate} is owned by both ${owner} and ${linkUnit.id}`);
        }
        archiveCandidateOwners.set(candidate, linkUnit.id);
      }
    }
  }
  validateAcyclic(componentsById);

  const profiles = options.targetProfiles ?? targetProfiles();
  const knownExtensions = options.knownExtensions ?? publicExtensionNames();
  const requirementKeys = new Set();
  const requirements = raw.requirements.map((row, index) => {
    object(row, `requirements[${index}]`);
    exactKeys(row, ALLOWED_REQUIREMENT_KEYS, `requirements[${index}]`);
    const extension = portableId(row.extension, `requirements[${index}].extension`);
    if (!knownExtensions.has(extension)) {
      fail(`requirements[${index}] references unknown catalog extension ${extension}`);
    }
    const family = portableId(row.family, `requirement ${extension} family`);
    const kind = portableId(row.kind, `requirement ${extension} kind`);
    const targets = uniqueList(row.targets, `requirement ${extension} targets`);
    const roots = uniqueList(row.roots, `requirement ${extension} roots`);
    if (targets.length === 0 || roots.length === 0) {
      fail(`requirement ${extension}/${family}/${kind} must declare targets and roots`);
    }
    for (const root of roots) {
      if (!componentsById.has(root)) {
        fail(`requirement ${extension}/${family}/${kind} references unknown root ${root}`);
      }
    }
    for (const target of targets) {
      const expectedIdentity = profiles.get(target);
      if (expectedIdentity === undefined) {
        fail(`requirement ${extension}/${family}/${kind} uses unknown target ${target}`);
      }
      if (expectedIdentity !== `${family}\0${kind}`) {
        fail(`requirement ${extension}/${family}/${kind} conflicts with target profile ${target}`);
      }
      const key = `${extension}\0${family}\0${kind}\0${target}`;
      if (requirementKeys.has(key)) {
        fail(`duplicate requirement for ${extension}/${family}/${kind}/${target}`);
      }
      requirementKeys.add(key);
    }
    return { extension, family, kind, targets, roots };
  });
  return {
    schema: raw.schema,
    components,
    requirements,
    componentsById,
    linkUnitOwners,
    targetProfiles: profiles,
    knownExtensions,
  };
}

export function loadNativeComponentContract(file = NATIVE_COMPONENT_CONTRACT_PATH) {
  let raw;
  try {
    raw = Bun.TOML.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`cannot read ${path.relative(ROOT, file)}: ${error.message}`);
  }
  return validateNativeComponentContract(raw);
}

export function resolveNativeComponentClosure(contract, query) {
  const extension = portableId(query.extension, 'query extension');
  if (!contract.knownExtensions.has(extension)) fail(`query uses unknown catalog extension ${extension}`);
  const family = portableId(query.family, 'query family');
  const kind = portableId(query.kind, 'query kind');
  const target = portableId(query.target, 'query target');
  const targetIdentity = contract.targetProfiles.get(target);
  if (targetIdentity === undefined) fail(`query uses unknown target ${target}`);
  if (targetIdentity !== `${family}\0${kind}`) {
    fail(`query ${family}/${kind} conflicts with target profile ${target}`);
  }
  const matches = contract.requirements.filter(
    (row) => row.extension === extension
      && row.family === family
      && row.kind === kind
      && row.targets.includes(target),
  );
  if (matches.length > 1) fail(`ambiguous requirement for ${extension}/${family}/${kind}/${target}`);
  const roots = matches[0]?.roots ?? [];
  const buildOrder = [];
  const built = new Set();
  const addBuild = (id) => {
    if (built.has(id)) return;
    const component = contract.componentsById.get(id);
    for (const dependency of component.dependsOn) addBuild(dependency);
    built.add(id);
    buildOrder.push(id);
  };
  for (const root of roots) addBuild(root);

  const linkOrder = [];
  const linkedComponents = new Set();
  const addLink = (id) => {
    if (linkedComponents.has(id)) return;
    linkedComponents.add(id);
    const component = contract.componentsById.get(id);
    linkOrder.push(...component.linkUnits.map((unit) => unit.id));
    for (const dependency of component.dependsOn) addLink(dependency);
  };
  for (const root of roots) addLink(root);

  const closure = buildOrder.map((id) => contract.componentsById.get(id));
  return {
    extension,
    family,
    kind,
    target,
    roots: [...roots],
    components: buildOrder,
    sources: [...new Set(closure.map((component) => component.source).filter(Boolean))].sort(),
    sourcePaths: [...new Set(closure.map((component) => component.sourcePath).filter(Boolean))].sort(),
    linkUnits: linkOrder,
    runtimeFiles: [...new Set(closure.flatMap((component) => component.runtimeFiles))].sort(),
  };
}

export function nativeComponentInventory(contract = loadNativeComponentContract()) {
  const resolutions = contract.requirements.flatMap((requirement) =>
    requirement.targets.map((target) => resolveNativeComponentClosure(contract, { ...requirement, target }))
  );
  resolutions.sort((left, right) =>
    left.extension.localeCompare(right.extension)
      || left.family.localeCompare(right.family)
      || left.kind.localeCompare(right.kind)
      || left.target.localeCompare(right.target)
  );
  return {
    schema: contract.schema,
    components: contract.components.map(({ id, source, sourcePath, dependsOn, runtimeFiles, linkUnits }) => ({
      id,
      source,
      sourcePath,
      dependsOn,
      runtimeFiles,
      linkUnits,
    })),
    resolutions,
  };
}

function printLines(values) {
  if (values.length > 0) process.stdout.write(`${values.join('\n')}\n`);
}

function usage() {
  fail(
    'usage: native-component-contract.mjs '
      + '<check|inventory|resolve <extension> <family> <kind> <target>|'
      + 'field <extension> <family> <kind> <target> <components|sources|sourcePaths|linkUnits|runtimeFiles>|'
      + 'archive-candidates <link-unit>>',
  );
}

async function main(argv) {
  const [command, ...args] = argv;
  const contract = loadNativeComponentContract();
  if (command === 'check' && args.length === 0) {
    console.log('native component contract checks passed');
    return;
  }
  if (command === 'inventory' && args.length === 0) {
    console.log(JSON.stringify(nativeComponentInventory(contract), null, 2));
    return;
  }
  if ((command === 'resolve' || command === 'field') && args.length >= 4) {
    const closure = resolveNativeComponentClosure(contract, {
      extension: args[0],
      family: args[1],
      kind: args[2],
      target: args[3],
    });
    if (command === 'resolve' && args.length === 4) {
      console.log(JSON.stringify(closure, null, 2));
      return;
    }
    if (command === 'field' && args.length === 5 && Array.isArray(closure[args[4]])) {
      printLines(closure[args[4]]);
      return;
    }
  }
  if (command === 'archive-candidates' && args.length === 1) {
    const owner = contract.linkUnitOwners.get(args[0]);
    if (owner === undefined) fail(`unknown link unit ${args[0]}`);
    const component = contract.componentsById.get(owner);
    printLines(component.linkUnits.find((unit) => unit.id === args[0]).archiveCandidates);
    return;
  }
  usage();
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(2);
  });
}
