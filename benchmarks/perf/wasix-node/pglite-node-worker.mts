import { parentPort } from 'node:worker_threads';

import { PGlite } from '@electric-sql/pglite';

export async function dispatchPgliteRequest(database, message) {
  const { id, method, args = [] } = message ?? {};
  if (!Number.isSafeInteger(id) || id < 1 || typeof method !== 'string') {
    throw new Error('PGlite benchmark worker received an invalid request');
  }

  let result = {};
  let transfer = [];
  if (method === 'query') {
    result = { result: await database.query(args[0], args[1]) };
  } else if (method === 'execute') {
    await database.exec(args[0]);
  } else if (method === 'rawProtocol') {
    if (!(args[0] instanceof Uint8Array) || args[1] !== false) {
      throw new Error('PGlite raw protocol benchmark requires bytes and syncToFs=false');
    }
    const response = await database.execProtocolRaw(args[0], { syncToFs: args[1] });
    result = { response };
    if (response.buffer instanceof ArrayBuffer) transfer = [response.buffer];
  } else if (method === 'close') {
    await database.close();
  } else {
    throw new Error(`unsupported PGlite benchmark worker method ${JSON.stringify(method)}`);
  }
  return { id, method, result, transfer };
}

if (parentPort !== null) {
  const database = await PGlite.create('memory://');
  let queue = Promise.resolve();

  parentPort.on('message', (message) => {
    queue = queue.then(() => dispatch(message));
  });
  parentPort.postMessage({ type: 'ready' });

  async function dispatch(message) {
    const id = message?.id;
    try {
      const response = await dispatchPgliteRequest(database, message);
      parentPort.postMessage(
        { type: 'response', id: response.id, result: response.result },
        response.transfer,
      );
      if (response.method === 'close') parentPort.close();
    } catch (error) {
      parentPort.postMessage({
        type: 'response',
        id,
        error: {
          name: error instanceof Error ? error.name : 'Error',
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
      });
    }
  }
}
