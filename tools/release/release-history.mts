import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function pairs(file) {
  const fields = readFileSync(file, 'utf8').split('\0');
  fields.pop();
  const result = new Map();
  for (let index = 0; index < fields.length; index += 2)
    result.set(fields[index], fields[index + 1]);
  return result;
}
function history(root) {
  const directory = process.env.OLIPHAUNT_PRODUCT_HISTORY;
  if (!directory) throw new Error('run through with-product-history.sh');
  const [source, ref, commit] = readFileSync(path.join(directory, 'context'), 'utf8').split('\0');
  if (source !== realpathSync(root))
    throw new Error('product history belongs to another repository');
  return { directory, ref, commit };
}
export function historyCommit(root, ref, { check = true } = {}) {
  const { directory } = history(root);
  const refs = pairs(path.join(directory, 'refs'));
  if (!refs.has(ref)) throw new Error('product history does not include ref ' + ref);
  const commit = refs.get(ref);
  if (!commit && check) throw new Error('could not resolve product ref ' + ref);
  return commit || null;
}
function atHead(root, ref) {
  const state = history(root);
  if (historyCommit(root, ref) !== state.commit)
    throw new Error('product history belongs to another head');
  return state.directory;
}
export function historyLatestTag(root, prefix, head) {
  const tags = pairs(path.join(atHead(root, head), 'latest'));
  if (!tags.has(prefix)) throw new Error('product history does not include tag prefix ' + prefix);
  return tags.get(prefix);
}
export function historyChanges(root, base, head) {
  const directory = atHead(root, head);
  return readFileSync(path.join(directory, 'changes', historyCommit(root, base)), 'utf8')
    .split('\0')
    .filter(Boolean);
}
function safePath(file) {
  if (
    path.isAbsolute(file) ||
    file.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('unsafe historical product path ' + file);
  return file;
}

function packagePaths(config) {
  const result = new Map();
  for (const [directory, entry] of Object.entries(config.packages ?? {})) {
    if (directory !== '.') safePath(directory);
    if (typeof entry.component !== 'string' || !entry.component)
      throw new Error('historical release package has no component: ' + directory);
    if (result.has(entry.component))
      throw new Error('duplicate historical release component: ' + entry.component);
    result.set(entry.component, directory);
  }
  return result;
}

function mappedPath(directory, stage, file) {
  const current = packagePaths(
    JSON.parse(readFileSync(path.join(directory, 'current-config'), 'utf8')),
  );
  const owner = [...current]
    .sort((a, b) => b[1].length - a[1].length)
    .find(([, folder]) => folder === '.' || file === folder || file.startsWith(folder + '/'));
  if (!owner) return file;
  const configFile = path.join(stage, 'blobs', 'release-please-config.json');
  if (!existsSync(configFile)) throw new Error('missing historical release-please-config.json');
  const old = packagePaths(JSON.parse(readFileSync(configFile, 'utf8'))).get(owner[0]);
  if (old === undefined) return null;
  const suffix = owner[1] === '.' ? file : file.slice(owner[1].length).replace(/^\//u, '');
  return old === '.' ? suffix : suffix ? old + '/' + suffix : old;
}

export function historyManifest(root, ref) {
  const { directory } = history(root);
  const stage = path.join(directory, 'trees', historyCommit(root, ref));
  const manifest = JSON.parse(historyFile(root, ref, '.release-please-manifest.json'));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
    throw new Error('invalid historical release manifest');
  const current = packagePaths(
    JSON.parse(readFileSync(path.join(directory, 'current-config'), 'utf8')),
  );
  if (current.size === 0) return manifest;
  const configFile = path.join(stage, 'blobs', 'release-please-config.json');
  if (!existsSync(configFile)) throw new Error('missing historical release-please-config.json');
  const old = packagePaths(JSON.parse(readFileSync(configFile, 'utf8')));
  return Object.fromEntries(
    [...current].flatMap(([component, folder]) =>
      old.has(component) ? [[folder, manifest[old.get(component)]]] : [],
    ),
  );
}

export function historyFile(root, ref, file) {
  safePath(file);
  const { directory } = history(root);
  const stage = path.join(directory, 'trees', historyCommit(root, ref));
  const mapped =
    file === 'release-please-config.json' || file === '.release-please-manifest.json'
      ? file
      : mappedPath(directory, stage, file);
  if (mapped === null) return null;
  const location = path.join(stage, 'blobs', safePath(mapped));
  if (mapped !== file && !existsSync(location))
    throw new Error(`missing historical product file ${mapped} (current path ${file})`);
  return existsSync(location) ? readFileSync(location, 'utf8') : null;
}
export function historyAncestor(root, commit, head) {
  return readFileSync(path.join(atHead(root, head), 'ancestors'), 'utf8')
    .split('\n')
    .includes(commit);
}

if (import.meta.main) {
  const [mode] = process.argv.slice(2);
  const directory = process.env.OLIPHAUNT_PRODUCT_HISTORY;
  if (!directory) throw new Error('missing product history destination');
  if (mode === 'files') {
    const wanted = new Set(
      readFileSync(path.join(directory, 'wanted-files'), 'utf8').split('\0').filter(Boolean),
    );
    for (const commit of readdirSync(path.join(directory, 'trees'))) {
      const stage = path.join(directory, 'trees', commit);
      const selected = new Set(
        [...wanted].flatMap((file) => {
          const mapped =
            file === 'release-please-config.json' || file === '.release-please-manifest.json'
              ? file
              : mappedPath(directory, stage, file);
          return mapped === null ? [] : [mapped];
        }),
      );
      const files = readFileSync(path.join(stage, 'files'), 'utf8')
        .split('\0')
        .filter((file) => selected.has(file));
      writeFileSync(path.join(stage, 'selected'), files.map((file) => file + '\0').join(''));
    }
  } else throw new Error('usage: release-history.mts files');
}
