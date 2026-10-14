import { isUtf8 } from 'node:buffer';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Pinned format: Bazel 8.8.1 RepositoryDelegatorFunction marker version 7 and
// BazelLockFileValue version 28; RepoRecordedInput.WithValue and its Gson adapter.
// Record values and unrelated lock data must never become decoded strings.
export class IncompleteBazelRecordedInputsError extends Error {
  override name = 'IncompleteBazelRecordedInputsError';
}

function incomplete(message: string): never {
  throw new IncompleteBazelRecordedInputsError(message);
}

class LockReader {
  private readonly chunks: AsyncIterator<Buffer>;
  private chunk = Buffer.alloc(0);
  private offset = 0;

  constructor(file: string) {
    this.chunks = createReadStream(file)[Symbol.asyncIterator]();
  }

  async peek(): Promise<number> {
    while (this.offset === this.chunk.length) {
      const next = await this.chunks.next();
      if (next.done) return -1;
      this.chunk = next.value;
      this.offset = 0;
    }
    return this.chunk[this.offset];
  }

  async take(): Promise<number> {
    const byte = await this.peek();
    if (byte >= 0) this.offset++;
    return byte;
  }

  async space() {
    while ([9, 10, 13, 32].includes(await this.peek())) this.offset++;
  }

  async expect(byte: number) {
    await this.space();
    if ((await this.take()) !== byte) incomplete('Malformed Bazel lock structure');
  }

  async string(mode: 'key' | 'record' | 'skip'): Promise<string> {
    await this.expect(34);
    const parts: Buffer[] = [];
    let capture = mode !== 'skip';
    let separated = false;
    const append = (bytes: Buffer) => {
      if (!capture) return;
      const separator = mode === 'record' ? bytes.indexOf(32) : -1;
      if (separator < 0) parts.push(bytes);
      else {
        parts.push(bytes.subarray(0, separator));
        capture = false;
        separated = true;
      }
    };
    for (;;) {
      if ((await this.peek()) < 0) incomplete('Truncated Bazel lock string');
      const start = this.offset;
      while (this.offset < this.chunk.length) {
        const byte = this.chunk[this.offset];
        if (byte === 34 || byte === 92) break;
        if (byte < 32) incomplete('Malformed Bazel lock string');
        this.offset++;
      }
      append(this.chunk.subarray(start, this.offset));
      if (this.offset === this.chunk.length) continue;
      if ((await this.take()) === 34) {
        if (mode === 'record' && !separated) incomplete('Missing recorded-input separator');
        const key = Buffer.concat(parts);
        if (!isUtf8(key)) incomplete('Unsupported recorded-input key encoding');
        return key.toString('utf8');
      }
      const escapedByte = await this.take();
      if (escapedByte === 117) {
        const hex = Buffer.alloc(4);
        for (let i = 0; i < 4; i++) {
          const byte = await this.take();
          if (
            !(
              (byte >= 48 && byte <= 57) ||
              (byte >= 65 && byte <= 70) ||
              (byte >= 97 && byte <= 102)
            )
          ) {
            incomplete('Malformed Bazel lock escape');
          }
          hex[i] = byte;
        }
        if (capture) {
          const code = Number.parseInt(hex.toString('ascii'), 16);
          if (code >= 0xd800 && code <= 0xdfff)
            incomplete('Unsupported recorded-input Unicode escape');
          append(Buffer.from(String.fromCharCode(code)));
        }
      } else {
        const escaped = new Map([
          [34, 34],
          [92, 92],
          [47, 47],
          [98, 8],
          [102, 12],
          [110, 10],
          [114, 13],
          [116, 9],
        ]);
        const byte = escaped.get(escapedByte);
        if (byte === undefined) incomplete('Malformed Bazel lock escape');
        if (capture) append(Buffer.from([byte]));
      }
    }
  }

  async object(entry: (key: string) => Promise<void>, keys = true) {
    await this.expect(123);
    await this.space();
    if ((await this.peek()) === 125) {
      this.offset++;
      return;
    }
    for (;;) {
      const key = await this.string(keys ? 'key' : 'skip');
      await this.expect(58);
      await entry(key);
      await this.space();
      const byte = await this.take();
      if (byte === 125) return;
      if (byte !== 44) incomplete('Malformed Bazel lock object');
    }
  }

  async array(entry: () => Promise<void>) {
    await this.expect(91);
    await this.space();
    if ((await this.peek()) === 93) {
      this.offset++;
      return;
    }
    for (;;) {
      await entry();
      await this.space();
      const byte = await this.take();
      if (byte === 93) return;
      if (byte !== 44) incomplete('Malformed Bazel lock array');
    }
  }

  async number(capture = true): Promise<string> {
    await this.space();
    let number = '';
    const take = async () => {
      const byte = await this.take();
      if (capture) number += String.fromCharCode(byte);
    };
    const digits = async () => {
      let count = 0;
      while ((await this.peek()) >= 48 && (await this.peek()) <= 57) {
        await take();
        count++;
      }
      if (!count) incomplete('Malformed Bazel lock number');
    };
    if ((await this.peek()) === 45) await take();
    if ((await this.peek()) === 48) await take();
    else await digits();
    if ((await this.peek()) === 46) {
      await take();
      await digits();
    }
    if ([69, 101].includes(await this.peek())) {
      await take();
      if ([43, 45].includes(await this.peek())) await take();
      await digits();
    }
    return number;
  }

