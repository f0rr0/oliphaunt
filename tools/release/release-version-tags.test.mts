import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { validateVersionTags } from './check_release_versions.mts';
import { parseTagCommits, parseTagRefs } from './git-tag-state.mts';

test('real Git snapshots preserve nested tags, reject reused versions and bind Swift source parents', () => {
  const root = process.env.TEST_TAG_ROOT;
  if (!root) throw new Error('run release-version-tags.test.sh to capture actual Git observations');
  const first = readFileSync(path.join(root, 'first'), 'utf8').trim();
  const headCommit = readFileSync(path.join(root, 'expected-head'), 'utf8').trim();
  const state = {
    headCommit: readFileSync(path.join(root, 'head'), 'utf8'),
    refs: parseTagRefs(readFileSync(path.join(root, 'refs'), 'utf8')),
    commits: parseTagCommits(readFileSync(path.join(root, 'commits'), 'utf8')),
  };
  expect(state.headCommit).toBe(headCommit);
  expect(readFileSync(path.join(root, 'contrib'), 'utf8').split('\0')).toEqual([
    'liboliphaunt-native-v0.1.0',
    'false',
    'liboliphaunt-native-v0.2.0',
    'true',
    '',
  ]);
  expect(validateVersionTags('product', '0.2.0', { tag_prefix: 'product-v' }, state)).toBe(true);
  expect(validateVersionTags('product', '0.4.0', { tag_prefix: 'product-v' }, state)).toBe(false);
  expect(() => validateVersionTags('product', '0.1.5', { tag_prefix: 'product-v' }, state)).toThrow(
    'not newer',
  );
  expect(() =>
    validateVersionTags(
      'product',
      '0.2.0',
      { tag_prefix: 'product-v' },
      { ...state, headCommit: first },
    ),
  ).toThrow('not exact release commit');
  expect(() => validateVersionTags('product', '0.3.0', { tag_prefix: 'product-v' }, state)).toThrow(
    'not exact release commit',
  );
  expect(
    validateVersionTags('oliphaunt-swift', '0.7.0', { tag_prefix: 'oliphaunt-swift-v' }, state),
  ).toBe(true);
  const wrongParent = {
    ...state,
    headCommit: first,
    refs: new Map(state.refs).set('refs/tags/oliphaunt-swift-v0.7.0', first),
  };
  expect(() =>
    validateVersionTags(
      'oliphaunt-swift',
      '0.7.0',
      { tag_prefix: 'oliphaunt-swift-v' },
      wrongParent,
    ),
  ).toThrow('source parent');
  expect(() => parseTagCommits(`${headCommit}\n${headCommit}\n`)).toThrow('repeated');
  expect(() => parseTagCommits('invalid')).toThrow('invalid');
});
