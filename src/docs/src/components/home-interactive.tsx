'use client';

import { AnimatePresence, LayoutGroup, motion, useInView } from 'motion/react';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import { siKotlin, siReact, siRust, siSwift, siTypescript } from 'simple-icons';
import { WasixMark } from '@/components/brand';

type BrandIconProps = {
  id: string;
  className?: string;
  title?: string;
};

type BrandMark = {
  hex: string;
  path: string;
  title: string;
};

const BRAND_ICONS: Record<string, BrandMark> = {
  rust: siRust,
  swift: siSwift,
  kotlin: siKotlin,
  react: siReact,
  'react-native': siReact,
  typescript: siTypescript,
};

export function BrandIcon({ id, className, title }: BrandIconProps) {
  const icon = BRAND_ICONS[id];

  if (id === 'wasix') {
    return (
      <WasixMark
        aria-hidden={title ? undefined : true}
        aria-label={title}
        className={className ? `home-wasix-mark ${className}` : 'home-wasix-mark'}
        role={title ? 'img' : undefined}
      />
    );
  }

  if (!icon) {
    return null;
  }

  return (
    <svg
      aria-hidden={title ? undefined : true}
      className={className ? `home-brand-icon ${className}` : 'home-brand-icon'}
      data-brand={id}
      fill={`#${icon.hex}`}
      focusable="false"
      role={title ? 'img' : undefined}
      style={{ '--home-brand-color': `#${icon.hex}` } as CSSProperties}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      {title ? <title>{title}</title> : null}
      <path d={icon.path} />
    </svg>
  );
}

type ProductUseCaseId = 'workspace' | 'field' | 'retrieval' | 'data-tools';

type ProductUseCase = {
  id: ProductUseCaseId;
  title: string;
  description: string;
  nodes: readonly { label: string; detail: string }[];
  sql: string;
  meaning: string;
};

const PRODUCT_USE_CASES: readonly ProductUseCase[] = [
  {
    id: 'workspace',
    title: 'Knowledge and creative tools',
    description:
      'Keep documents, projects, revision history, metadata, and retrieval in one local PostgreSQL model.',
    nodes: [
      { label: 'projects', detail: 'workspace' },
      { label: 'documents', detail: 'content + metadata' },
      { label: 'revisions', detail: 'history' },
    ],
    sql: `SELECT d.title, count(r.id) AS revisions
FROM documents d
LEFT JOIN revisions r ON r.document_id = d.id
GROUP BY d.id;`,
    meaning: 'The document, its history, and its metadata remain queryable together.',
  },
  {
    id: 'field',
    title: 'Field and mobile software',
    description:
      'Keep field records in an app-owned root; select PostGIS for nearby-asset queries on supported targets.',
    nodes: [
      { label: 'assets', detail: 'reference data' },
      { label: 'locations', detail: 'PostGIS geography' },
      { label: 'inspections', detail: 'workflow history' },
    ],
    sql: `SELECT id, ST_Distance(location, $1::geography) AS distance_m
FROM assets
WHERE ST_DWithin(location, $1::geography, 5000);`,
    meaning: 'On a target that ships PostGIS, location stays queryable beside field records.',
  },
  {
    id: 'retrieval',
    title: 'Local retrieval',
    description:
      'With vector selected for the target, store embeddings beside source data and combine semantic ranking with relational filters.',
    nodes: [
      { label: 'sources', detail: 'original content' },
      { label: 'embeddings', detail: 'vector' },
      { label: 'metadata', detail: 'relational filters' },
    ],
    sql: `SELECT title
FROM documents
WHERE project_id = $1
ORDER BY embedding <=> $2
LIMIT 8;`,
    meaning: 'The selected vector extension and structured filters run in the same query.',
  },
  {
    id: 'data-tools',
    title: 'Data and developer tools',
    description:
      'Import, inspect, transform, and query complex local datasets with familiar PostgreSQL behavior.',
    nodes: [
      { label: 'imports', detail: 'source records' },
      { label: 'transforms', detail: 'PostgreSQL SQL' },
      { label: 'results', detail: 'queryable data' },
    ],
    sql: `SELECT event_type, count(*)
FROM imported_events
GROUP BY event_type
ORDER BY count(*) DESC;`,
    meaning: 'Imported records and transformations stay inspectable in PostgreSQL.',
  },
];

export function MotionArticle({ className, children }: { className: string; children: ReactNode }) {
  const ref = useRef<HTMLElement | null>(null);
  const inView = useInView(ref, { amount: 0.32, once: true });

  return (
    <article
      className={className}
      data-motion-state={inView ? 'entered' : 'idle'}
      ref={ref}
    >
      {children}
    </article>
  );
}

type RuntimeId = 'direct' | 'broker' | 'server' | 'wasix';

type RuntimeNode = {
  id: string;
  label: string;
  detail: string;
};

type RuntimeGroup = {
  id: string;
  label: string;
  nodes: RuntimeNode[];
};

type RuntimeMode = {
  id: RuntimeId;
  label: string;
  title: string;
  useWhen: string;
  boundary: string;
  groups: RuntimeGroup[];
  routes: string[];
};

