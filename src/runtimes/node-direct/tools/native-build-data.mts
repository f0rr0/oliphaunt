import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const [command, ...args] = process.argv.slice(2);
switch (command) {
  case 'check-addon': {
    const { readFileSync } = require('node:fs');
    const addonPath = args[0];
    const lifecycleTestAddonPath = args[1];
    const addon = require(addonPath);
    const expected = [
      'version',
      'open',
      'execProtocolRaw',
      'execSimpleQuery',
      'execProtocolRawStream',
      'backup',
      'restore',
      'cancel',
      'detach',
      'createForgottenHandleRecoveryToken',
      'queueForgottenHandleRecovery',
    ].sort();
    const actual = Object.getOwnPropertyNames(addon).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        `compiled Node direct addon exports ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}`,
      );
    }
    for (const name of expected) {
      if (typeof addon[name] !== 'function') {
        throw new Error(`Node direct export ${name} is not a function`);
      }
    }

    const productionBytes = readFileSync(addonPath);
    const lifecycleTestBytes = readFileSync(lifecycleTestAddonPath);
    const testPrefix = Buffer.from('OLIPHAUNT_NODE_CLEANUP_TEST_');
    if (productionBytes.includes(testPrefix)) {
      throw new Error('production Node direct addon contains lifecycle-test controls');
    }
    for (const control of [
      'OLIPHAUNT_NODE_CLEANUP_TEST_DELAY_OPERATION_START',
      'OLIPHAUNT_NODE_CLEANUP_TEST_PAUSE_NATIVE_CALL_ENTRY',
      'OLIPHAUNT_NODE_CLEANUP_TEST_PREFILL_STREAM_QUEUE',
    ]) {
      if (!lifecycleTestBytes.includes(Buffer.from(control))) {
        throw new Error(`instrumented Node direct addon is missing ${control}`);
      }
    }
    break;
  }
  case 'pack-tarball': {
    const path = require('node:path');
    const raw = JSON.parse(process.env.PACK_JSON || '[]');
    const entry = Array.isArray(raw) ? raw[0] : raw;
    if (!entry || typeof entry.filename !== 'string' || !entry.filename.endsWith('.tgz')) {
      throw new Error('pnpm pack did not report a .tgz filename');
    }
    process.stdout.write(
      path.isAbsolute(entry.filename)
        ? entry.filename
        : path.join(process.env.PACK_DIR, entry.filename),
    );
    break;
  }
  case 'headers': {
    const path = require('node:path');
    const fs = require('node:fs');
    const root = path.dirname(path.dirname(process.execPath));
    const adjacent = [path.join(root, 'include/node'), path.join(root, 'include')].find((dir) =>
      fs.existsSync(path.join(dir, 'node_api.h')),
    );
    process.stdout.write(
      adjacent ??
        path.dirname(
          require.resolve('node-api-headers/include/node_api.h', {
            paths: [process.cwd(), path.join(process.cwd(), 'src/runtimes/node-direct')],
          }),
        ),
    );
    break;
  }
  default:
    throw Error('unknown native build data command: ' + command);
}
