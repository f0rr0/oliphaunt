import { readFileSync } from 'node:fs';

export interface SpawnExecution {
  mnemonic?: string;
  targetLabel?: string;
  cacheHit?: boolean;
  runner?: string;
  status?: string;
  exitCode?: number;
  commandArgs?: string[];
}

// Bazel writes successive protobuf JSON objects, not a JSON array or JSONL.
export function parseExecutionLog(text: string): SpawnExecution[] {
  const results: SpawnExecution[] = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (start === -1) {
      if (/\s/.test(character)) continue;
      if (character !== '{') throw new Error('execution log must contain JSON objects');
      start = index;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === '{' || character === '[') depth++;
    else if (character === '}' || character === ']') {
      depth--;
      if (depth === 0) {
        results.push(JSON.parse(text.slice(start, index + 1)));
        start = -1;
      }
    }
  }
  if (start !== -1) throw new Error('truncated execution log');
  return results;
}

export function executedFixtureSpawns(file: string, packageLabel: string): SpawnExecution[] {
  return parseExecutionLog(readFileSync(file, 'utf8')).filter(
    (spawn) => spawn.targetLabel?.startsWith(`${packageLabel}:`) && !spawn.cacheHit,
  );
}