const RUNTIME_MODES: readonly RuntimeMode[] = [
  {
    id: 'direct',
    label: 'Native direct',
    title: 'The embedded session',
    useWhen: 'One app database needs the lowest overhead path.',
    boundary: 'One physical PostgreSQL session with serialized work.',
    groups: [
      {
        id: 'application',
        label: 'Application process',
        nodes: [
          { id: 'app', label: 'App code', detail: 'Owns the database handle' },
          { id: 'sdk', label: 'Oliphaunt SDK', detail: 'Serializes calls' },
          { id: 'postgres', label: 'PostgreSQL', detail: 'One physical session' },
        ],
      },
    ],
    routes: ['M72 112H648'],
  },
  {
    id: 'broker',
    label: 'Native broker',
    title: 'A helper-process boundary',
    useWhen: 'A desktop app needs helper-process ownership, multiple roots, or recovery.',
    boundary: 'Helper process boundary for desktop SDKs.',
    groups: [
      {
        id: 'application',
        label: 'Application process',
        nodes: [
          { id: 'app', label: 'App code', detail: 'Owns SDK handles' },
          { id: 'sdk', label: 'Oliphaunt SDK', detail: 'Routes work by root' },
        ],
      },
      {
        id: 'helper',
        label: 'Helper process',
        nodes: [
          { id: 'broker', label: 'Broker', detail: 'Owns the active root' },
          { id: 'postgres', label: 'PostgreSQL', detail: 'One session per root' },
        ],
      },
    ],
    routes: ['M72 112H292C324 112 324 112 356 112H648'],
  },
  {
    id: 'server',
    label: 'Native server',
    title: 'Independent PostgreSQL sessions',
    useWhen: 'A supported target advertises server mode for PostgreSQL clients and tools.',
    boundary: 'PostgreSQL-compatible process boundary with independent client sessions.',
    groups: [
      {
        id: 'clients',
        label: 'PostgreSQL clients',
        nodes: [
          { id: 'app', label: 'App client', detail: 'Connection string' },
          { id: 'tools', label: 'ORM or tools', detail: 'PostgreSQL protocol' },
        ],
      },
      {
        id: 'server',
        label: 'Server process',
        nodes: [
          { id: 'server', label: 'Native server', detail: 'Independent sessions' },
          { id: 'postgres', label: 'PostgreSQL root', detail: 'Managed by the server process' },
        ],
      },
    ],
    routes: ['M72 76H260C316 76 316 112 372 112H648', 'M72 148H260C316 148 316 112 372 112'],
  },
  {
    id: 'wasix',
    label: 'WASM family',
    title: 'The WebAssembly runtime family',
    useWhen: 'The app targets a WASM/WASIX host or deliberately carries portable runtime assets.',
    boundary:
      'Runtime-specific WASM assets with direct Rust or a local PostgreSQL endpoint, depending on the selected API.',
    groups: [
      {
        id: 'host',
        label: 'WASIX host',
        nodes: [
          { id: 'app', label: 'App code', detail: 'Direct API or local URL' },
          { id: 'wasix', label: 'oliphaunt-wasix', detail: 'Own runtime assets' },
          { id: 'postgres', label: 'PostgreSQL', detail: 'Managed by the WASM runtime' },
        ],
      },
    ],
    routes: ['M72 112H648'],
  },
];

type SdkId = 'rust' | 'swift' | 'kotlin' | 'react-native' | 'typescript';
type CodeLanguage = 'rust' | 'swift' | 'kotlin' | 'typescript' | 'c';

type SdkExample = {
  id: SdkId;
  label: string;
  brand: string;
  packageName: string;
  language: CodeLanguage;
  code: string;
};

const SDK_EXAMPLES: readonly SdkExample[] = [
  {
    id: 'rust',
    label: 'Rust',
    brand: 'rust',
    packageName: 'oliphaunt',
    language: 'rust',
    code: `use oliphaunt::Oliphaunt;

async fn open_database() -> oliphaunt::Result<()> {
    let db = Oliphaunt::builder()
        .path(".oliphaunt")
        .native_direct()
        .open()
        .await?;

    db.execute(r#"
        CREATE TABLE IF NOT EXISTS todos (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            title text NOT NULL UNIQUE,
            done boolean NOT NULL DEFAULT false
        )
    "#).await?;
    db.query_params(
        "INSERT INTO todos (title) VALUES ($1) \
         ON CONFLICT (title) DO UPDATE SET done = false",
        ["Run the first product query"],
    ).await?;
    let todos = db
        .query("SELECT title FROM todos WHERE NOT done ORDER BY id DESC LIMIT 20")
        .await?;
    let first_title = todos.get_text(0, "title")?;

    db.close().await?;
    Ok(())
}`,
  },
  {
    id: 'swift',
    label: 'Swift',
    brand: 'swift',
    packageName: 'Oliphaunt',
    language: 'swift',
    code: `let appSupport = FileManager.default.urls(
    for: .applicationSupportDirectory,
    in: .userDomainMask
)[0]

let database = try await OliphauntDatabase.open(
    configuration: OliphauntConfiguration(
        root: appSupport.appending(path: "main.oliphaunt"),
        mode: .nativeDirect,
        extensions: []
    )
)

try await database.execute("""
    CREATE TABLE IF NOT EXISTS todos (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        title text NOT NULL UNIQUE,
        done boolean NOT NULL DEFAULT false
    )
    """)
try await database.query(
    """INSERT INTO todos (title) VALUES ($1)
       ON CONFLICT (title) DO UPDATE SET done = false""",
    parameters: [.text("Run the first product query")]
)
let todos = try await database.query(
    "SELECT title FROM todos WHERE NOT done ORDER BY id DESC LIMIT 20"
)
let firstTitle = try todos.getText(row: 0, column: "title")

try await database.close()`,
  },
  {
    id: 'kotlin',
    label: 'Kotlin',
    brand: 'kotlin',
    packageName: 'dev.oliphaunt:oliphaunt-android',
    language: 'kotlin',
    code: `val database = OliphauntAndroid.open(
    context = applicationContext,
    config = OliphauntConfig(
        root = applicationContext.filesDir.resolve("main.oliphaunt").absolutePath,
        mode = EngineMode.NativeDirect,
        extensions = emptyList(),
    ),
)

database.execute(
    """CREATE TABLE IF NOT EXISTS todos (
       id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
       title text NOT NULL UNIQUE,
       done boolean NOT NULL DEFAULT false
       )""".trimIndent(),
)
database.query(
    """INSERT INTO todos (title) VALUES (${'$'}1)
       ON CONFLICT (title) DO UPDATE SET done = false""".trimIndent(),
    listOf(QueryParam.text("Run the first product query")),
)
val todos = database.query(
    "SELECT title FROM todos WHERE NOT done ORDER BY id DESC LIMIT 20"
)
val firstTitle = todos.getText(row = 0, column = "title")

database.close()`,
  },
  {
    id: 'react-native',
    label: 'React Native',
    brand: 'react',
    packageName: '@oliphaunt/react-native',
    language: 'typescript',
    code: `import { Oliphaunt } from '@oliphaunt/react-native';

const db = await Oliphaunt.open({
  root: 'main.oliphaunt',
  engine: 'nativeDirect',
  extensions: [],
});

await db.execute(\`
  CREATE TABLE IF NOT EXISTS todos (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title text NOT NULL UNIQUE,
    done boolean NOT NULL DEFAULT false
  )
\`);
await db.query(
  \`INSERT INTO todos (title) VALUES ($1)
   ON CONFLICT (title) DO UPDATE SET done = false\`,
  ['Run the first product query'],
);
const todos = await db.query(
  'SELECT title FROM todos WHERE NOT done ORDER BY id DESC LIMIT 20',
);
const firstTitle = todos.getText(0, 'title');

await db.close();`,
  },
  {
    id: 'typescript',
    label: 'TypeScript',
    brand: 'typescript',
    packageName: '@oliphaunt/ts',
    language: 'typescript',
    code: `import { Oliphaunt } from '@oliphaunt/ts';

const db = await Oliphaunt.open({
  engine: 'nativeBroker',
  root: './app-data/main.oliphaunt',
  extensions: [],
});

await db.execute(\`
  CREATE TABLE IF NOT EXISTS todos (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title text NOT NULL UNIQUE,
    done boolean NOT NULL DEFAULT false
  )
\`);
await db.query(
  \`INSERT INTO todos (title) VALUES ($1)
   ON CONFLICT (title) DO UPDATE SET done = false\`,
  ['Run the first product query'],
);
const todos = await db.query(
  'SELECT title FROM todos WHERE NOT done ORDER BY id DESC LIMIT 20',
);
const firstTitle = todos.getText(0, 'title');

await db.close();`,
  },
];

