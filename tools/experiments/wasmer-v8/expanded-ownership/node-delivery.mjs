import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const [addonPath, mode, cachePath] = process.argv.slice(2);
const addon = createRequire(import.meta.url)(addonPath);
const options = {
  profile: 'standard', storage: { kind: 'memory' }, username: 'postgres',
  database: 'postgres', startupGucs: {}, extensions: [],
};
const open = () => mode === 'direct'
  ? addon.NativeWasixDatabase.open(options)
  : addon.NativeWasixActorDatabase.open(options);
let failure;
try { await open(); } catch (error) { failure = error; }
assert(failure instanceof Error, 'locked bad engine must return an error');
assert.equal(failure.name, 'OliphauntWasixError');
assert.equal(failure.oliphauntWasixError, 'runtime');
assert.equal(failure.code, 'runtime-error');
assert.match(failure.message, /prepare Windows V8 engine/u);
assert(failure.message.replaceAll('\\', '/').includes(cachePath.replaceAll('\\', '/')), failure.message);
process.stdout.write(`node_loader_failure=PASS mode=${mode}\n`);
await new Promise((resolve) => process.stdin.once('data', resolve));
process.stdin.pause();
const database = await open();
const query = Buffer.from('SELECT 42\0');
const request = Buffer.alloc(5 + query.length);
request[0] = 0x51;
request.writeUInt32BE(4 + query.length, 1);
query.copy(request, 5);
const result = await database.execProtocolRaw(request);
assert(Buffer.from(result).includes(Buffer.from('42')));
await database.close();
console.log(`node_loader_retry=PASS mode=${mode} query=42 close=success`);
