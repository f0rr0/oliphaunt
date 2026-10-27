import { readPortableArchiveEntries } from '../../../../../tools/packaging/portable-archive.mts';

function fail(message: string): never {
  throw new Error(message);
}

async function readZipArchive(file) {
  const entries = readPortableArchiveEntries(file, { format: 'zip' });
  return {
    names: new Set(entries.keys()),
    read(entryName) {
      const entry = entries.get(entryName);
      return entry?.isFile ? Buffer.from(entry.data()) : undefined;
    },
  };
}

/** The conventional native requirement owns the SDK's delivered ABI header. */
export function readNativeAppleHeader(file: string): Buffer {
  const headers = [...readPortableArchiveEntries(file, { format: 'zip' }).values()]
    .filter(
      (entry) =>
        entry.isFile && /^liboliphaunt\.xcframework\/.+\/Headers\/oliphaunt\.h$/u.test(entry.name),
    )
    .map((entry) => Buffer.from(entry.data()));
  if (headers.length < 3 || !headers[0].length)
    fail('Selected native XCFramework must ship all public C headers');
  if (headers.some((header) => !header.equals(headers[0])))
    fail('Selected native XCFramework slices declare different public C headers');
  return headers[0];
}

function xmlDecode(value) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function tokenizeXml(text) {
  return Array.from(text.matchAll(/<[^>]+>|[^<]+/gu), (match) => match[0]);
}

