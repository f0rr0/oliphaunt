import assert from 'node:assert/strict';
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// A source inventory projection for the canonical wasm32/POSIX/PIC profile;
// this never executes Make recipes or source shell expressions.
export function libcSourceInventory(makefile: string, files: string[]) {
  assert.equal(new Set(files).size, files.length);
  for (const path of files)
    assert(
      !path.startsWith('/') &&
        !path.split('/').some((part) => !part || part === '.' || part === '..') &&
        !path.includes('\\'),
    );
  const variables: Record<string, string> = {
    TARGET_ARCH: 'wasm32',
    THREAD_MODEL: 'posix',
    PIC: 'yes',
  };
  function split(value: string): string[] {
    let level = 0;
    let start = 0;
    const result: string[] = [];
    for (let index = 0; index < value.length; index++) {
      if (value.startsWith('$(', index)) {
        level++;
        index++;
      } else if (value[index] === ')') {
        assert(level);
        level--;
      } else if (value[index] === ',' && level === 0) {
        result.push(value.slice(start, index));
        start = index + 1;
      }
    }
    assert.equal(level, 0);
    result.push(value.slice(start));
    return result;
  }
  const words = (value: string) => value.trim().split(/\s+/).filter(Boolean);
  function expression(value: string): string {
    let output = '';
    for (let index = 0; index < value.length; index++) {
      if (value[index] !== '$') {
        output += value[index];
        continue;
      }
      assert(value.startsWith('$(', index), 'Unsupported source expression');
      let level = 1;
      const start = index + 2;
      index = start;
      for (; index < value.length; index++) {
        if (value.startsWith('$(', index)) {
          level++;
          index++;
        } else if (value[index] === ')' && --level === 0) break;
      }
      assert.equal(level, 0);
      const body = value.slice(start, index);
      const firstSpace = body.indexOf(' ');
      if (firstSpace < 0) {
        assert(Object.hasOwn(variables, body), `Unknown source variable ${body}`);
        output += variables[body];
        continue;
      }
      const name = body.slice(0, firstSpace);
      const args = split(body.slice(firstSpace + 1)).map(expression);
      let result: string[];
      if (name === 'sort') {
        assert.equal(args.length, 1);
        result = [...new Set(words(args[0]))].sort();
      } else if (name === 'addprefix') {
        assert.equal(args.length, 2);
        result = words(args[1]).map((path) => args[0].trim() + path);
      } else if (name === 'wildcard') {
        assert.equal(args.length, 1);
        result = words(args[0])
          .flatMap((pattern) => files.filter((path) => new Bun.Glob(pattern).match(path)))
          .sort();
      } else if (name === 'filter-out') {
        assert.equal(args.length, 2);
        result = words(args[1]).filter(
          (path) =>
            !words(args[0]).some((pattern) => {
              const parts = pattern.split('%');
              assert(parts.length <= 2);
              return parts.length === 1
                ? pattern === path
                : path.startsWith(parts[0]) && path.endsWith(parts[1]);
            }),
        );
      } else if (name === 'shell') {
        assert.equal(args.length, 1);
        const match = /^find ([A-Za-z0-9_./-]+) -name (\\?\*\.(?:c|\[cs\]))$/.exec(args[0].trim());
        assert(match, 'Only declared source membership find expressions are supported');
        const pattern = `${match[1]}/**/${match[2].replaceAll('\\', '')}`;
        result = files.filter((path) => new Bun.Glob(pattern).match(path)).sort();
      } else throw new Error(`Unsupported source function ${name}`);
      output += result.join(' ');
    }
    return output;
  }
  function assignments(text: string) {
    const active: boolean[] = [true];
    for (const raw of text.replaceAll(/\\\r?\n/g, ' ').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const condition = /^(ifeq|ifneq)\s+\((.*)\)$/.exec(line);
      if (condition) {
        const args = split(condition[2]).map((value) => expression(value).trim());
        assert.equal(args.length, 2);
        active.push(Boolean(active.at(-1)) && (args[0] === args[1]) === (condition[1] === 'ifeq'));
      } else if (line === 'endif') {
        assert(active.length > 1);
        active.pop();
      } else {
        const row = /^([A-Z_]+)\s*(\+=|:=|=)\s*(.*)$/.exec(line);
        assert(row, `Unsupported source assignment ${line}`);
        if (active.at(-1))
          variables[row[1]] =
            `${row[2] === '+=' ? `${variables[row[1]] ?? ''} ` : ''}${expression(row[3])}`;
      }
    }
    assert.equal(active.length, 1);
  }
  const sourceStart = makefile.indexOf('DLMALLOC_DIR =');
  const sourceEnd = makefile.indexOf('# Add any extra flags');
  assert(sourceStart >= 0 && sourceEnd > sourceStart);
  assignments(makefile.slice(sourceStart, sourceEnd));
  const omitStart = makefile.indexOf('MUSL_OMIT_HEADERS :=');
  const omitEnd = makefile.indexOf('\ndefault:');
  assert(omitStart > sourceEnd && omitEnd > omitStart);
  assignments(makefile.slice(omitStart, omitEnd));
  const selected = {
    bottom: 'LIBC_BOTTOM_HALF_ALL_SOURCES',
    top: 'LIBC_TOP_HALF_ALL_SOURCES',
    malloc: 'DLMALLOC_SOURCES',
    mman: 'LIBWASI_EMULATED_MMAN_SOURCES',
    printscan: 'MUSL_PRINTSCAN_SOURCES',
    bulk: 'BULK_MEMORY_SOURCES',
    omit: 'MUSL_OMIT_HEADERS',
  };
  const lists = Object.fromEntries(
    Object.entries(selected).map(([name, key]) => [
      name,
      [...new Set(words(variables[key].replaceAll('"', '')))].sort(),
    ]),
  );
  for (const [name, paths] of Object.entries(lists))
    if (name !== 'omit')
      for (const path of paths)
        assert(files.includes(path), `Missing selected libc source ${path}`);
  return lists;
}

export function libcMembers(directory: string, prefix = ''): string[] {
  return readdirSync(join(directory, prefix))
    .sort()
    .flatMap((name) => {
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(join(directory, relative));
      assert(!stat.isSymbolicLink(), `Libc source member is a symlink: ${relative}`);
      return stat.isDirectory() ? libcMembers(directory, relative) : [relative];
    });
}

if (import.meta.main) {
  const [source, output] = process.argv.slice(2);
  assert(
    source && output && process.argv.length === 4,
    'Expected source directory and output .bzl',
  );
  const lists = libcSourceInventory(
    readFileSync(join(source, 'Makefile-eh'), 'utf8'),
    libcMembers(source),
  );
  writeFileSync(output, `LIBC_SOURCES = ${JSON.stringify(lists, null, 2)}\n`);
}
