/** Independent byte oracle for the pre-existing PostGIS MSVC source rewrites. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareWindowsSources, type WindowsSourceInputs } from '../windows_source_inputs.mts';

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const read = (file: string) => utf8.decode(readFileSync(file));
const companions = ['oliphaunt_flatgeobuf_windows_compat.h', 'oliphaunt_postgis_windows_compat.h'];

// Captured from windows-extension-sources.mts before 3b7718a9. Do not call the
// shared transform to compute expected bytes: this checks its extraction.
function oldPostgisSource(file: string, text: string): string {
  if (
    /^(postgis|libpgcommon|liblwgeom|raster\/rt_core|raster\/rt_pg|topology)\/.*\.[ch]$/u.test(file)
  ) {
    text = text.replace(
      /^[ \t]*(?!(?:extern\s+)?PGDLLEXPORT\s+)(?:extern\s+)?Datum\s+(\w+)\s*\(PG_FUNCTION_ARGS\);\r?$/gm,
      'extern PGDLLEXPORT Datum $1(PG_FUNCTION_ARGS);',
    );
    text = text.replace(
      '# define __attribute__ (x)',
      '# ifndef __attribute__\n#  define __attribute__(x)\n# endif',
    );
  }
  if (file === 'topology/postgis_topology.c') {
    for (const hook of ['_PG_init', '_PG_fini']) {
      const before = `void ${hook}(void);`;
      assert.equal(text.split(before).length - 1, 1, `pinned topology hook anchor ${hook}`);
      text = text.replace(before, `PGDLLEXPORT ${before}`);
    }
  }
  if (file === 'postgis/postgis_legacy.c') {
    const macro = /^([ \t]*)Datum[ \t]+funcname[ \t]*\(PG_FUNCTION_ARGS\);[ \t]*\\\r?$/gm;
    assert.equal([...text.matchAll(macro)].length, 1, 'pinned funcname macro anchor');
    text = text.replace(macro, '$1extern PGDLLEXPORT Datum funcname(PG_FUNCTION_ARGS); \\');
  }
  if (file === 'deps/flatgeobuf/geometryreader.cpp') {
    const replacements = [
      ['pt = (POINT4D) { x, y, z, m };', 'pt.x = x;\npt.y = y;\npt.z = z;\npt.m = m;'],
      ['pt = (POINT4D) { xv, yv, zv, mv };', 'pt.x = xv;\npt.y = yv;\npt.z = zv;\npt.m = mv;'],
    ];
    for (const [before, after] of replacements) {
      assert.equal(text.split(before).length - 1, 1, `pinned POINT4D anchor: ${before}`);
      text = text.replace(before, after);
    }
  }
  return text;
}

// Independent literal oracle for every external-inline definition in the pin.
// Keep the historical source rewrites above intact; production has no name list.
const externalInlineSignatures: Record<string, string[]> = {
  'postgis/gserialized_gist_2d.c': [
    'bool box2df_is_empty(',
    'void box2df_set_empty(',
    'void box2df_set_finite(',
    'void box2df_validate(',
  ],
  'postgis/gserialized_gist_nd.c': ['bool\ngidx_is_unknown('],
  'liblwgeom/lwgeom_api.c': ['float\nnext_float_down(', 'float\nnext_float_up('],
  'liblwgeom/lwlinearreferencing.c': [
    'double\nlwpoint_get_ordinate(',
    'void\nlwpoint_set_ordinate(',
    'int\npoint_interpolate(',
  ],
  'liblwgeom/measures.c': ['double\ndistance2d_pt_pt('],
  'postgis/unit.c': ['int external_body(', 'int extern_body('],
};

function expectedPostgisSource(file: string, original: string): string {
  let text = oldPostgisSource(file, original);
  for (const signature of externalInlineSignatures[file] ?? []) {
    const before = `inline ${signature}`;
    assert.equal(
      text.split(before).length - 1,
      1,
      `pinned external inline anchor: ${file} ${signature}`,
    );
    text = text.replace(before, signature);
  }
  return text;
}

function verifySources(
  spec: WindowsSourceInputs,
  expected: { name: string; source: string }[],
  outputs: string[],
  declared: (file: string) => string,
): number {
  assert.equal(spec.extension, 'postgis');
  assert.deepEqual(spec.headers, [], 'PostGIS companions are copied inputs');
  const names = spec.files.map((row) => row.name);
  assert.equal(new Set(names).size, names.length, 'unique prepared source names');
  assert.deepEqual(
    [...names].sort(),
    expected.map((row) => row.name).sort(),
    'exact source roster',
  );
  assert.deepEqual(
    spec.files.map((row) => row.output).sort(),
    [...outputs].sort(),
    'exact output roster',
  );
  assert.equal(new Set(outputs).size, outputs.length, 'unique prepared output paths');
  assert.deepEqual(names.filter((name) => companions.includes(name)).sort(), companions);
  assert(names.includes('postgis/postgis_legacy.c'));
  assert(names.includes('deps/flatgeobuf/geometryreader.cpp'));
  const inputs = new Map(expected.map((row) => [row.name, row.source]));
  const roots = new Set<string>();
  let changed = 0;
  for (const row of spec.files) {
    assert(
      !row.name.includes('\\') &&
        row.name.split('/').every((part) => part && part !== '.' && part !== '..'),
    );
    assert.equal(row.source, inputs.get(row.name), `declared original for ${row.name}`);
    assert(row.output.endsWith('/' + row.name), `prepared filename for ${row.name}`);
    roots.add(row.output.slice(0, -row.name.length));
    const original = read(declared(row.source));
    const after = expectedPostgisSource(row.name, original);
    assert.deepEqual(
      readFileSync(declared(row.output)),
      Buffer.from(after),
      `source bytes: ${row.name}`,
    );
    if (companions.includes(row.name))
      assert.deepEqual(
        readFileSync(declared(row.output)),
        readFileSync(declared(row.source)),
        `unchanged companion: ${row.name}`,
      );
    if (after !== original) changed++;
  }
  assert.equal(roots.size, 1, 'one prepared source root');
  assert(changed > 0, 'actual pinned source adaptations were exercised');
  return changed;
}

interface SourceTestInventory {
  schema: string;
  source: Record<string, any>;
  pin: string;
  anchor: string;
  spec: string;
  expected: { name: string; source: string }[];
  outputs: string[];
  runfiles: Record<string, string>;
}

function verifyInventory(inventory: SourceTestInventory, runfiles: string): number {
  assert.equal(inventory.schema, 'oliphaunt-postgis-windows-source-test-v1');
  const declared = (file: string): string => {
    const relative = inventory.runfiles[file];
    assert(
      relative && !path.isAbsolute(relative) && !relative.includes('\\'),
      `undeclared or unsafe runfile: ${file}`,
    );
    assert(relative.split('/').every((part) => part && part !== '.' && part !== '..'));
    return path.join(runfiles, relative);
  };
  const pin = Bun.TOML.parse(read(declared(inventory.pin))) as Record<string, any>;
  assert.deepEqual(
    Object.fromEntries(Object.keys(inventory.source).map((key) => [key, pin[key]])),
    inventory.source,
    'canonical declared PostGIS source pin',
  );
  assert(/^[0-9a-f]{40}$/u.test(inventory.source.commit));
  assert.equal(inventory.source.name, 'postgis');
  const version = Object.fromEntries(
    [...read(declared(inventory.anchor)).matchAll(/^(POSTGIS_\w+_VERSION)=(.*)$/gm)].map(
      (match) => [match[1], match[2]],
    ),
  );
  assert.equal(
    ['MAJOR', 'MINOR', 'MICRO'].map((part) => version[`POSTGIS_${part}_VERSION`]).join('.'),
    inventory.source['extension-control']['default-version'],
    'pinned source Version.config',
  );
  return verifySources(
    JSON.parse(read(declared(inventory.spec))),
    inventory.expected,
    inventory.outputs,
    declared,
  );
}

function fixtureTests(): void {
  const root = mkdtempSync(path.join(tmpdir(), 'postgis-windows-source-test-'));
  try {
    const fixture: Record<string, string> = {
      'postgis/unit.c':
        '/* π */\r\n  Datum one(PG_FUNCTION_ARGS);\r\nextern PGDLLEXPORT Datum done(PG_FUNCTION_ARGS);\r\nextern Datum unrelated(void);\r\ninline int external_body(void) { return 1; }\r\nextern inline int extern_body(void) { return 2; }\r\nstatic inline int local_body(void) { return 3; }\r\ninline static int reverse_body(void) { return 4; }\r\n',
      'libpgcommon/unit.h': 'extern Datum two(PG_FUNCTION_ARGS);\n',
      'liblwgeom/nested/unit.h': 'Datum three(PG_FUNCTION_ARGS);\n',
      'postgis/postgis_legacy.c': '\tDatum funcname(PG_FUNCTION_ARGS); \\\r\n',
      'deps/flatgeobuf/geometryreader.cpp':
        'pt = (POINT4D) { x, y, z, m };\npt = (POINT4D) { xv, yv, zv, mv };\n',
      'deps/unrelated.h': 'Datum unchanged(PG_FUNCTION_ARGS);\r\n',
      'oliphaunt_flatgeobuf_windows_compat.h': '/* exact flatgeobuf companion bytes λ */\r\n',
      'oliphaunt_postgis_windows_compat.h': '/* exact PostGIS companion bytes λ */\r\n',
    };
    const spec: WindowsSourceInputs = { extension: 'postgis', files: [], headers: [] };
    for (const [name, text] of Object.entries(fixture)) {
      const source = path.join(root, 'original', name);
      mkdirSync(path.dirname(source), { recursive: true });
      writeFileSync(source, text);
      spec.files.push({
        name,
        source,
        output: path.join(root, 'prepared', name).replaceAll('\\', '/'),
      });
    }
    prepareWindowsSources(spec);
    const expected = spec.files.map(({ name, source }) => ({ name, source }));
    const outputs = spec.files.map(({ output }) => output);
    assert.equal(
      verifySources(spec, expected, outputs, (file) => file),
      5,
    );
    assert.throws(
      () =>
        verifySources({ ...spec, files: spec.files.slice(1) }, expected, outputs, (file) => file),
      /source roster/u,
    );
    assert.throws(
      () =>
        verifySources(
          { ...spec, files: [...spec.files, spec.files[0]] },
          expected,
          outputs,
          (file) => file,
        ),
      /unique prepared/u,
    );
    assert.throws(
      () => verifySources(spec, expected, outputs.slice(1), (file) => file),
      /output roster/u,
    );
    const wrongSource = structuredClone(spec);
    wrongSource.files[0].source = spec.files[1].source;
    assert.throws(
      () => verifySources(wrongSource, expected, outputs, (file) => file),
      /declared original/u,
    );
    writeFileSync(spec.files[0].output, 'incorrect transformation');
    assert.throws(() => verifySources(spec, expected, outputs, (file) => file), /source bytes/u);
    prepareWindowsSources(spec);
    const copiedHeader = spec.files.find((row) => companions.includes(row.name))!;
    writeFileSync(copiedHeader.output, 'changed compatibility header');
    assert.throws(() => verifySources(spec, expected, outputs, (file) => file), /source bytes/u);
    prepareWindowsSources(spec);
    // This identity belongs only to the temporary fixture. Actual source proof
    // receives its identity from canonical metadata and declared source.toml.
    const pin = path.join(root, 'source.toml');
    const anchor = path.join(root, 'Version.config');
    const specFile = path.join(root, 'inputs.json');
    const source = {
      name: 'postgis',
      commit: '1'.repeat(40),
      'extension-control': { 'default-version': '1.2.3' },
    };
    writeFileSync(
      pin,
      `name = "postgis"\ncommit = "${source.commit}"\n[extension-control]\ndefault-version = "1.2.3"\n`,
    );
    writeFileSync(
      anchor,
      'POSTGIS_MAJOR_VERSION=1\nPOSTGIS_MINOR_VERSION=2\nPOSTGIS_MICRO_VERSION=3\n',
    );
    writeFileSync(specFile, JSON.stringify(spec));
    const inventory: SourceTestInventory = {
      schema: 'oliphaunt-postgis-windows-source-test-v1',
      source,
      pin,
      anchor,
      spec: specFile,
      expected,
      outputs,
      runfiles: Object.fromEntries(
        [pin, anchor, specFile, ...expected.map((row) => row.source), ...outputs].map((file) => [
          file,
          path.relative(root, file).replaceAll('\\', '/'),
        ]),
      ),
    };
    assert.equal(verifyInventory(inventory, root), 5);
    assert.throws(
      () => verifyInventory({ ...inventory, source: { ...source, commit: '2'.repeat(40) } }, root),
      /source pin/u,
    );
    writeFileSync(
      anchor,
      'POSTGIS_MAJOR_VERSION=9\nPOSTGIS_MINOR_VERSION=2\nPOSTGIS_MICRO_VERSION=3\n',
    );
    assert.throws(() => verifyInventory(inventory, root), /Version.config/u);
    assert.throws(() => verifyInventory({ ...inventory, runfiles: {} }, root), /undeclared/u);
    for (const invalid of ['', fixture['postgis/postgis_legacy.c'].repeat(2)])
      assert.throws(() => oldPostgisSource('postgis/postgis_legacy.c', invalid), /funcname/u);
    for (const invalid of ['', fixture['deps/flatgeobuf/geometryreader.cpp'].repeat(2)])
      assert.throws(
        () => oldPostgisSource('deps/flatgeobuf/geometryreader.cpp', invalid),
        /POINT4D/u,
      );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

fixtureTests();
const [inventory, runfiles, ...extra] = process.argv.slice(2);
assert(
  !extra.length && Boolean(inventory) === Boolean(runfiles),
  'expected optional inventory JSON and runfiles root',
);
if (inventory) {
  const changed = verifyInventory(JSON.parse(read(inventory)), runfiles);
  console.log(
    `Declared PostGIS Windows source bytes match the reviewed adaptations (${changed} changed files).`,
  );
} else {
  console.log('PostGIS Windows source oracle fixtures and rejection checks passed.');
}
