import assert from 'node:assert/strict';
import test from 'node:test';
import { createCapturedOutput, captureOutput, finishCapture } from './output-capture.mjs';

test('capture preserves exact stdout and stderr bytes', () => {
  const captured = createCapturedOutput();
  captureOutput(captured, 'stdout', Buffer.from([0, 255]));
  captureOutput(captured, 'stdout', Buffer.from('a'));
  captureOutput(captured, 'stderr', Buffer.from('err!'));
  const { stdout, stderr } = finishCapture(captured);
  assert.deepEqual(stdout, Buffer.from([0, 255, 97]));
  assert.equal(stderr.toString(), 'err!');
});

test('capture accepts more than 64 MiB', () => {
  const captured = createCapturedOutput();
  const chunk = Buffer.alloc(1024 * 1024, 42);
  for (let index = 0; index < 65; index++) captureOutput(captured, 'stdout', chunk);
  captureOutput(captured, 'stderr', Buffer.from('diagnostic'));
  const { stdout, stderr } = finishCapture(captured);
  assert.equal(stdout.byteLength, 65 * chunk.byteLength);
  for (let offset = 0; offset < stdout.length; offset += chunk.length) {
    assert.deepEqual(stdout.subarray(offset, offset + chunk.length), chunk);
  }
  assert.equal(stderr.toString(), 'diagnostic');
});

test('capture failure releases both streams and remains sticky', () => {
  const captured = createCapturedOutput();
  captureOutput(captured, 'stdout', Buffer.from('out'));
  captureOutput(captured, 'stderr', Buffer.from('err'));
  const failure = new RangeError('allocation failed');
  captured.stdout.push = () => {
    throw failure;
  };
  captureOutput(captured, 'stdout', Buffer.from('more'));
  captureOutput(captured, 'stderr', Buffer.from('later'));
  assert.deepEqual(captured.stdout, []);
  assert.deepEqual(captured.stderr, []);
  assert.throws(
    () => finishCapture(captured),
    (error) => error === failure,
  );
});

test('concatenation failure releases chunks and never returns a prefix', () => {
  const captured = createCapturedOutput();
  captureOutput(captured, 'stdout', Buffer.from('out'));
  captureOutput(captured, 'stderr', Buffer.from('err'));
  // Exercise Buffer.concat's error path without exhausting host memory.
  captured.stderr.push(null);
  assert.throws(() => finishCapture(captured), TypeError);
  captureOutput(captured, 'stdout', Buffer.from('later'));
  assert.deepEqual(captured.stdout, []);
  assert.deepEqual(captured.stderr, []);
  assert.throws(() => finishCapture(captured), TypeError);
});
