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
export function historyFile(root, ref, file) {
  if (
    path.isAbsolute(file) ||
    file.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('unsafe historical product path ' + file);
  const location = path.join(
    history(root).directory,
    'trees',
    historyCommit(root, ref),
    'blobs',
    file,
  );
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
      const files = readFileSync(path.join(stage, 'files'), 'utf8')
        .split('\0')
        .filter((file) => wanted.has(file));
      writeFileSync(path.join(stage, 'selected'), files.map((file) => file + '\0').join(''));
    }
  } else throw new Error('usage: release-history.mts files');
}