type CodeTokenKind =
  | 'comment'
  | 'constant'
  | 'directive'
  | 'function'
  | 'keyword'
  | 'macro'
  | 'number'
  | 'operator'
  | 'property'
  | 'string'
  | 'type';

type CodeToken = {
  kind?: CodeTokenKind;
  offset: number;
  value: string;
};

type TokenizedCodeLine = {
  number: number;
  tokens: readonly CodeToken[];
};

const CODE_KEYWORDS: Record<CodeLanguage, ReadonlySet<string>> = {
  rust: new Set([
    'as',
    'async',
    'await',
    'break',
    'const',
    'continue',
    'crate',
    'dyn',
    'else',
    'enum',
    'extern',
    'false',
    'fn',
    'for',
    'if',
    'impl',
    'in',
    'let',
    'loop',
    'match',
    'mod',
    'move',
    'mut',
    'pub',
    'ref',
    'return',
    'self',
    'Self',
    'static',
    'struct',
    'super',
    'trait',
    'true',
    'type',
    'unsafe',
    'use',
    'where',
    'while',
  ]),
  swift: new Set([
    'as',
    'await',
    'break',
    'case',
    'catch',
    'class',
    'continue',
    'default',
    'defer',
    'do',
    'else',
    'enum',
    'extension',
    'false',
    'for',
    'func',
    'guard',
    'if',
    'import',
    'in',
    'init',
    'inout',
    'internal',
    'is',
    'let',
    'nil',
    'open',
    'private',
    'protocol',
    'public',
    'repeat',
    'return',
    'self',
    'Self',
    'static',
    'struct',
    'subscript',
    'super',
    'switch',
    'throw',
    'throws',
    'true',
    'try',
    'typealias',
    'var',
    'where',
    'while',
  ]),
  kotlin: new Set([
    'as',
    'break',
    'by',
    'catch',
    'class',
    'companion',
    'const',
    'continue',
    'data',
    'do',
    'else',
    'enum',
    'false',
    'for',
    'fun',
    'if',
    'import',
    'in',
    'interface',
    'is',
    'null',
    'object',
    'package',
    'private',
    'protected',
    'public',
    'return',
    'sealed',
    'super',
    'suspend',
    'this',
    'throw',
    'true',
    'try',
    'typealias',
    'val',
    'var',
    'when',
    'while',
  ]),
  typescript: new Set([
    'as',
    'async',
    'await',
    'break',
    'case',
    'catch',
    'class',
    'const',
    'continue',
    'debugger',
    'default',
    'delete',
    'do',
    'else',
    'enum',
    'export',
    'extends',
    'false',
    'finally',
    'for',
    'from',
    'function',
    'if',
    'implements',
    'import',
    'in',
    'instanceof',
    'interface',
    'let',
    'new',
    'null',
    'private',
    'protected',
    'public',
    'return',
    'static',
    'super',
    'switch',
    'this',
    'throw',
    'true',
    'try',
    'type',
    'typeof',
    'undefined',
    'var',
    'void',
    'while',
    'with',
    'yield',
  ]),
  c: new Set([
    'auto',
    'break',
    'case',
    'char',
    'const',
    'continue',
    'default',
    'do',
    'double',
    'else',
    'enum',
    'extern',
    'float',
    'for',
    'if',
    'inline',
    'int',
    'long',
    'register',
    'restrict',
    'return',
    'short',
    'signed',
    'sizeof',
    'static',
    'struct',
    'switch',
    'typedef',
    'union',
    'unsigned',
    'void',
    'volatile',
    'while',
  ]),
};

const CODE_TYPES: Record<CodeLanguage, ReadonlySet<string>> = {
  rust: new Set([
    'bool',
    'char',
    'f32',
    'f64',
    'i8',
    'i16',
    'i32',
    'i64',
    'isize',
    'str',
    'u8',
    'u16',
    'u32',
    'u64',
    'usize',
  ]),
  swift: new Set(['Any', 'Bool', 'Character', 'Double', 'Float', 'Int', 'String', 'UInt']),
  kotlin: new Set([
    'Any',
    'Boolean',
    'Byte',
    'Char',
    'Double',
    'Float',
    'Int',
    'Long',
    'Short',
    'String',
    'Unit',
  ]),
  typescript: new Set([
    'any',
    'bigint',
    'boolean',
    'never',
    'number',
    'object',
    'string',
    'symbol',
    'unknown',
  ]),
  c: new Set([
    'bool',
    'int8_t',
    'int16_t',
    'int32_t',
    'int64_t',
    'size_t',
    'uint8_t',
    'uint16_t',
    'uint32_t',
    'uint64_t',
  ]),
};

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*/;
const NUMBER_PATTERN = /^(?:0[xX][0-9A-Fa-f]+|\d+(?:\.\d+)?)/;
const OPERATOR_PATTERN = /^(?:::|->|=>|===|!==|==|!=|<=|>=|&&|\|\||\+\+|--|\.\.|[+\-*/%=!<>&|?:.])/;

