import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {runInNewContext} from 'node:vm';

const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
assert.match(source, /const CAPTURED_OUTPUT_LIMIT_BYTES = 67_108_864;/u);
const start = source.indexOf('function createCapturedOutput()');
const end = source.indexOf('function resolveRuntime()', start);
assert(start >= 0 && end > start);
const {createCapturedOutput, captureOutput, concatenateCapture} = runInNewContext(
  `${source.slice(start, end)}\n({createCapturedOutput, captureOutput, concatenateCapture})`,
  {Buffer, CAPTURED_OUTPUT_LIMIT_BYTES: 7},
);

test('stdout and stderr share an inclusive limit and preserve exact bytes', () => {
  const captured = createCapturedOutput();
  captureOutput(captured, 'stdout', Buffer.from([0, 255]));
  captureOutput(captured, 'stdout', Buffer.from('a'));
  captureOutput(captured, 'stderr', Buffer.from('err!'));
  assert.equal(captured.overflowed, false);
  assert.equal(captured.retainedBytes, 7);
  assert.deepEqual(concatenateCapture(captured.stdout, captured.stdoutBytes), Buffer.from([0, 255, 97]));
  assert.equal(concatenateCapture(captured.stderr, captured.stderrBytes).toString(), 'err!');
});

test('aggregate overflow discards both prefixes and ignores later chunks', () => {
  const captured = createCapturedOutput();
  captureOutput(captured, 'stdout', Buffer.from('abcd'));
  captureOutput(captured, 'stderr', Buffer.from('efgh'));
  captureOutput(captured, 'stdout', Buffer.from('later'));
  assert.equal(captured.overflowed, true);
  assert.equal(captured.retainedBytes, 0);
  assert.equal(captured.stdoutBytes, 0);
  assert.equal(captured.stderrBytes, 0);
  assert.equal(captured.stdout.length, 0);
  assert.equal(captured.stderr.length, 0);
});
