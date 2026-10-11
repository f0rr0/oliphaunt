import { readFileSync } from 'node:fs';
import path from 'node:path';

const fullSha = /^[0-9a-f]{40}$/;

export interface CapturedCommitHistory {
  head: string;
  commits: ReadonlySet<string>;
  after(boundary?: string): ReadonlySet<string>;
}

/** Git ancestry, captured with changed paths; API ordering is not a release boundary. */
export function readCommitHistory(
  directory = process.env.OLIPHAUNT_COMMIT_PATHS,
): CapturedCommitHistory {
  if (!directory) throw new Error('commit history requires a captured history directory');
  const content = readFileSync(path.join(directory, '.parents'), 'utf8');
  if (!content.endsWith('\n')) throw new Error('incomplete captured commit ancestry');
  const [header, ...lines] = content.slice(0, -1).split('\n');
  const head = header?.slice('head '.length);
  if (!header?.startsWith('head ') || !head || !fullSha.test(head))
    throw new Error('commit ancestry requires an exact head SHA');
  const parents = new Map<string, string[]>();
  for (const line of lines) {
    const [sha, ...ancestors] = line.split(' ');
    if (!sha || !fullSha.test(sha) || ancestors.some((parent) => !fullSha.test(parent)))
      throw new Error('invalid captured commit ancestry');
    if (parents.has(sha)) throw new Error(`duplicate captured ancestry for ${sha}`);
    parents.set(sha, ancestors);
  }
  const ancestorsOf = (boundary: string) => {
    const result = new Set<string>();
    const pending = [boundary];
    while (pending.length) {
      const sha = pending.pop() as string;
      if (result.has(sha)) continue;
      const ancestors = parents.get(sha);
      if (!ancestors) throw new Error(`captured ancestry is missing ${sha}`);
      result.add(sha);
      pending.push(...ancestors);
    }
    return result;
  };
  if (ancestorsOf(head).size !== parents.size)
    throw new Error('captured ancestry includes commits outside its head');
  const commits = new Set(parents.keys());
  const cache = new Map<string, ReadonlySet<string>>();
  return {
    head,
    commits,
    after(boundary) {
      if (boundary === undefined) return commits;
      if (!cache.has(boundary)) {
        const delivered = ancestorsOf(boundary);
        cache.set(boundary, new Set([...commits].filter((sha) => !delivered.has(sha))));
      }
      return cache.get(boundary) as ReadonlySet<string>;
    },
  };
}

/** Read immutable changed paths captured once by snapshot-commit-paths.sh. */
export function readCommitPaths(
  sha: string,
  directory = process.env.OLIPHAUNT_COMMIT_PATHS,
): string[] {
  if (!fullSha.test(sha) || !directory) {
    throw new Error('commit paths require an exact SHA and captured history directory');
  }
  const content = readFileSync(path.join(directory, sha), 'utf8');
  if (!content) return [];
  if (!content.endsWith('\0')) throw new Error(`incomplete captured commit paths for ${sha}`);
  const files = content.slice(0, -1).split('\0');
  for (const file of files) {
    if (
      !file ||
      file.startsWith('/') ||
      file.split('/').some((part) => part === '..' || part === '.')
    ) {
      throw new Error(`unsafe captured commit path for ${sha}`);
    }
  }
  if (new Set(files).size !== files.length)
    throw new Error(`duplicate captured commit paths for ${sha}`);
  return files;
}
