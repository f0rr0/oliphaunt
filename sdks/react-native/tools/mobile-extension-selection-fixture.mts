import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORE_SNOWBALL_RUNTIME_DATA_FILES } from './validate-mobile-runtime-files.mts';

const destination = process.argv[2];
if (!destination) throw new Error('expected a disposable fixture directory');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const metadata = JSON.parse(
  readFileSync(path.join(root, 'extensions/generated/sdk/extensions.json'), 'utf8'),
);
const registry = JSON.parse(
  readFileSync(path.join(root, 'extensions/generated/mobile/static-registry.json'), 'utf8'),
);
mkdirSync(destination, { recursive: true });
const prefix = 'assets/oliphaunt/runtime/files/';
function list(name: string, sql: string[], data: string[] = []) {
  const files = [
    ...CORE_SNOWBALL_RUNTIME_DATA_FILES,
    ...sql.map((file) => `share/postgresql/extension/${file}`),
    ...data,
  ];
  writeFileSync(
    path.join(destination, `${name}.txt`),
    `${files.map((file) => prefix + file).join('\n')}\n`,
  );
  return files;
}
const pgtap = [
  'pgtap.control',
  'pgtap--1.0.sql',
  'pgtap--1.0--1.1.sql',
  'pgtap.sql',
  'pgtap-core--1.1.sql',
  'pgtap-schema.sql',
  'uninstall_pgtap.sql',
];
const files = list('pgtap', pgtap);
list(
  'postgis',
  [
    'postgis.control',
    'postgis--1.0.sql',
    'postgis_comments.sql',
    'postgis_proc_set_search_path--1.0.sql',
    'rtpostgis.sql',
    'uninstall_postgis.sql',
  ],
  registry.modules.find((row) => row['sql-name'] === 'postgis')['data-files'],
);
list('unselected', ['pgtap-core--1.1.sql']);
list('undeclared', ['foreign--1.0.sql']);
list(
  'ancillary-only',
  pgtap.filter((file) => !file.startsWith('pgtap--')),
);
for (const relative of files) {
  const file = path.join(destination, 'runtime', relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    relative.endsWith('/pgtap.control') ? "default_version = '1.1'\n" : '-- fixture\n',
  );
}
metadata.extensions.find((row) => row['sql-name'] === 'vector')['extension-sql-file-prefixes'] = [
  'pgtap-core',
];
writeFileSync(path.join(destination, 'ambiguous.json'), JSON.stringify(metadata));
