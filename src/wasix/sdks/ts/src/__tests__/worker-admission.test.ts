import { expect, it, mock } from 'bun:test';

let workersCreated = 0;
mock.module('node:worker_threads', () => ({
  Worker: class {
    constructor() {
      workersCreated++;
      throw new Error('invalid configuration started a Worker');
    }
  },
}));

const { openWasix } = await import('../hosts/node-api/worker-node-client.js');

it.each([
  { maxPendingOperations: 0x1_0000_0000, highWaterMarkBytes: 8 },
  { maxPendingOperations: 1, highWaterMarkBytes: 0x1_0000_0000 },
])('rejects unsupported native admission before Worker construction', async (admission) => {
  await expect(openWasix({ admission })).rejects.toThrow(/semaphore range/);
  expect(workersCreated).toBe(0);
});
