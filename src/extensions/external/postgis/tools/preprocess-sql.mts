import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// ponytail: Windows has no GNU traditional-cpp. Pinned SQL uses object macros
// and integer comparisons only; reject new syntax until its pin has a fixture.
export function preprocessSql(input: string, includeDirs: string[] = []) {
  const macros = new Map<string, string>(),
    includes = new Set<string>(),
    result: string[] = [];
  const expand = (text: string) => {
    for (let depth = 0; depth < 16; depth++) {
      const expanded = text.replace(
        /\b[A-Za-z_][A-Za-z0-9_]*\b/g,
        (name) => macros.get(name) ?? name,
      );
      if (expanded === text) return text;
      text = expanded;
    }
    throw new Error('recursive SQL macro expansion');
  };
  const condition = (expression: string) => {
    const match = expand(expression)
      .replace(/\b[A-Za-z_][A-Za-z0-9_]*\b/g, '0')
      .trim()
      .match(/^(-?\d+)(?:\s*(==|!=|>=|<=|>|<)\s*(-?\d+))?$/);
    assert(match, `unsupported SQL condition: ${expression}`);
    const left = BigInt(match[1]),
      right = BigInt(match[3] ?? '0');
    switch (match[2]) {
      case '==':
        return left === right;
      case '!=':
        return left !== right;
      case '>=':
        return left >= right;
      case '<=':
        return left <= right;
      case '>':
        return left > right;
      case '<':
        return left < right;
      default:
        return left !== 0n;
    }
  };
  const processFile = (file: string) => {
    file = resolve(file);
    assert(!includes.has(file), `recursive SQL include: ${file}`);
    includes.add(file);
    const stack: { parent: boolean; taken: boolean }[] = [];
    let active = true,
      comment = false;
    for (const raw of readFileSync(file, 'utf8')
      .replaceAll('\r\n', '\n')
      .match(/[^\n]*\n|[^\n]+$/g) ?? []) {
      const directive = !comment && raw.match(/^\s*#\s*(\w+)\b(.*)/);
      if (!directive) {
        if (active) result.push(expand(raw));
        for (let offset = 0; offset < raw.length; ) {
          const found = raw.indexOf(comment ? '*/' : '/*', offset);
          if (found < 0) break;
          comment = !comment;
          offset = found + 2;
        }
        continue;
      }
      const [, command, value] = directive,
        argument = value.trim();
      if (['if', 'ifdef', 'ifndef'].includes(command)) {
        const accepted =
          active &&
          (command === 'if' ? condition(argument) : macros.has(argument) === (command === 'ifdef'));
        stack.push({ parent: active, taken: accepted });
        active = accepted;
      } else if (['else', 'elif', 'endif'].includes(command)) {
        const frame = stack.at(-1);
        assert(frame, `orphan #${command} in ${file}`);
        if (command === 'endif') {
          active = frame.parent;
          stack.pop();
        } else {
          active = frame.parent && !frame.taken && (command === 'else' || condition(argument));
          frame.taken ||= active;
        }
      } else if (active) {
        if (command === 'include') {
          const name = argument.match(/^"([^"]+)"$/)?.[1];
          assert(name, `unsupported SQL include: ${argument}`);
          const target = [dirname(file), ...includeDirs]
            .map((dir) => resolve(dir, name))
            .find(existsSync);
          assert(target, `could not resolve SQL include ${name} from ${file}`);
          processFile(target);
        } else if (command === 'define') {
          const match = argument.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\s+(.*))?$/);
          assert(match, `unsupported SQL macro: ${argument}`);
          macros.set(match[1], match[2] ?? '1');
        } else if (command === 'undef') macros.delete(argument);
        else result.push(raw);
      }
    }
    assert(!stack.length, `unterminated SQL conditional in ${file}`);
    includes.delete(file);
  };
  processFile(input);
  return result.join('');
}

if (import.meta.main) {
  const [input, output, ...includeDirs] = process.argv.slice(2);
  assert(input && output, 'usage: preprocess-sql.mts INPUT OUTPUT [INCLUDE_DIRECTORY...]');
  const sql = preprocessSql(input, includeDirs);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, sql);
}