function pushCodeToken(tokens: CodeToken[], value: string, offset: number, kind?: CodeTokenKind) {
  if (value.length === 0) {
    return;
  }

  const previous = tokens.at(-1);
  if (previous && previous.kind === kind && previous.offset + previous.value.length === offset) {
    previous.value += value;
    return;
  }

  tokens.push({ kind, offset, value });
}

function quotedTokenEnd(line: string, start: number, quote: string) {
  let cursor = start + 1;

  while (cursor < line.length) {
    if (line[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    if (line[cursor] === quote) {
      return cursor + 1;
    }
    cursor += 1;
  }

  return line.length;
}

function identifierKind(
  identifier: string,
  language: CodeLanguage,
  line: string,
  start: number,
  end: number,
): CodeTokenKind | undefined {
  const previousCharacter = line.slice(0, start).trimEnd().at(-1);
  const nextCharacter = line.slice(end).trimStart()[0];
  const isMember = previousCharacter === '.';

  if (isMember && identifier !== 'await') {
    return nextCharacter === '(' ? 'function' : 'property';
  }
  if (CODE_KEYWORDS[language].has(identifier)) {
    return 'keyword';
  }
  if (/^[A-Z][A-Z0-9_]+$/.test(identifier)) {
    return 'constant';
  }
  if (CODE_TYPES[language].has(identifier) || /^[A-Z][A-Za-z0-9_]*$/.test(identifier)) {
    return 'type';
  }
  if (nextCharacter === '!') {
    return 'macro';
  }
  if (nextCharacter === '(') {
    return 'function';
  }
  if (nextCharacter === ':') {
    return 'property';
  }

  return undefined;
}

function tokenizeCodeLine(line: string, language: CodeLanguage, startsInComment: boolean) {
  const tokens: CodeToken[] = [];
  const includeLine = language === 'c' && line.trimStart().startsWith('#include');
  let cursor = 0;
  let inBlockComment = startsInComment;

  while (cursor < line.length) {
    if (inBlockComment) {
      const commentEnd = line.indexOf('*/', cursor);
      const end = commentEnd === -1 ? line.length : commentEnd + 2;
      pushCodeToken(tokens, line.slice(cursor, end), cursor, 'comment');
      cursor = end;
      inBlockComment = commentEnd === -1;
      continue;
    }

    if (line.startsWith('//', cursor)) {
      pushCodeToken(tokens, line.slice(cursor), cursor, 'comment');
      break;
    }
    if (line.startsWith('/*', cursor)) {
      const commentEnd = line.indexOf('*/', cursor + 2);
      const end = commentEnd === -1 ? line.length : commentEnd + 2;
      pushCodeToken(tokens, line.slice(cursor, end), cursor, 'comment');
      cursor = end;
      inBlockComment = commentEnd === -1;
      continue;
    }

    const character = line[cursor];
    if (character === '"' || character === "'" || character === '`') {
      const end = quotedTokenEnd(line, cursor, character);
      pushCodeToken(tokens, line.slice(cursor, end), cursor, 'string');
      cursor = end;
      continue;
    }
    if (includeLine && character === '<') {
      const closingBracket = line.indexOf('>', cursor + 1);
      const end = closingBracket === -1 ? line.length : closingBracket + 1;
      pushCodeToken(tokens, line.slice(cursor, end), cursor, 'string');
      cursor = end;
      continue;
    }
    if (character === '#') {
      const directive = line.slice(cursor).match(/^#[A-Za-z_][A-Za-z0-9_]*/)?.[0];
      if (directive) {
        pushCodeToken(tokens, directive, cursor, 'directive');
        cursor += directive.length;
        continue;
      }
    }

    const remainder = line.slice(cursor);
    const identifier = remainder.match(IDENTIFIER_PATTERN)?.[0];
    if (identifier) {
      const end = cursor + identifier.length;
      pushCodeToken(
        tokens,
        identifier,
        cursor,
        identifierKind(identifier, language, line, cursor, end),
      );
      cursor = end;
      continue;
    }

    const number = remainder.match(NUMBER_PATTERN)?.[0];
    if (number) {
      pushCodeToken(tokens, number, cursor, 'number');
      cursor += number.length;
      continue;
    }

    const operator = remainder.match(OPERATOR_PATTERN)?.[0];
    if (operator) {
      pushCodeToken(tokens, operator, cursor, 'operator');
      cursor += operator.length;
      continue;
    }

    pushCodeToken(tokens, character, cursor);
    cursor += 1;
  }

  return { inBlockComment, tokens };
}

function tokenizeCode(code: string, language: CodeLanguage): readonly TokenizedCodeLine[] {
  let inBlockComment = false;

  return code.split('\n').map((line, index) => {
    const result = tokenizeCodeLine(line, language, inBlockComment);
    inBlockComment = result.inBlockComment;
    return { number: index + 1, tokens: result.tokens };
  });
}

const TOKENIZED_SDK_CODE: ReadonlyMap<SdkId, readonly TokenizedCodeLine[]> = new Map(
  SDK_EXAMPLES.map(
    (example) => [example.id, tokenizeCode(example.code, example.language)] as const,
  ),
);

const EMPTY_CODE_LINES: readonly TokenizedCodeLine[] = [];

type ExtensionOption = {
  id: 'vector' | 'postgis' | 'pg_trgm' | 'pgcrypto';
  extensionDependencies: string[];
  nativeDependencies: string[];
};

const EXTENSION_OPTIONS: readonly ExtensionOption[] = [
  {
    id: 'vector',
    extensionDependencies: [],
    nativeDependencies: [],
  },
  {
    id: 'postgis',
    extensionDependencies: [],
    nativeDependencies: [
      'geos:3.14.1-static',
      'proj:9.8.1-static',
      'sqlite:3.53.1-static',
      'libxml2:2.14.6-static',
      'json-c:0.18-static',
      'libiconv:1.19-static',
    ],
  },
  {
    id: 'pg_trgm',
    extensionDependencies: [],
    nativeDependencies: [],
  },
  {
    id: 'pgcrypto',
    extensionDependencies: [],
    nativeDependencies: ['openssl:3.5.6-libcrypto-wasix-static'],
  },
];

const TAB_SPRING = {
  type: 'spring' as const,
  stiffness: 560,
  damping: 42,
  mass: 0.65,
};

const LAYOUT_SPRING = {
  type: 'spring' as const,
  stiffness: 420,
  damping: 38,
  mass: 0.7,
};

function useMountedReducedMotion() {
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const syncPreference = () => setReduceMotion(media.matches);
    syncPreference();
    media.addEventListener('change', syncPreference);
    return () => media.removeEventListener('change', syncPreference);
  }, []);

  return reduceMotion;
}

function getPanelMotion(reduceMotion: boolean) {
  return {
    initial: reduceMotion ? false : { opacity: 0, y: 8 },
    animate: reduceMotion ? undefined : { opacity: 1, y: 0 },
    exit: reduceMotion ? undefined : { opacity: 0, y: -6 },
    transition: { duration: reduceMotion ? 0 : 0.16, ease: [0.22, 1, 0.36, 1] as const },
  };
}

function getDockMotion(reduceMotion: boolean) {
  return {
    initial: reduceMotion ? false : { opacity: 0, y: -14, scale: 0.96 },
    animate: reduceMotion ? undefined : { opacity: 1, y: 0, scale: 1 },
    exit: reduceMotion ? undefined : { opacity: 0, y: 10, scale: 0.97 },
    transition: reduceMotion ? { duration: 0 } : LAYOUT_SPRING,
  };
}

function useAccessibleTabs<T extends string>(items: readonly { id: T }[], initialId: T) {
  const [selectedId, setSelectedId] = useState<T>(initialId);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) {
    let nextIndex: number | undefined;

    switch (event.key) {
      case 'ArrowRight':
        nextIndex = (currentIndex + 1) % items.length;
        break;
      case 'ArrowLeft':
        nextIndex = (currentIndex - 1 + items.length) % items.length;
        break;
      case 'ArrowDown':
      case 'ArrowUp': {
        const tabList = event.currentTarget.closest<HTMLElement>('[role="tablist"]');
        if (tabList?.getAttribute('aria-orientation') !== 'vertical') {
          return;
        }
        nextIndex =
          event.key === 'ArrowDown'
            ? (currentIndex + 1) % items.length
            : (currentIndex - 1 + items.length) % items.length;
        break;
      }
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = items.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    const nextItem = items[nextIndex];
    setSelectedId(nextItem.id);
    tabRefs.current[nextIndex]?.focus();
  }

  return { selectedId, setSelectedId, tabRefs, onKeyDown };
}

function SqlPreview({ sql }: { sql: string }) {
  const tokenPattern =
    /(\b(?:AS|BY|COUNT|DESC|FROM|GROUP|IS|JOIN|LEFT|LIMIT|NULL|ON|ORDER|SELECT|WHERE)\b|\$\d+)/gi;

  return (
    <code>
      {sql.split('\n').map((line, lineIndex) => (
        <span className="home-use-case-query__line" key={`${lineIndex}-${line}`}>
          {line.split(tokenPattern).map((token, tokenIndex) => {
            const isKeyword = /^(?:AS|BY|COUNT|DESC|FROM|GROUP|IS|JOIN|LEFT|LIMIT|NULL|ON|ORDER|SELECT|WHERE)$/i.test(
              token,
            );
            const isParameter = /^\$\d+$/.test(token);

            if (!isKeyword && !isParameter) {
              return token;
            }

            return (
              <span
                className={
                  isParameter
                    ? 'home-use-case-query__parameter'
                    : 'home-use-case-query__keyword'
                }
                key={`${lineIndex}-${token}-${tokenIndex}`}
              >
                {token}
              </span>
            );
          })}
        </span>
      ))}
    </code>
  );
}

export function ProductUseCaseExplorer() {
  const id = useId();
  const reduceMotion = useMountedReducedMotion();
  const [compactLayout, setCompactLayout] = useState(false);
  const { selectedId, setSelectedId, tabRefs, onKeyDown } = useAccessibleTabs(
    PRODUCT_USE_CASES,
    'workspace',
  );
  const selectedUseCase =
    PRODUCT_USE_CASES.find((useCase) => useCase.id === selectedId) ?? PRODUCT_USE_CASES[0];
  const panelMotion = getPanelMotion(reduceMotion);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 940px)');
    const syncLayout = () => setCompactLayout(media.matches);
    syncLayout();
    media.addEventListener('change', syncLayout);
    return () => media.removeEventListener('change', syncLayout);
  }, []);

  return (
    <LayoutGroup id={`${id}-use-cases`}>
      <div className="home-use-case-explorer" data-active-use-case={selectedUseCase.id}>
        <div
          aria-label="Product use cases"
          aria-orientation={compactLayout ? 'horizontal' : 'vertical'}
          className="home-use-case-tabs"
          role="tablist"
        >
          {PRODUCT_USE_CASES.map((useCase, index) => {
            const selected = useCase.id === selectedUseCase.id;

            return (
              <button
                aria-controls={`${id}-use-case-panel`}
                aria-selected={selected}
                className="home-use-case-tab"
                id={`${id}-use-case-tab-${useCase.id}`}
                key={useCase.id}
                onClick={() => setSelectedId(useCase.id)}
                onKeyDown={(event) => onKeyDown(event, index)}
                ref={(node) => {
                  tabRefs.current[index] = node;
                }}
                role="tab"
                tabIndex={selected ? 0 : -1}
                type="button"
              >
                {selected ? (
                  <motion.span
                    aria-hidden="true"
                    className="home-use-case-tab__highlight"
                    layoutId="use-case-tab-highlight"
                    transition={reduceMotion ? { duration: 0 } : TAB_SPRING}
                  />
                ) : null}
                <span className="home-use-case-tab__copy">
                  <strong>{useCase.title}</strong>
                  <span>{useCase.description}</span>
                </span>
              </button>
            );
          })}
        </div>

        <div className="home-use-case-panel-shell">
          <AnimatePresence initial={false} mode="wait">
            <motion.figure
              {...panelMotion}
              aria-labelledby={`${id}-use-case-tab-${selectedUseCase.id}`}
              className="home-use-case-panel"
              id={`${id}-use-case-panel`}
              key={selectedUseCase.id}
              role="tabpanel"
            >
              <header className="home-use-case-panel__header" key="header">
                <code>main.oliphaunt</code>
                <span>PostgreSQL 18</span>
              </header>

              <div className="home-use-case-model" key="model">
                <svg aria-hidden="true" preserveAspectRatio="none" viewBox="0 0 640 120">
                  <motion.path
                    animate={reduceMotion ? undefined : { opacity: 1, pathLength: 1 }}
                    d="M70 60H570"
                    initial={reduceMotion ? false : { opacity: 0.28, pathLength: 0 }}
                    transition={{
                      duration: reduceMotion ? 0 : 0.62,
                      ease: [0.16, 1, 0.3, 1],
                    }}
                  />
                </svg>
                <ol>
                  {selectedUseCase.nodes.map((node, index) => (
                    <motion.li
                      animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
                      initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                      key={node.label}
                      transition={{
                        duration: reduceMotion ? 0 : 0.34,
                        delay: reduceMotion ? 0 : 0.08 + index * 0.08,
                        ease: [0.16, 1, 0.3, 1],
                      }}
                    >
                      <span aria-hidden="true" />
                      <code>{node.label}</code>
                      <small>{node.detail}</small>
                    </motion.li>
                  ))}
                </ol>
              </div>

              <div className="home-use-case-query" key="query">
                <div className="home-use-case-query__bar">
                  <span>query.sql</span>
                  <span>local root</span>
                </div>
                <pre>
                  <SqlPreview sql={selectedUseCase.sql} />
                </pre>
              </div>

              <figcaption key="meaning">{selectedUseCase.meaning}</figcaption>
            </motion.figure>
          </AnimatePresence>
        </div>
      </div>
    </LayoutGroup>
  );
}

