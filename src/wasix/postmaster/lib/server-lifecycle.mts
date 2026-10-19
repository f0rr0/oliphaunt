import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';

const [command, value, port] = process.argv.slice(2);
if (command === 'probe') {
  const socket = createConnection({ host: value, port: Number(port) });
  process.exitCode = await new Promise<number>((resolve) => {
    const finish = (code: number) => {
      socket.destroy();
      resolve(code);
    };
    socket
      .once('connect', () => finish(0))
      .once('error', () => finish(1))
      .setTimeout(200, () => finish(1));
  });
} else if (command === 'size') {
  const match = /^(\d+)([KMGTPE])?(?:i?B)?$/.exec(value);
  assert(match, 'invalid cgroup size');
  const bytes = BigInt(match[1]) * 1024n ** BigInt(match[2] ? 'KMGTPE'.indexOf(match[2]) + 1 : 0);
  assert(bytes <= 2n ** 63n - 1n, 'cgroup size exceeds signed 64-bit range');
  console.log(bytes.toString());
} else {
  assert(command === 'available-port' || command === 'listen', 'unknown server lifecycle command');
  let candidate = command === 'listen' ? 0 : Number(value);
  assert(Number.isInteger(candidate) && candidate >= 0 && candidate < 65536, 'invalid TCP port');
  for (;;) {
    const server = createServer((socket) => socket.destroy());
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject).listen(candidate, '127.0.0.1', resolve);
      });
      const selected = (server.address() as { port: number }).port;
      if (command === 'listen') writeFileSync(value, String(selected));
      else {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        console.log(selected);
      }
      break;
    } catch (error) {
      if (command === 'listen' || error.code !== 'EADDRINUSE' || ++candidate >= 65536) throw error;
    }
  }
}
