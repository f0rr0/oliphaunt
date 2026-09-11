import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.OLIPHAUNT_WASIX_TOOLS_TEST_ROOT;
if (!root) throw new Error('Run bash postgres-tools/wasix/tools/test-packaging.sh');
const portable = (await import(pathToFileURL(path.join(root, 'consumer/index.js')).href)).default;
const native = (await import(pathToFileURL(path.join(root, 'consumer/native.js')).href)).default;
assert.equal(readFileSync(new URL(native.pgDump.aot.source), 'utf8'), 'target-code');
assert.equal(native.pgDump.sha256, portable.pgDump.sha256);
assert.equal(native.runtimeVersion, '1.2.3');