function RuntimeStage({ mode, reduceMotion }: { mode: RuntimeMode; reduceMotion: boolean }) {
  return (
    <figure className="home-runtime-stage" data-runtime={mode.id}>
      <figcaption className="home-runtime-stage__caption">{mode.label} architecture</figcaption>
      <svg
        aria-hidden="true"
        className="home-runtime-stage__routes"
        preserveAspectRatio="none"
        viewBox="0 0 720 224"
      >
        {mode.routes.map((route, index) => (
          <motion.path
            animate={reduceMotion ? undefined : { opacity: 1, pathLength: 1 }}
            className="home-runtime-stage__route"
            d={route}
            data-route={index + 1}
            initial={reduceMotion ? false : { opacity: 0.3, pathLength: 0 }}
            key={route}
            transition={{
              duration: reduceMotion ? 0 : 0.58,
              delay: reduceMotion ? 0 : index * 0.08,
              ease: [0.16, 1, 0.3, 1],
            }}
          />
        ))}
      </svg>
      <ol className="home-runtime-stage__groups">
        {mode.groups.map((group) => (
          <li className="home-runtime-stage__group" data-process={group.id} key={group.id}>
            <span className="home-runtime-stage__group-label">{group.label}</span>
            <ol className="home-runtime-stage__nodes">
              {group.nodes.map((node) => (
                <li
                  className={`home-runtime-stage__node home-runtime-stage__node--${node.id}`}
                  data-node={node.id}
                  key={`${group.id}-${node.id}`}
                >
                  <span className="home-runtime-stage__node-mark" aria-hidden="true" />
                  <span className="home-runtime-stage__node-copy">
                    <strong className="home-runtime-stage__node-label">{node.label}</strong>
                    <span className="home-runtime-stage__node-detail">{node.detail}</span>
                  </span>
                </li>
              ))}
            </ol>
          </li>
        ))}
      </ol>
    </figure>
  );
}