  async skip(): Promise<void> {
    await this.space();
    const byte = await this.peek();
    if (byte === 34) {
      await this.string('skip');
      return;
    }
    if (byte === 123) {
      await this.object(() => this.skip(), false);
      return;
    }
    if (byte === 91) {
      await this.array(() => this.skip());
      return;
    }
    if (byte === 45 || (byte >= 48 && byte <= 57)) {
      await this.number(false);
      return;
    }
    const literal = new Map([
      [116, 'true'],
      [102, 'false'],
      [110, 'null'],
    ]).get(byte);
    if (!literal) incomplete('Malformed Bazel lock value');
    for (const char of literal)
      if ((await this.take()) !== char.charCodeAt(0)) incomplete('Malformed Bazel lock literal');
  }

  async close() {
    await this.chunks.return?.();
  }
}

function currentHostFactors(factor: string): boolean {
  if (factor === 'general') return true;
  const match = /^(?:os:([^,]+)(?:,arch:([^,]+))?|arch:([^,]+))$/u.exec(factor);
  if (!match) incomplete('Unsupported extension evaluation factors');
  const os = match[1];
  const arch = match[2] ?? match[3];
  const hostOs =
    process.platform === 'darwin'
      ? 'mac os x'
      : process.platform === 'win32'
        ? 'windows'
        : process.platform;
  const hostArch =
    process.arch === 'x64'
      ? ['amd64', 'x86_64', 'x64']
      : process.arch === 'arm64'
        ? ['aarch64', 'arm64']
        : [process.arch];
  return (
    (!os || (hostOs === 'windows' ? os.startsWith('windows') : os === hostOs)) &&
    (!arch || hostArch.includes(arch))
  );
}

async function lockInputs(file: string) {
  const reader = new LockReader(file);
  const inputs = new Map<string, string[] | undefined>();
  let version = false;
  let extensions = false;
  try {
    await reader.object(async (key) => {
      if (key === 'lockFileVersion') {
        if (version || (await reader.number()) !== '28')
          incomplete('Unsupported Bazel lock version');
        version = true;
      } else if (key === 'moduleExtensions') {
        if (extensions) incomplete('Duplicate Bazel module extension table');
        extensions = true;
        await reader.object(async (extension) => {
          if (inputs.has(extension)) incomplete('Duplicate module extension identity');
          const keys: string[] = [];
          let matched = false;
          await reader.object(async (factor) => {
            if (!currentHostFactors(factor)) {
              await reader.skip();
              return;
            }
            matched = true;
            let records = false;
            await reader.object(async (field) => {
              if (field !== 'recordedInputs') {
                await reader.skip();
                return;
              }
              if (records) incomplete('Duplicate extension recorded inputs');
              records = true;
              await reader.array(async () => keys.push(await reader.string('record')));
            });
            if (!records) incomplete('Missing extension recorded inputs');
          });
          inputs.set(extension, matched ? keys : undefined);
        });
      } else await reader.skip();
    });
    await reader.space();
    if (!version || !extensions || (await reader.peek()) !== -1)
      incomplete('Incomplete Bazel lock');
  } finally {
    await reader.close();
  }
  return inputs;
}

/** Pinned canonical prefixes; include all collision candidates, never recreate their ordering. */
function usesExtension(extension: string, repositories: Set<string>) {
  const match = /^(?:@@?([^/]*))?\/\/[^%]+%([a-zA-Z][a-zA-Z0-9_]*)(?:%(.+))?$/u.exec(extension);
  if (!match) incomplete('Unsupported module extension identity');
  const prefix = `${match[1] ?? ''}+${match[3] ? '_' : ''}${match[2]}`;
  const used = [...repositories].some(
    (name) => name.startsWith(prefix) && /^\d*\+/u.test(name.slice(prefix.length)),
  );
  if (used && match[3]) incomplete('Unsupported used isolated module extension');
  return used;
}

async function markerInputs(file: string, add: (key: string) => void) {
  const stream = createReadStream(file);
  let header = false;
  let separated = false;
  let parts: Buffer[] = [];
  const line = () => {
    const key = Buffer.concat(parts);
    parts = [];
    if (!key.length && !separated) return;
    if (!header) {
      if (separated || !isUtf8(key) || !/^[a-f0-9]{64}$/u.test(key.toString('utf8')))
        incomplete('Unsupported Bazel marker header');
      header = true;
    } else {
      if (!separated) incomplete('Missing marker recorded-input separator');
      if (!isUtf8(key)) incomplete('Unsupported recorded-input key encoding');
      add(key.toString('utf8'));
    }
    separated = false;
  };
  try {
    for await (const chunk of stream) {
      let start = 0;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === 10) {
          if (!separated) parts.push(chunk.subarray(start, i));
          line();
          start = i + 1;
        } else if (!separated && chunk[i] === 32) {
          parts.push(chunk.subarray(start, i));
          separated = true;
        }
      }
      if (!separated) parts.push(chunk.subarray(start));
    }
    line();
    if (!header) incomplete('Missing Bazel marker header');
  } finally {
    stream.destroy();
  }
}

