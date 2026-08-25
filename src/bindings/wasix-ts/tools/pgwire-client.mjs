import { createConnection } from 'node:net';
import { join } from 'node:path';

/** Minimal PostgreSQL wire client shared by local server smoke and benchmarks. */
export function connect(connectionString) {
  const url = new URL(connectionString);
  const host = url.searchParams.get('host');
  if (host !== null) {
    return createConnection(join(host, `.s.PGSQL.${url.searchParams.get('port') ?? '5432'}`));
  }
  return createConnection({ host: url.hostname, port: Number(url.port) });
}

export function onceConnected(socket) {
  if (socket.readyState === 'open') return Promise.resolve();
  return new Promise((resolveConnected, rejectConnected) => {
    const onConnect = () => {
      socket.off('error', onError);
      resolveConnected();
    };
    const onError = (error) => {
      socket.off('connect', onConnect);
      rejectConnected(error);
    };
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}

export function onceClosed(socket) {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolveClosed) => socket.once('close', resolveClosed));
}

export function readSingleByte(socket) {
  return new Promise((resolveByte, rejectByte) => {
    const onData = (value) => {
      cleanup();
      if (value.length !== 1) {
        rejectByte(
          new Error(`local server returned ${value.length} negotiation bytes, expected 1`),
        );
        return;
      }
      resolveByte(value[0]);
    };
    const onError = (error) => {
      cleanup();
      rejectByte(error);
    };
    const onClose = () => {
      cleanup();
      rejectByte(new Error('local server closed during protocol negotiation'));
    };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    socket.once('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

export async function expectClosedBeforeReady(socket) {
  try {
    await readExchange(socket);
  } catch (error) {
    if (String(error).includes('closed before ReadyForQuery')) return;
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      ['ECONNRESET', 'EPIPE', 'ERR_SOCKET_CLOSED', 'ERR_STREAM_DESTROYED'].includes(
        String(error.code),
      )
    ) {
      return;
    }
    throw error;
  }
  throw new Error('concurrent local-server client unexpectedly reached ReadyForQuery');
}

export function readExchange(socket) {
  return new Promise((resolveExchange, rejectExchange) => {
    let buffered = new Uint8Array();
    let copyBytes = 0;
    let totalBytes = 0;
    let messages = 0;
    const onData = (value) => {
      const incoming = new Uint8Array(value);
      totalBytes += incoming.length;
      const combined = new Uint8Array(buffered.length + incoming.length);
      combined.set(buffered);
      combined.set(incoming, buffered.length);
      let offset = 0;
      try {
        while (combined.length - offset >= 5) {
          const length = new DataView(
            combined.buffer,
            combined.byteOffset + offset + 1,
            4,
          ).getInt32(0);
          if (length < 4) throw new Error(`invalid backend message length ${length}`);
          const total = length + 1;
          if (combined.length - offset < total) break;
          const tag = combined[offset];
          messages += 1;
          if (tag === 'd'.charCodeAt(0)) copyBytes += length - 4;
          if (tag === 'E'.charCodeAt(0)) throw new Error('local server returned ErrorResponse');
          if (tag === 'Z'.charCodeAt(0)) {
            cleanup();
            resolveExchange({ copyBytes, messages, totalBytes });
            return;
          }
          offset += total;
        }
        buffered = combined.slice(offset);
      } catch (error) {
        cleanup();
        rejectExchange(error);
      }
    };
    const onError = (error) => {
      cleanup();
      rejectExchange(error);
    };
    const onClose = () => {
      cleanup();
      rejectExchange(new Error('local server closed before ReadyForQuery'));
    };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('end', onClose);
      socket.off('close', onClose);
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('end', onClose);
    socket.once('close', onClose);
  });
}

export function startupPacket(username, database) {
  const parameters = new TextEncoder().encode(
    `user\0${username}\0database\0${database}\0client_encoding\0UTF8\0\0`,
  );
  const packet = new Uint8Array(8 + parameters.length);
  const view = new DataView(packet.buffer);
  view.setInt32(0, packet.length);
  view.setInt32(4, 196_608);
  packet.set(parameters, 8);
  return packet;
}

export function controlPacket(code) {
  const packet = new Uint8Array(8);
  const view = new DataView(packet.buffer);
  view.setInt32(0, packet.length);
  view.setInt32(4, code);
  return packet;
}

export function simpleQuery(sql) {
  const body = new TextEncoder().encode(`${sql}\0`);
  const packet = new Uint8Array(5 + body.length);
  packet[0] = 'Q'.charCodeAt(0);
  new DataView(packet.buffer).setInt32(1, body.length + 4);
  packet.set(body, 5);
  return packet;
}