export function RuntimeExplorer() {
  const id = useId();
  const reduceMotion = useMountedReducedMotion();
  const { selectedId, setSelectedId, tabRefs, onKeyDown } = useAccessibleTabs(
    RUNTIME_MODES,
    'direct',
  );
  const selectedMode = RUNTIME_MODES.find((mode) => mode.id === selectedId) ?? RUNTIME_MODES[0];
  const panelMotion = getPanelMotion(reduceMotion);

  return (
    <LayoutGroup id={`${id}-runtime`}>
      <div className="home-runtime-explorer" data-active-runtime={selectedMode.id}>
        <div aria-label="Runtime mode" className="home-runtime-tabs" role="tablist">
          {RUNTIME_MODES.map((mode, index) => {
            const selected = mode.id === selectedMode.id;
            const tabId = `${id}-runtime-tab-${mode.id}`;
            const panelId = `${id}-runtime-panel`;

            return (
              <button
                aria-controls={panelId}
                aria-selected={selected}
                className="home-runtime-tab"
                data-runtime={mode.id}
                id={tabId}
                key={mode.id}
                onClick={() => setSelectedId(mode.id)}
                onKeyDown={(event) => onKeyDown(event, index)}
                ref={(node) => {
                  tabRefs.current[index] = node;
                }}
                role="tab"
                tabIndex={selected ? 0 : -1}
                type="button"
              >
                {selected ? (
                  <motion.span
                    aria-hidden="true"
                    className="home-runtime-tab__highlight"
                    layoutId="runtime-tab-highlight"
                    transition={reduceMotion ? { duration: 0 } : TAB_SPRING}
                  />
                ) : null}
                <span className="home-runtime-tab__label">{mode.label}</span>
              </button>
            );
          })}
        </div>

        <motion.div
          className="home-runtime-panel-shell"
          layout="size"
          transition={reduceMotion ? { duration: 0 } : LAYOUT_SPRING}
        >
          <AnimatePresence initial={false} mode="wait">
            <motion.section
              {...panelMotion}
              aria-labelledby={`${id}-runtime-tab-${selectedMode.id}`}
              className="home-runtime-panel"
              data-runtime={selectedMode.id}
              id={`${id}-runtime-panel`}
              key={selectedMode.id}
              role="tabpanel"
            >
              <div className="home-runtime-panel__copy" key="copy">
                <h3 className="home-runtime-panel__title">{selectedMode.title}</h3>
                <p className="home-runtime-panel__use-when">{selectedMode.useWhen}</p>
                <dl className="home-runtime-panel__facts">
                  <div className="home-runtime-panel__fact">
                    <dt className="home-runtime-panel__term">Runtime contract</dt>
                    <dd className="home-runtime-panel__definition">{selectedMode.boundary}</dd>
                  </div>
                </dl>
              </div>
              <RuntimeStage key="stage" mode={selectedMode} reduceMotion={reduceMotion} />
            </motion.section>
          </AnimatePresence>
        </motion.div>
      </div>
    </LayoutGroup>
  );
}

