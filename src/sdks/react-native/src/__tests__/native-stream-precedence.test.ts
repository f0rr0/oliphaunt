import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('mobile JSI bridges defer callback rejection until native recovery is known', () => {
  const android = readFileSync(
    resolve(packageRoot, 'android/src/main/cpp/OliphauntJsiBindings.cpp'),
    'utf8',
  );
  const androidChunk = android
    .split('static jni::local_ref<jni::JString> nativeEmitChunk', 2)[1]
    ?.split('static void nativeResolveUnit', 1)[0];
  assert.ok(androidChunk);
  assert.doesNotMatch(androidChunk, /takePendingStream|stream->settle\(\)/);
  assert.match(androidChunk, /acknowledgement->reject\("protocol stream callback failed"\)/);
  assert.match(android, /nativeRejectCallbackAborted/);
  assert.match(android, /__oliphauntProtocolCallbackAborted/);

  const ios = readFileSync(resolve(packageRoot, 'ios/Oliphaunt.mm'), 'utf8');
  const iosChunk = ios
    .split('onChunk:^(NSData *chunk)', 2)[1]
    ?.split('completion:^(NSError *_Nullable error)', 1)[0];
  assert.ok(iosChunk);
  assert.doesNotMatch(iosChunk, /settled->exchange\(true\)|reject->call/);
  assert.match(iosChunk, /acknowledgement->reject\("protocol stream callback failed"\)/);
  assert.match(ios, /OliphauntProtocolStreamCallbackAbortedErrorDomain/);
  assert.match(ios, /__oliphauntProtocolCallbackAborted/);
});
