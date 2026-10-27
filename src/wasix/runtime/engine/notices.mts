import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type EngineNotice = {
  id: string;
  name: string;
  url: string;
  sha256: string;
  encoding?: 'gitiles-base64';
  lines?: readonly [number, number];
  text_sha256?: string;
};

function requireDigest(bytes: Uint8Array, expected: string, id: string) {
  if (createHash('sha256').update(bytes).digest('hex') !== expected) {
    throw new Error(`Engine notice digest differs: ${id}`);
  }
}

export function renderEngineNotices(
  notices: readonly EngineNotice[],
  read: (id: string) => Uint8Array,
): string {
  const seen = new Set<string>();
  const sections = notices.map((notice) => {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(notice.id) || seen.has(notice.id)) {
      throw new Error(`Invalid or duplicate engine notice id: ${notice.id}`);
    }
    seen.add(notice.id);
    let bytes = Buffer.from(read(notice.id));
    requireDigest(bytes, notice.sha256, notice.id);
    if (notice.encoding === 'gitiles-base64') {
      bytes = Buffer.from(bytes.toString('ascii'), 'base64');
    } else if (notice.encoding !== undefined) {
      throw new Error(`Unsupported engine notice encoding: ${notice.id}`);
    }
    if (notice.lines) {
      const [first, last] = notice.lines;
      const lines = bytes.toString('utf8').split('\n');
      if (
        !Number.isSafeInteger(first) ||
        !Number.isSafeInteger(last) ||
        first < 1 ||
        last < first ||
        last > lines.length
      ) {
        throw new Error(`Invalid engine notice line range: ${notice.id}`);
      }
      bytes = Buffer.from(`${lines.slice(first - 1, last).join('\n')}\n`);
    }
    if (notice.text_sha256) requireDigest(bytes, notice.text_sha256, notice.id);
    if (!bytes.length) throw new Error(`Empty engine notice: ${notice.id}`);
    const text = bytes.toString('utf8');
    return `## ${notice.name}\n\nSource: ${notice.url}\n\n${text}${text.endsWith('\n') ? '' : '\n'}`;
  });
  if (!sections.length) throw new Error('Engine notices must not be empty');
  return `# Third-party notices\n\nUpstream notices for the Windows WASIX engine packages.\n\n${sections.join('\n')}`;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [pins, inputs, output] = process.argv.slice(2);
  if (!pins || !inputs || !output || process.argv.length !== 5) {
    throw new Error('usage: notices.mts PINS INPUT_DIRECTORY OUTPUT');
  }
  const manifest = JSON.parse(readFileSync(pins, 'utf8')) as { notices: EngineNotice[] };
  writeFileSync(
    output,
    renderEngineNotices(manifest.notices, (id) => readFileSync(path.join(inputs, id))),
  );
}
