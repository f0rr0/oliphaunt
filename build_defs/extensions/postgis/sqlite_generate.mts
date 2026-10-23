/** Invoke SQLite's pinned upstream generators using declared execution tools. */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: Object.fromEntries(
    ['source', 'output', 'jim', 'lemon', 'mksourceid', 'mkkeywordhash'].map((name) => [
      name,
      { type: 'string' },
    ]),
  ),
});
for (const name of ['source', 'output', 'jim', 'lemon', 'mksourceid', 'mkkeywordhash']) {
  if (!values[name]) throw new Error(`missing --${name}`);
}
const source = resolve(values.source as string);
const output = resolve(values.output as string);
const tools = Object.fromEntries(
  ['jim', 'lemon', 'mksourceid', 'mkkeywordhash'].map((name) => [
    name,
    resolve(values[name] as string),
  ]),
);
const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'sqlite-generators-'));
mkdirSync(output, { recursive: true });

function run(tool: string, args: string[], stdout?: string, stdin?: Uint8Array): void {
  // Upstream Tcl also parses paths as list elements, which interpret backslashes.
  if (process.platform === 'win32') args = args.map((argument) => argument.replaceAll('\\', '/'));
  const result = Bun.spawnSync([tool, ...args], {
    cwd: work,
    env: { ...process.env, LC_ALL: 'C', TCLLIBPATH: '', TCL_LIBRARY: '', JIMLIB: '' },
    stdin: stdin ?? 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${basename(tool)} ${args.join(' ')} failed (${result.exitCode}): ${result.stderr.toString('utf8')}`,
    );
  }
  if (stdout) writeFileSync(join(output, stdout), result.stdout);
}

try {
  // mksqlite3h.tcl executes this explicitly named helper from its working dir.
  // All pinned source files are declared inputs because mksourceid verifies the
  // Fossil manifest's individual source hashes when calculating SQLITE_SOURCE_ID.
  copyFileSync(
    tools.mksourceid,
    join(work, /\.exe$/iu.test(tools.mksourceid) ? 'mksourceid.exe' : 'mksourceid'),
  );
  run(tools.jim, [join(source, 'tool/mksqlite3h.tcl'), source, '-o', join(output, 'sqlite3.h')]);
  copyFileSync(join(source, 'src/parse.y'), join(work, 'parse.y'));
  run(tools.lemon, ['-S', `-T${join(source, 'tool/lempar.c')}`, 'parse.y']);
  for (const name of ['parse.c', 'parse.h']) copyFileSync(join(work, name), join(output, name));
  run(tools.mkkeywordhash, [], 'keywordhash.h');
  run(tools.jim, [join(source, 'tool/mkpragmatab.tcl')]);
  copyFileSync(join(work, 'pragma.h'), join(output, 'pragma.h'));
  run(tools.jim, [join(source, 'tool/mkctimec.tcl'), join(output, 'ctime.c')]);
  run(
    tools.jim,
    [join(source, 'tool/mkopcodeh.tcl')],
    'opcodes.h',
    Buffer.concat([
      readFileSync(join(output, 'parse.h')),
      readFileSync(join(source, 'src/vdbe.c')),
    ]),
  );
  run(tools.jim, [join(source, 'tool/mkopcodec.tcl'), join(output, 'opcodes.h')], 'opcodes.c');
  run(tools.jim, [join(source, 'tool/mkshellc.tcl'), join(output, 'shell.c')]);
} finally {
  rmSync(work, { recursive: true, force: true });
}
