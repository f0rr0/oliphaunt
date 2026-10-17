import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    spec: { type: 'string' },
    install: { type: 'string' },
    smoke: { type: 'string' },
    startup: { type: 'string' },
    environment: { type: 'string' },
    dependencies: { type: 'string' },
  },
  strict: true,
});
assert(
  values.spec &&
    values.install &&
    values.smoke &&
    values.startup &&
    values.environment &&
    values.dependencies,
);
const spec = JSON.parse(readFileSync(values.spec, 'utf8'));
assert.equal(spec.schema, 'oliphaunt-native-extension-smoke-plan-v1');
const members = new Map<string, any>(spec.members.map((row: any) => [row.sql_name, row]));
assert.equal(members.size, spec.members.length, 'duplicate SQL member in smoke plan');
const order: any[] = [];
const visiting = new Set<string>();
const visited = new Set<string>();
function visit(sql: string) {
  assert(!visiting.has(sql), `extension dependency cycle at ${sql}`);
  if (visited.has(sql)) return;
  const row = members.get(sql);
  assert(row, `extension dependency ${sql} has no candidate payload`);
  visiting.add(sql);
  for (const dependency of row.dependencies) {
    if (dependency === 'plpgsql') continue;
    visit(dependency);
  }
  visiting.delete(sql);
  visited.add(sql);
  order.push(row);
}
for (const name of [...members.keys()].sort()) visit(name);
const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const install: string[] = [];
const smoke: string[] = [];
const startup = new Map<string, string>();
const preload = new Set<string>();
const environment = new Map<string, string>();
const dependencies = new Set<string>();
for (const row of order) {
  const lifecycle = row.lifecycle;
  for (const path of row.dependency_modules ?? []) {
    assert(
      /^lib\/postgresql\/[A-Za-z0-9_.-]+\.(?:so|dylib|dll)$/u.test(path),
      `invalid native dependency module for ${row.sql_name}`,
    );
    dependencies.add(path.slice('lib/postgresql/'.length));
  }
  for (const setting of row.runtime_environment ?? []) {
    const { name, path, required_file: requiredFile } = setting;
    assert(/^[A-Z_][A-Z0-9_]*$/.test(name), `invalid runtime environment name for ${row.sql_name}`);
    for (const relative of [path, requiredFile]) {
      assert(
        typeof relative === 'string' &&
          relative &&
          relative
            .split('/')
            .every((part) => part && part !== '.' && part !== '..' && !/[\\\t\r\n]/.test(part)),
        `invalid runtime environment path for ${row.sql_name}`,
      );
    }
    const value = `${path}\t${requiredFile}`;
    assert(
      !environment.has(name) || environment.get(name) === value,
      `conflicting runtime environment ${name}`,
    );
    environment.set(name, value);
  }
  for (const assignment of lifecycle['startup-config'] ?? []) {
    const separator = assignment.indexOf('=');
    assert(
      separator > 0 && !assignment.includes('\n'),
      `invalid startup assignment for ${row.sql_name}`,
    );
    const key = assignment.slice(0, separator);
    const value = assignment.slice(separator + 1);
    if (key === 'shared_preload_libraries') {
      for (const library of value.split(',')) preload.add(library.trim());
    } else {
      assert(!startup.has(key) || startup.get(key) === value, `conflicting startup setting ${key}`);
      startup.set(key, value);
    }
  }
  if (lifecycle['create-extension']) {
    assert(typeof row.default_version === 'string' && row.default_version);
    // Native consumers use PostgreSQL's installed control/SQL schema contract.
    // The catalog's create-schema is consumed by the WASIX activation harness.
    install.push(`CREATE EXTENSION IF NOT EXISTS ${identifier(row.sql_name)};`);
    install.push(
      `DO $oliphaunt_version$ BEGIN IF (SELECT extversion FROM pg_extension WHERE extname = ${literal(row.sql_name)}) IS DISTINCT FROM ${literal(row.default_version)} THEN RAISE EXCEPTION 'candidate extension version differs for %', ${literal(row.sql_name)}; END IF; END $oliphaunt_version$;`,
    );
  }
  install.push(...(lifecycle['load-sql'] ?? []), ...(lifecycle['post-create-sql'] ?? []));
  const fixture = readFileSync(row.fixture, 'utf8');
  assert(fixture.trim(), `empty smoke fixture for ${row.sql_name}`);
  const statements = fixture
    .split('-- oliphaunt-statement')
    .map((sql: string) => sql.trim())
    .filter(Boolean);
  assert(statements.length, `empty smoke fixture for ${row.sql_name}`);
  smoke.push(...statements.map((sql: string) => `-- Candidate extension ${row.sql_name}\n${sql}`));
}
if (preload.size) startup.set('shared_preload_libraries', [...preload].sort().join(','));
const separator = '\n-- oliphaunt-statement\n';
writeFileSync(values.install, `${install.join(separator)}\n`);
writeFileSync(
  values.smoke,
  `${[...smoke, "SELECT 'candidate-extension-smoke-ok';"].join(separator)}\n`,
);
writeFileSync(
  values.startup,
  [...startup]
    .sort()
    .map(([key, value]) => `${key}=${value}\n`)
    .join(''),
);
writeFileSync(
  values.environment,
  [...environment]
    .sort()
    .map(([name, value]) => `${name}\t${value}\n`)
    .join(''),
);
writeFileSync(
  values.dependencies,
  [...dependencies]
    .sort()
    .map((name) => `${name}\n`)
    .join(''),
);
