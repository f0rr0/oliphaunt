export function parseTagRefs(text) {
  const refs = new Map();
  for (const line of text.split(/\r?\n/u).filter(Boolean)) {
    const match = /^([0-9a-f]{40}) (refs\/tags\/[^\s]+)$/u.exec(line);
    if (!match || refs.has(match[2])) throw new Error('invalid or repeated Git tag reference');
    refs.set(match[2], match[1]);
  }
  return refs;
}

export function parseTagCommits(text) {
  const commits = new Map();
  for (const line of text.split(/\r?\n/u).filter(Boolean)) {
    const [commit, ...parents] = line.trim().split(' ');
    if ([commit, ...parents].some((sha) => !/^[0-9a-f]{40}$/u.test(sha)) || commits.has(commit)) {
      throw new Error('invalid or repeated Git tag commit');
    }
    commits.set(commit, parents);
  }
  return commits;
}
