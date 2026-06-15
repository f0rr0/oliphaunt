export function simpleQuery(sql: string): Uint8Array {
  if (sql.includes('\0')) {
    throw new Error('simple query SQL must not contain NUL bytes');
  }
  const encoder = new TextEncoder();
  const body = encoder.encode(sql);
  const packet = new Uint8Array(body.length + 6);
  packet[0] = 'Q'.charCodeAt(0);
  writeI32(packet, 1, body.length + 5);
  packet.set(body, 5);
  packet[packet.length - 1] = 0;
  return packet;
}

function writeI32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}
