import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { Readable } from 'node:stream';
import { test } from 'bun:test';
import { normalizeOpenConfig } from '../config.js';
import { simpleQuery } from '../protocol.js';
import { BrokerExchangeClient, BrokerExchangeError } from '../runtime/broker-exchange.js';
import { BrokerHandle } from '../runtime/broker.js';
import {
  BROKER_EXCHANGE_CHUNK_BYTES,
  decodeBrokerRequest,
  decodeBrokerCompletion,
  encodeBrokerResponse,
  encodeBrokerExchangeFrame,
  readBrokerExchangeFrame,
  type BrokerExchangeKind,
} from '../runtime/broker-frames.js';
import { MemoryDuplexStream, type ByteStream } from '../runtime/byte-stream.js';
import { authenticatePostgresStream, encodeStartupMessage } from '../runtime/pgwire.js';

const epoch = new Uint8Array(16).fill(7);
const success = Uint8Array.of(0, 1, 0);
const query = simpleQuery('');
const record = (kind: BrokerExchangeKind, request: bigint, payload = new Uint8Array()) =>
  encodeBrokerExchangeFrame({ kind, epoch, request, payload });
const terminal = (request: bigint, payload = success) => record(6, request, payload);

test('malformed input tails never submit their valid SQL prefix or consume a request id', async () => {
  const prefix = simpleQuery('CREATE TABLE must_not_run (value integer)');
  const wire = new MemoryDuplexStream([terminal(1n)]);
  const client = new BrokerExchangeClient(wire, epoch);
  for (const input of [
    new Uint8Array(),
    Buffer.concat([prefix, Uint8Array.of(0x51, 0, 0)]),
    Buffer.concat([prefix, Uint8Array.of(0x51, 0, 0, 0, 6, 0)]),
    Buffer.concat([prefix, Uint8Array.of(0x51, 0xff, 0xff, 0xff, 0xff)]),
    Buffer.concat([prefix, Uint8Array.of(0x58, 0, 0, 0, 4)]),
    Buffer.concat([prefix, Uint8Array.of(0x70, 0, 0, 0, 4)]),
    Buffer.concat([prefix, Uint8Array.of(0, 0, 0, 0, 4)]),
    Uint8Array.of(0, 0, 0, 8, 0, 3, 0, 0),
  ]) {
    await assert.rejects(
      client.execProtocolStream(input, () => {}),
      /request length|frontend|connection control/,
    );
    assert.equal(client.activeRequest, undefined);
    assert.equal(wire.output.length, 0, 'even the valid prefix stays unsubmitted');
  }
  // Whole frames may contain several PostgreSQL readiness boundaries.
  await client.execProtocolStream(Buffer.concat([query, query]), () => {});
  const start = await readBrokerExchangeFrame(new MemoryDuplexStream(wire.output));
  assert.equal(start.request, 1n);
});

test('broker negotiates after PostgreSQL authentication and reads fragmented/coalesced records', async () => {
  const auth = Uint8Array.of(
    0x52,
    0,
    0,
    0,
    8,
    0,
    0,
    0,
    3,
    0x52,
    0,
    0,
    0,
    8,
    0,
    0,
    0,
    0,
    0x4b,
    0,
    0,
    0,
    12,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    2,
    0x5a,
    0,
    0,
    0,
    5,
    0x49,
  );
  const first = record(4, 1n, Uint8Array.of(0x45, 0x5a));
  const second = record(4, 1n, Uint8Array.of(3));
  const input = Buffer.concat([auth, terminal(0n), first, second, terminal(1n)]);
  const wire = new MemoryDuplexStream([
    input.subarray(0, 2),
    input.subarray(2, 47),
    input.subarray(47, 85),
    input.subarray(85),
  ]);
  await authenticatePostgresStream(wire, 'postgres', 'postgres', 'secret', {
    '_pq_.oliphaunt_exchange': '1',
  });
  assert.deepEqual(
    wire.output[0],
    encodeStartupMessage('postgres', 'postgres', {
      '_pq_.oliphaunt_exchange': '1',
    }),
  );
  assert.equal(wire.output[1]?.[0], 0x70, 'normal PostgreSQL password message authenticates');
  const client = await BrokerExchangeClient.open(wire);
  const output: Uint8Array[] = [];
  await client.execProtocolStream(query, (chunk) => output.push(chunk));
  assert.deepEqual(
    Buffer.concat(output),
    Buffer.from([0x45, 0x5a, 3]),
    'raw E/Z bytes do not terminate records',
  );
  const written = new MemoryDuplexStream(wire.output.slice(2));
  const start = await readBrokerExchangeFrame(written);
  assert.equal(start.kind, 1);
  assert.equal(start.request, 1n);
  assert.deepEqual(start.epoch, epoch);
  assert.equal(new DataView(start.payload.buffer).getBigUint64(0), BigInt(query.length));
  assert.equal(new DataView(start.payload.buffer).getBigUint64(8), 0n);
  assert.equal((await readBrokerExchangeFrame(written)).kind, 4);
  assert.equal((await readBrokerExchangeFrame(written)).kind, 5);
});