function CodeLines({ lines }: { lines: readonly TokenizedCodeLine[] }) {
  return (
    <code className="home-code-panel__code">
      {lines.map((line) => (
        <span className="home-code-panel__line" data-line={line.number} key={`line-${line.number}`}>
          <span aria-hidden="true" className="home-code-panel__line-number">
            {String(line.number).padStart(2, '0')}
          </span>
          <span className="home-code-panel__line-content">
            {line.tokens.map((token) =>
              token.kind ? (
                <span
                  className={`home-code-token home-code-token--${token.kind}`}
                  data-token={token.kind}
                  key={`${token.offset}-${token.kind}`}
                >
                  {token.value}
                </span>
              ) : (
                token.value
              ),
            )}
          </span>
        </span>
      ))}
    </code>
  );
}

export function SdkCodeExplorer() {
  const id = useId();
  const reduceMotion = useMountedReducedMotion();
  const { selectedId, setSelectedId, tabRefs, onKeyDown } = useAccessibleTabs(SDK_EXAMPLES, 'rust');
  const [copyState, setCopyState] = useState<{
    sdk: SdkId;
    status: 'copied' | 'failed';
  } | null>(null);
  const selectedSdk = SDK_EXAMPLES.find((sdk) => sdk.id === selectedId) ?? SDK_EXAMPLES[0];
  const selectedCodeLines = TOKENIZED_SDK_CODE.get(selectedSdk.id) ?? EMPTY_CODE_LINES;
  const panelMotion = getPanelMotion(reduceMotion);
  const selectedCopyState = copyState?.sdk === selectedSdk.id ? copyState.status : 'idle';

  useEffect(() => {
    if (!copyState) {
      return;
    }

    const timeout = window.setTimeout(() => setCopyState(null), 1800);
    return () => window.clearTimeout(timeout);
  }, [copyState]);

  return (
    <LayoutGroup id={`${id}-sdk`}>
      <div className="home-sdk-explorer" data-active-sdk={selectedSdk.id}>
        <div aria-label="Language SDKs" className="home-sdk-tabs" role="tablist">
          {SDK_EXAMPLES.map((sdk, index) => {
            const selected = sdk.id === selectedSdk.id;

            return (
              <button
                aria-controls={`${id}-sdk-panel`}
                aria-selected={selected}
                className="home-sdk-tab"
                data-sdk={sdk.id}
                id={`${id}-sdk-tab-${sdk.id}`}
                key={sdk.id}
                onClick={() => {
                  setSelectedId(sdk.id);
                  setCopyState(null);
                }}
                onKeyDown={(event) => onKeyDown(event, index)}
                ref={(node) => {
                  tabRefs.current[index] = node;
                }}
                role="tab"
                tabIndex={selected ? 0 : -1}
                type="button"
              >
                {selected ? (
                  <motion.span
                    aria-hidden="true"
                    className="home-sdk-tab__highlight"
                    layoutId="sdk-tab-highlight"
                    transition={reduceMotion ? { duration: 0 } : TAB_SPRING}
                  />
                ) : null}
                <span className="home-sdk-tab__content">
                  <BrandIcon className="home-sdk-tab__icon" id={sdk.brand} />
                  <span className="home-sdk-tab__label">{sdk.label}</span>
                </span>
              </button>
            );
          })}
        </div>

        <motion.div
          className="home-code-panel-shell"
          layout="size"
          transition={reduceMotion ? { duration: 0 } : LAYOUT_SPRING}
        >
          <AnimatePresence initial={false} mode="wait">
            <motion.section
              {...panelMotion}
              aria-labelledby={`${id}-sdk-tab-${selectedSdk.id}`}
              className="home-code-panel"
              data-language={selectedSdk.language}
              data-sdk={selectedSdk.id}
              id={`${id}-sdk-panel`}
              key={selectedSdk.id}
              role="tabpanel"
            >
              <header className="home-code-panel__header" key="header">
                <span className="home-code-panel__identity">
                  <BrandIcon className="home-code-panel__brand" id={selectedSdk.brand} />
                  <span className="home-code-panel__language">{selectedSdk.label}</span>
                </span>
                <span className="home-code-panel__tools">
                  <code className="home-code-panel__package">{selectedSdk.packageName}</code>
                  <button
                    aria-label={`Copy ${selectedSdk.label} example`}
                    className="home-code-panel__copy"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(selectedSdk.code);
                        setCopyState({ sdk: selectedSdk.id, status: 'copied' });
                      } catch {
                        setCopyState({ sdk: selectedSdk.id, status: 'failed' });
                      }
                    }}
                    type="button"
                  >
                    <svg aria-hidden="true" viewBox="0 0 16 16">
                      {selectedCopyState === 'copied' ? (
                        <path d="m3.5 8.2 2.8 2.7 6.2-6.1" />
                      ) : (
                        <path d="M5.5 5.5h7v7h-7zM3.5 10.5h-1v-7h7v1" />
                      )}
                    </svg>
                    <span aria-live="polite">
                      {selectedCopyState === 'copied'
                        ? 'Copied'
                        : selectedCopyState === 'failed'
                          ? 'Copy failed'
                          : 'Copy'}
                    </span>
                  </button>
                </span>
              </header>
              <pre
                aria-label={`${selectedSdk.label} Oliphaunt example. Scroll horizontally to read long lines.`}
                className="home-code-panel__pre"
                key="code"
                tabIndex={0}
              >
                <CodeLines lines={selectedCodeLines} />
              </pre>
              <span aria-hidden="true" className="home-code-panel__scroll-hint" key="scroll-hint">
                Scroll code <span>→</span>
              </span>
            </motion.section>
          </AnimatePresence>
        </motion.div>
      </div>
    </LayoutGroup>
  );
}

