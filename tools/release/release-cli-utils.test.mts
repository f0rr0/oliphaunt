import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uniqueValueFlag } from './release-cli-utils.mts';

test('release CLI value flags reject ambiguous duplicate identities', () => {
  assert.equal(uniqueValueFlag(['--head-ref', 'a'.repeat(40)], '--head-ref'), 'a'.repeat(40));
  assert.equal(uniqueValueFlag(['--products-json=["sdk"]'], '--products-json'), '["sdk"]');
  assert.throws(
    () =>
      uniqueValueFlag(['--head-ref', 'a'.repeat(40), `--head-ref=${'b'.repeat(40)}`], '--head-ref'),
    /--head-ref must be provided at most once/u,
  );
  assert.throws(
    () =>
      uniqueValueFlag(
        ['--products-json=["sdk"]', '--products-json', '["extension"]'],
        '--products-json',
      ),
    /--products-json must be provided at most once/u,
  );
  assert.throws(
    () => uniqueValueFlag(['--head-ref', `--head-ref=${'b'.repeat(40)}`], '--head-ref'),
    /--head-ref must be provided at most once/u,
  );
  assert.throws(
    () => uniqueValueFlag(['--head-ref'], '--head-ref'),
    /--head-ref requires a value/u,
  );
});