function recordKey(
  encoded: string,
): { kind: 'FILE' | 'DIRENTS' | 'DIRTREE'; location: string } | undefined {
  const colon = encoded.indexOf(':');
  if (colon < 1) incomplete('Malformed recorded-input key');
  const kind = encoded.slice(0, colon);
  if (kind === 'ENV' || kind === 'REPO_MAPPING') return;
  if (kind !== 'FILE' && kind !== 'DIRENTS' && kind !== 'DIRTREE')
    incomplete('Unsupported recorded-input key');
  const location = encoded
    .slice(colon + 1)
    .replace(/\\(.)/gsu, (_all, char: string) => (char === 'n' ? '\n' : char === 's' ? ' ' : char));
  if (!location || encoded.endsWith('\\') || location.includes('\0'))
    incomplete('Malformed recorded-input path');
  return { kind, location };
}

function repositoryName(name: string): string {
  if (!/^[-a-zA-Z0-9._+]+$/u.test(name) || name === '.' || name === '..')
    incomplete('Invalid canonical repository name');
  return name;
}

export async function collectBazelRecordedSourceInputs(options: {
  workspaceRoot: string;
  outputBase: string;
  repositories: string[];
}): Promise<{ files: string[]; trees: string[]; directories: string[] }> {
  const workspace = path.resolve(options.workspaceRoot);
  const outputBase = path.resolve(options.outputBase);
  const groups = {
    FILE: new Set<string>(),
    DIRTREE: new Set<string>(),
    DIRENTS: new Set<string>(),
  };
  const repositories = new Set(options.repositories.filter(Boolean).map(repositoryName));
  const add = (encoded: string) => {
    const record = recordKey(encoded);
    if (!record) return;
    const match = /^(?:@@?([^/]*)\/\/|\/\/)(.*)$/su.exec(record.location);
    let relative: string;
    if (match) {
      if (match[1]) {
        repositories.add(repositoryName(match[1]));
        return;
      }
      relative = match[2];
    } else if (path.isAbsolute(record.location)) {
      relative = path.relative(workspace, record.location).split(path.sep).join('/');
      if (relative === '..' || relative.startsWith('../')) return;
    } else incomplete('Unsupported recorded-input path');
    if (
      relative.includes('\\') ||
      path.posix.normalize(relative || '.') !== (relative || '.') ||
      relative === '..' ||
      relative.startsWith('../')
    )
      incomplete('Noncanonical recorded-input path');
    groups[record.kind].add(relative);
  };
  try {
    if ((await readFile(path.join(workspace, '.bazelversion'), 'utf8')).trim() !== '8.8.1')
      incomplete('Unsupported Bazel marker format');
    const locks = await Promise.all([
      lockInputs(path.join(workspace, 'MODULE.bazel.lock')),
      lockInputs(path.join(outputBase, 'MODULE.bazel.lock')),
    ]);
    const merged = new Map<string, string[] | undefined>();
    for (const lock of locks)
      for (const [extension, keys] of lock)
        merged.set(
          extension,
          keys === undefined ? merged.get(extension) : [...(merged.get(extension) ?? []), ...keys],
        );
    const rows = [...merged.entries()];
    const usedRows = new Set<number>();
    const visited = new Set<string>();
    for (;;) {
      let changed = false;
      for (const [index, [extension, keys]] of rows.entries()) {
        if (usedRows.has(index) || !usesExtension(extension, repositories)) continue;
        if (keys === undefined)
          incomplete('Used module extension has no current-host persisted row');
        usedRows.add(index);
        changed = true;
        for (const key of keys) add(key);
      }
      for (const repository of repositories) {
        if (visited.has(repository)) continue;
        visited.add(repository);
        changed = true;
        // These two stock repositories are supplied by the verified pinned Bazel
        // installation, whose override path deliberately has no fetch marker.
        if (repository === 'bazel_tools' || repository === '_builtins') continue;
        await markerInputs(path.join(outputBase, 'external', `@${repository}.marker`), add);
      }
      if (!changed) break;
    }
    for (const name of repositories) {
      if (
        (name.match(/\+/gu)?.length ?? 0) >= 2 &&
        !/(?:^|\+)_repo_rules\d*\+/u.test(name) &&
        !rows.some(([extension]) => usesExtension(extension, new Set([name])))
      )
        incomplete('Used module extension has no persisted input record');
    }
  } catch (error) {
    if (error instanceof IncompleteBazelRecordedInputsError) throw error;
    incomplete('Missing or unreadable Bazel recorded source inputs');
  }
  return {
    files: [...groups.FILE].sort(),
    trees: [...groups.DIRTREE].sort(),
    directories: [...groups.DIRENTS].sort(),
  };
}