function dependencyCount(option: ExtensionOption) {
  return option.extensionDependencies.length + option.nativeDependencies.length;
}

function dependencyLabel(option: ExtensionOption) {
  const count = dependencyCount(option);

  if (count === 0) {
    return 'No declared dependencies';
  }

  return `${count} declared ${count === 1 ? 'dependency' : 'dependencies'}`;
}

function compactDependencyLabel(option: ExtensionOption) {
  const count = dependencyCount(option);
  return count === 0 ? '0 dependencies' : `${count} ${count === 1 ? 'dependency' : 'dependencies'}`;
}

export function ExtensionPacker() {
  const reduceMotion = useMountedReducedMotion();
  const [selectedIds, setSelectedIds] = useState<ExtensionOption['id'][]>(['vector']);
  const selectedOptions = EXTENSION_OPTIONS.filter((option) => selectedIds.includes(option.id));
  const selectedWithDependencies = selectedOptions.filter((option) => dependencyCount(option) > 0);
  const selectedDependencyCount = selectedOptions.reduce(
    (total, option) => total + dependencyCount(option),
    0,
  );
  const dockMotion = getDockMotion(reduceMotion);

  function toggleExtension(id: ExtensionOption['id']) {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((selectedId) => selectedId !== id) : [...current, id],
    );
  }

  return (
    <div className="home-extension-packer" data-selected-count={selectedOptions.length}>
      <fieldset className="home-extension-options">
        <legend className="home-extension-options__legend">Select exact SQL extension names</legend>
        <div className="home-extension-options__grid">
          {EXTENSION_OPTIONS.map((option) => {
            const selected = selectedIds.includes(option.id);

            return (
              <label
                className="home-extension-option"
                data-extension={option.id}
                data-selected={selected}
                key={option.id}
              >
                <input
                  checked={selected}
                  className="home-extension-option__input"
                  name="oliphaunt-extension"
                  onChange={() => toggleExtension(option.id)}
                  type="checkbox"
                  value={option.id}
                />
                <span aria-hidden="true" className="home-extension-option__control">
                  <AnimatePresence initial={false}>
                    {selected ? (
                      <motion.svg
                        animate={reduceMotion ? undefined : { opacity: 1, scale: 1 }}
                        className="home-extension-option__check"
                        exit={reduceMotion ? undefined : { opacity: 0, scale: 0.7 }}
                        initial={reduceMotion ? false : { opacity: 0, scale: 0.7 }}
                        key="check"
                        transition={{ duration: reduceMotion ? 0 : 0.12 }}
                        viewBox="0 0 12 12"
                      >
                        <path d="M2.2 6.1 4.8 8.7 9.9 3.5" key="mark" />
                      </motion.svg>
                    ) : null}
                  </AnimatePresence>
                </span>
                <span className="home-extension-option__copy">
                  <code className="home-extension-option__name">{option.id}</code>
                  <span className="home-extension-option__dependencies">
                    {dependencyLabel(option)}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <section className="home-extension-output" aria-label="Selected extension package">
        <header className="home-extension-output__header">
          <span className="home-extension-output__title">App package</span>
          <output aria-live="polite" className="home-extension-output__summary">
            {selectedOptions.length === 0
              ? 'No optional extensions selected'
              : `${selectedOptions.length} ${selectedOptions.length === 1 ? 'extension' : 'extensions'} · ${selectedDependencyCount} added ${selectedDependencyCount === 1 ? 'dependency' : 'dependencies'}`}
          </output>
        </header>

        <div className="home-extension-dock" data-empty={selectedOptions.length === 0}>
          <div className="home-extension-dock__base">
            <span className="home-extension-dock__base-label">Selected extension artifacts</span>
          </div>
          <div className="home-extension-dock__slots">
            <AnimatePresence initial={false} mode="popLayout">
              {selectedOptions.map((option, index) => (
                <motion.div
                  {...dockMotion}
                  className="home-extension-dock__item"
                  data-extension={option.id}
                  key={option.id}
                  layout
                  style={{ '--home-dock-index': index } as CSSProperties}
                >
                  <span className="home-extension-dock__grip" aria-hidden="true" key="grip" />
                  <code className="home-extension-dock__name" key="name">
                    {option.id}
                  </code>
                  <span className="home-extension-dock__dependency-count" key="dependency-count">
                    {compactDependencyLabel(option)}
                  </span>
                </motion.div>
              ))}
            </AnimatePresence>
            {selectedOptions.length === 0 ? (
              <motion.p
                animate={reduceMotion ? undefined : { opacity: 1 }}
                className="home-extension-dock__empty"
                initial={reduceMotion ? false : { opacity: 0 }}
                transition={{ duration: reduceMotion ? 0 : 0.12 }}
              >
                Optional extension slots are empty.
              </motion.p>
            ) : null}
          </div>
        </div>

        <div className="home-extension-manifest">
          <h3 className="home-extension-manifest__title">Added dependency artifacts</h3>
          <AnimatePresence initial={false} mode="popLayout">
            {selectedWithDependencies.map((option) => (
              <motion.div
                {...dockMotion}
                className="home-extension-manifest__item"
                data-extension={option.id}
                key={option.id}
                layout
              >
                <code className="home-extension-manifest__name" key="name">
                  {option.id}
                </code>
                <dl className="home-extension-manifest__dependencies" key="dependencies">
                  {option.extensionDependencies.length > 0 ? (
                    <div className="home-extension-manifest__dependency-row">
                      <dt className="home-extension-manifest__term">Extension</dt>
                      <dd className="home-extension-manifest__definition">
                        {option.extensionDependencies.join(', ')}
                      </dd>
                    </div>
                  ) : null}
                  {option.nativeDependencies.length > 0 ? (
                    <div className="home-extension-manifest__dependency-row">
                      <dt className="home-extension-manifest__term">Native</dt>
                      <dd className="home-extension-manifest__definition">
                        {option.nativeDependencies.join(', ')}
                      </dd>
                    </div>
                  ) : null}
                </dl>
              </motion.div>
            ))}
          </AnimatePresence>
          {selectedWithDependencies.length === 0 ? (
            <p className="home-extension-manifest__empty">No added dependency artifacts.</p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