function tagName(token) {
  return token
    .replace(/^<\//u, '')
    .replace(/^</u, '')
    .replace(/\/?>$/u, '')
    .trim()
    .split(/\s+/u)[0];
}

class PlistParser {
  constructor(text) {
    this.tokens = tokenizeXml(text);
    this.index = 0;
  }

  parse() {
    const token = this.nextToken();
    if (!this.isOpening(token, 'plist')) {
      throw new Error('plist root element is missing');
    }
    const value = this.parseValue();
    const closing = this.nextToken();
    if (!this.isClosing(closing, 'plist')) {
      throw new Error('plist root element is not closed');
    }
    return value;
  }

  nextToken() {
    while (this.index < this.tokens.length) {
      const token = this.tokens[this.index];
      this.index += 1;
      if (!token.startsWith('<') && token.trim() === '') {
        continue;
      }
      if (token.startsWith('<?') || token.startsWith('<!') || token.startsWith('<!--')) {
        continue;
      }
      return token;
    }
    throw new Error('unexpected end of plist XML');
  }

  peekToken() {
    const oldIndex = this.index;
    const token = this.nextToken();
    this.index = oldIndex;
    return token;
  }

  isOpening(token, name) {
    return (
      token.startsWith('<') &&
      !token.startsWith('</') &&
      tagName(token) === name &&
      !token.endsWith('/>')
    );
  }

  isClosing(token, name) {
    return token.startsWith('</') && tagName(token) === name;
  }

  isSelfClosing(token, name) {
    return token.startsWith('<') && tagName(token) === name && token.endsWith('/>');
  }

  parseValue() {
    const token = this.nextToken();
    if (this.isOpening(token, 'dict')) {
      return this.parseDict();
    }
    if (this.isOpening(token, 'array')) {
      return this.parseArray();
    }
    if (this.isOpening(token, 'string')) {
      return this.parseTextElement('string');
    }
    if (this.isSelfClosing(token, 'string')) {
      return '';
    }
    if (this.isOpening(token, 'integer')) {
      return Number.parseInt(this.parseTextElement('integer'), 10);
    }
    if (this.isSelfClosing(token, 'true')) {
      return true;
    }
    if (this.isSelfClosing(token, 'false')) {
      return false;
    }
    throw new Error(`unsupported plist value ${token}`);
  }

  parseDict() {
    const result = {};
    while (true) {
      const token = this.peekToken();
      if (this.isClosing(token, 'dict')) {
        this.nextToken();
        return result;
      }
      const keyOpen = this.nextToken();
      if (!this.isOpening(keyOpen, 'key')) {
        throw new Error(`expected plist dict key, got ${keyOpen}`);
      }
      const key = this.parseTextElement('key');
      result[key] = this.parseValue();
    }
  }

  parseArray() {
    const result = [];
    while (true) {
      const token = this.peekToken();
      if (this.isClosing(token, 'array')) {
        this.nextToken();
        return result;
      }
      result.push(this.parseValue());
    }
  }

  parseTextElement(name) {
    let text = '';
    while (true) {
      const token = this.nextToken();
      if (this.isClosing(token, name)) {
        return xmlDecode(text);
      }
      if (token.startsWith('<')) {
        throw new Error(`unexpected tag in plist ${name}: ${token}`);
      }
      text += token;
    }
  }
}

function parsePlist(buffer, source) {
  const prefix = buffer.subarray(0, 6).toString('utf8');
  if (prefix === 'bplist') {
    fail(`SwiftPM Apple XCFramework Info.plist must be XML for release validation: ${source}`);
  }
  try {
    return new PlistParser(buffer.toString('utf8')).parse();
  } catch (error) {
    fail(`SwiftPM Apple XCFramework Info.plist is invalid in ${source}: ${error.message}`);
  }
}

export async function validateAppleXcframeworkAsset(file, framework = 'liboliphaunt') {
  let archive;
  try {
    archive = await readZipArchive(file);
  } catch (error) {
    fail(`SwiftPM Apple XCFramework asset is not a readable zip file: ${file}: ${error.message}`);
  }
  const infoData = archive.read(`${framework}.xcframework/Info.plist`);
  if (infoData === undefined) {
    fail(`SwiftPM Apple XCFramework asset is missing ${framework}.xcframework/Info.plist: ${file}`);
  }
  const info = parsePlist(infoData, file);
  if (info === null || Array.isArray(info) || typeof info !== 'object') {
    fail(`SwiftPM Apple XCFramework Info.plist must be a plist dictionary in ${file}`);
  }
  const libraries = info.AvailableLibraries;
  if (!Array.isArray(libraries) || libraries.length === 0) {
    fail(`SwiftPM Apple XCFramework Info.plist has no AvailableLibraries in ${file}`);
  }

  const slices = new Set();
  for (const library of libraries) {
    if (library === null || Array.isArray(library) || typeof library !== 'object') {
      continue;
    }
    const platform = library.SupportedPlatform;
    const variant = library.SupportedPlatformVariant ?? '';
    const libraryPath = library.LibraryPath;
    const identifier = library.LibraryIdentifier;
    const architectures = library.SupportedArchitectures;
    if (
      typeof platform !== 'string' ||
      typeof libraryPath !== 'string' ||
      typeof identifier !== 'string' ||
      !Array.isArray(architectures) ||
      architectures.some((architecture) => typeof architecture !== 'string')
    ) {
      continue;
    }
    for (const architecture of architectures) {
      slices.add(`${platform}\0${typeof variant === 'string' ? variant : ''}\0${architecture}`);
    }
    const candidate = `${framework}.xcframework/${identifier}/${libraryPath}`;
    if (
      !archive.names.has(candidate) &&
      !Array.from(archive.names).some((name) => name.startsWith(`${candidate}/`))
    ) {
      fail(`SwiftPM Apple XCFramework is missing declared library ${candidate}`);
    }
  }

  const missing = missingRequiredAppleArm64Slices(slices);
  if (missing.length > 0) {
    fail(
      `SwiftPM Apple XCFramework asset ${file} is missing required arm64 slice(s): ${missing.join(', ')}`,
    );
  }
}

export function missingRequiredAppleArm64Slices(slices) {
  const required = [
    ['macos', '', 'arm64'],
    ['ios', '', 'arm64'],
    ['ios', 'simulator', 'arm64'],
  ];
  return required
    .filter(
      ([platform, variant, architecture]) =>
        !slices.has(`${platform}\0${variant}\0${architecture}`),
    )
    .map(
      ([platform, variant, architecture]) =>
        `${platform}${variant ? `-${variant}` : ''}-${architecture}`,
    )
    .sort();
}
