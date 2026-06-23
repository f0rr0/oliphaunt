type TarWriteFile = {
  path: string;
  bytes: Uint8Array;
  mode: number;
};

export type TarExtractHost = {
  join(base: string, relative: string): string;
  dirname(path: string): string;
  mkdir(path: string): Promise<void>;
  writeFile(file: TarWriteFile): Promise<void>;
};

const BLOCK_SIZE = 512;
const textDecoder = new TextDecoder();

export async function extractTarArchive(
  archive: Uint8Array,
  destination: string,
  host: TarExtractHost,
): Promise<void> {
  let offset = 0;
  let nextPax: Record<string, string> | undefined;
  let globalPax: Record<string, string> = {};
  let nextLongName: string | undefined;

  while (offset + BLOCK_SIZE <= archive.byteLength) {
    const header = archive.subarray(offset, offset + BLOCK_SIZE);
    offset += BLOCK_SIZE;
    if (isZeroBlock(header)) {
      break;
    }

    const type = String.fromCharCode(header[156] ?? 0).replace('\0', '') || '0';
    const size = parseOctal(header.subarray(124, 136), 'tar entry size');
    const mode = parseOctal(header.subarray(100, 108), 'tar entry mode') || 0o644;
    const payloadStart = offset;
    const payloadEnd = payloadStart + size;
    if (payloadEnd > archive.byteLength) {
      throw new Error('tar archive ended in the middle of an entry payload');
    }
    const payload = archive.subarray(payloadStart, payloadEnd);
    offset = payloadStart + roundUpToBlock(size);

    if (type === 'x') {
      nextPax = parsePaxPayload(payload);
      continue;
    }
    if (type === 'g') {
      globalPax = { ...globalPax, ...parsePaxPayload(payload) };
      continue;
    }
    if (type === 'L') {
      nextLongName = decodeTarString(payload).replace(/\0+$/, '');
      continue;
    }

    const pax = { ...globalPax, ...(nextPax ?? {}) };
    nextPax = undefined;
    const relativePath = sanitizeTarPath(pax.path ?? nextLongName ?? tarHeaderPath(header));
    nextLongName = undefined;
    if (relativePath === undefined) {
      continue;
    }

    const outputPath = host.join(destination, relativePath);
    if (type === '5') {
      await host.mkdir(outputPath);
      continue;
    }
    if (type !== '0') {
      throw new Error(`unsupported tar entry type '${type}' for ${relativePath}`);
    }
    await host.mkdir(host.dirname(outputPath));
    await host.writeFile({
      path: outputPath,
      bytes: payload.slice(),
      mode: mode & 0o777,
    });
  }
}

function isZeroBlock(block: Uint8Array): boolean {
  for (const byte of block) {
    if (byte !== 0) {
      return false;
    }
  }
  return true;
}

function roundUpToBlock(size: number): number {
  return Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
}

function parseOctal(bytes: Uint8Array, label: string): number {
  const text = decodeTarString(bytes).replace(/\0.*$/, '').trim();
  if (text.length === 0) {
    return 0;
  }
  if (!/^[0-7]+$/.test(text)) {
    throw new Error(`${label} is not an octal tar field`);
  }
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is outside the safe integer range`);
  }
  return value;
}

function tarHeaderPath(header: Uint8Array): string {
  const name = decodeTarString(header.subarray(0, 100)).replace(/\0.*$/, '');
  const prefix = decodeTarString(header.subarray(345, 500)).replace(/\0.*$/, '');
  return prefix.length > 0 ? `${prefix}/${name}` : name;
}

function sanitizeTarPath(path: string): string | undefined {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (normalized.length === 0 || normalized === '.') {
    return undefined;
  }
  if (normalized.startsWith('/')) {
    throw new Error(`tar entry path must be relative: ${path}`);
  }
  const segments = normalized.split('/').filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`tar entry path escapes the install root: ${path}`);
  }
  return segments.join('/');
}

function parsePaxPayload(payload: Uint8Array): Record<string, string> {
  const text = decodeTarString(payload);
  const values: Record<string, string> = {};
  let offset = 0;
  while (offset < text.length) {
    const space = text.indexOf(' ', offset);
    if (space < 0) {
      throw new Error('malformed pax header record');
    }
    const length = Number.parseInt(text.slice(offset, space), 10);
    if (!Number.isSafeInteger(length) || length <= 0) {
      throw new Error('invalid pax header record length');
    }
    const record = text.slice(space + 1, offset + length);
    const equals = record.indexOf('=');
    if (equals <= 0 || !record.endsWith('\n')) {
      throw new Error('malformed pax header key/value record');
    }
    values[record.slice(0, equals)] = record.slice(equals + 1, -1);
    offset += length;
  }
  return values;
}

function decodeTarString(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}
