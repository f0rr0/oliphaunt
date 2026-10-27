import { strict as assert } from 'node:assert';
import test from 'node:test';
import { parseExecutionLog } from './execution-log.mts';

test('decodes Bazel execution records, including multiline JSON and quoted delimiters', () => {
  const records = [
    {
      mnemonic: 'CppCompile',
      targetLabel: '//fixture:alpha',
      commandArgs: ['braces }{ and "quote"'],
    },
    {
      mnemonic: 'TestRunner',
      targetLabel: '//fixture:alpha_test',
      cacheHit: true,
      inputs: [{ path: 'a' }],
    },
  ];
  assert.deepEqual(
    parseExecutionLog(records.map((record) => JSON.stringify(record, null, 2)).join('\n')),
    records,
  );
  assert.deepEqual(parseExecutionLog(' \n'), []);
});

test('rejects malformed and truncated execution evidence', () => {
  for (const value of ['[]', '{"mnemonic":', '{} garbage', '{"value":"unterminated']) {
    assert.throws(() => parseExecutionLog(value));
  }
});