test('out-of-band cancellation keeps its original request while the next exchange starts', async () => {
  let releaseFirst!: () => void;
  const firstReady = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let releaseSecond!: () => void;
  const secondReady = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const source = new MemoryDuplexStream([terminal(1n), terminal(2n)]);
  let reads = 0;
  const client = new BrokerExchangeClient(
    {
      async readExactly(length) {
        if (reads++ === 0) await firstReady;
        else if (reads === 3) await secondReady;
        return source.readExactly(length);
      },
      async writeAll() {},
      async close() {
        releaseFirst();
        releaseSecond();
      },
    },
    epoch,
  );
  let cancelRequest: ReturnType<typeof decodeBrokerRequest> | undefined;
  let first!: Promise<void>;
  let second: Promise<void> | undefined;
  const server = createServer((socket) => {
    let input = Buffer.alloc(0);
    socket.on('data', (bytes) => {
      input = Buffer.concat([input, bytes]);
      if (input.length < 13 || input.length < 13 + Number(input.readBigUInt64BE(5))) return;
      cancelRequest = decodeBrokerRequest(input[4]!, Uint8Array.from(input.subarray(13)));
      void (async () => {
        releaseFirst();
        await first;
        second = client.execProtocolStream(query, () => {});
        assert.equal(client.activeRequest?.request, 2n);
        socket.end(encodeBrokerResponse({ kind: 'ok', bytes: new Uint8Array() }));
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const handle = new BrokerHandle(
    normalizeOpenConfig(
      { topology: 'broker' },
      { instanceDirectory: '/unused', temporaryDirectory: false },
    ),
    {
      child: {
        stdout: Readable.from([]),
        kill() {},
        async wait() {
          return 0;
        },
        async exited() {
          return 0;
        },
      },
      stream: new MemoryDuplexStream(),
      client,
      controlEndpoint: { kind: 'tcp', host: '127.0.0.1', port: address.port },
      authToken: 'secret',
    },
    1000,
  );
  try {
    await handle.cancel();
    assert.equal(cancelRequest, undefined, 'idle cancellation opens no management connection');
    first = client.execProtocolStream(query, () => {});
    await handle.cancel();
    assert.deepEqual(cancelRequest, { kind: 'cancel', token: 'secret', epoch, request: 1n });
    assert.equal(client.activeRequest?.request, 2n);
    releaseSecond();
    await second;
  } finally {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('exchange rejects incompatible identities and oversized records before reading their payload', async () => {
  for (const frame of [
    terminal(2n),
    encodeBrokerExchangeFrame({
      kind: 6,
      request: 1n,
      epoch: new Uint8Array(16),
      payload: success,
    }),
  ]) {
    let closed = false;
    const wire = new MemoryDuplexStream([frame]);
    const client = new BrokerExchangeClient(
      {
        readExactly: (length) => wire.readExactly(length),
        writeAll: (bytes) => wire.writeAll(bytes),
        async close() {
          closed = true;
        },
      },
      epoch,
    );
    await assert.rejects(
      client.execProtocolStream(query, () => {}),
      /identity mismatch/,
    );
    assert.equal(closed, true);
    await assert.rejects(
      client.execProtocolStream(query, () => {}),
      /closed/,
    );
  }
  const oversized = record(4, 1n, Uint8Array.of(1)).slice(0, 36);
  new DataView(oversized.buffer).setUint32(32, BROKER_EXCHANGE_CHUNK_BYTES + 1);
  await assert.rejects(
    readBrokerExchangeFrame(new MemoryDuplexStream([oversized])),
    /record length/,
  );
  await assert.rejects(
    BrokerExchangeClient.open(new MemoryDuplexStream([terminal(1n)])),
    /negotiation/,
  );
  assert.throws(() => decodeBrokerCompletion(Uint8Array.of(0, 2, 1)), /inconsistent/);
  assert.throws(() => decodeBrokerCompletion(Uint8Array.of(5, 2, 0)), /inconsistent/);
});

test('callback failure drains exactly one terminal and unknown execution takes priority', async () => {
  const failure = new Error('sink stopped');
  const wire = new MemoryDuplexStream([
    record(4, 1n, Uint8Array.of(1)),
    record(4, 1n, Uint8Array.of(2)),
    terminal(1n),
    record(4, 2n, Uint8Array.of(3)),
    terminal(2n),
    record(4, 3n, Uint8Array.of(4)),
    terminal(3n, Uint8Array.of(6, 1, 0)),
    record(4, 4n, Uint8Array.of(5)),
    terminal(4n, Uint8Array.of(5, 2, 1)),
  ]);
  const client = new BrokerExchangeClient(wire, epoch);
  let calls = 0;
  await assert.rejects(
    client.execProtocolStream(query, () => {
      calls++;
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(calls, 1);
  assert.equal(client.activeRequest, undefined);
  const output: number[] = [];
  await client.execProtocolStream(query, (chunk) => output.push(...chunk));
  assert.deepEqual(output, [3]);
  await assert.rejects(
    client.execProtocolStream(query, () => {
      throw failure;
    }),
    (error) => {
      assert.ok(error instanceof BrokerExchangeError);
      assert.equal(error.reason, 'database');
      assert.equal(error.execution, 'completed');
      assert.equal(error.requiresReopen, false);
      return true;
    },
  );
  await assert.rejects(
    client.execProtocolStream(query, () => {
      throw failure;
    }),
    (error) => {
      assert.ok(error instanceof BrokerExchangeError);
      assert.equal(error.execution, 'unknown');
      assert.equal(error.requiresReopen, true);
      return true;
    },
  );
  await assert.rejects(
    client.execProtocolStream(query, () => {}),
    /closed/,
  );
});

test('transport failure closes and settles the blocked opposite direction', async () => {
  for (const failWriter of [false, true]) {
    const failure = new Error(failWriter ? 'upload failed' : 'download failed');
    let rejectBlocked!: (error: Error) => void;
    let blockedSettled = false;
    const blocked = new Promise<never>((_resolve, reject) => {
      rejectBlocked = reject;
    });
    const waitBlocked = async (): Promise<never> => {
      try {
        return await blocked;
      } finally {
        blockedSettled = true;
      }
    };
    let closed = false;
    const client = new BrokerExchangeClient(
      {
        async writeAll() {
          if (failWriter) throw failure;
          await waitBlocked();
        },
        async readExactly() {
          if (!failWriter) throw failure;
          return waitBlocked();
        },
        async close() {
          closed = true;
          rejectBlocked(new Error('transport closed'));
        },
      },
      epoch,
    );
    await assert.rejects(
      client.execProtocolStream(query, () => {}),
      (error) => error === failure,
    );
    assert.equal(closed, true);
    assert.equal(blockedSettled, true);
  }
});

test('request upload and result drain make progress together after a consumer throws', async () => {
  let releaseWrite!: () => void;
  const writing = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  let releaseRead!: () => void;
  const endWritten = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const source = new MemoryDuplexStream([
    record(4, 1n, new Uint8Array(BROKER_EXCHANGE_CHUNK_BYTES)),
    terminal(1n),
  ]);
  const uploaded: Uint8Array[] = [];
  const stream: ByteStream = {
    async writeAll(bytes) {
      const kind = bytes[6];
      uploaded.push(bytes.slice());
      if (kind === 4) await writing;
      if (kind === 5) releaseRead();
    },
    async readExactly(length) {
      releaseWrite();
      // Let output begin before upload finishes, but withhold its terminal until End.
      if (
        uploaded.some((bytes) => bytes[6] === 4) &&
        length === 36 &&
        uploaded.every((bytes) => bytes[6] !== 5)
      )
        await endWritten;
      return source.readExactly(length);
    },
    async close() {
      releaseWrite();
      releaseRead();
    },
  };
  const client = new BrokerExchangeClient(stream, epoch);
  const failure = new Error('consumer stopped');
  let calls = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await assert.rejects(
      Promise.race([
        client.execProtocolStream(simpleQuery(' '.repeat(BROKER_EXCHANGE_CHUNK_BYTES - 5)), () => {
          calls++;
          throw failure;
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('duplex stalled')), 500);
        }),
      ]),
      (error) => error === failure,
    );
  } finally {
    clearTimeout(timer);
  }
  assert.equal(calls, 1);
  assert.deepEqual(
    uploaded.map((bytes) => bytes[6]),
    [1, 4, 4, 5],
  );
  assert.equal(uploaded[1]!.length, BROKER_EXCHANGE_CHUNK_BYTES + 36);
  assert.equal(uploaded[2]!.length, 37);
});
