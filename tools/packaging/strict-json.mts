// JSON.parse validates the grammar; this scan rejects keys it would overwrite.
export function parseStrictJson(
  source: string,
  reviver?: Parameters<typeof JSON.parse>[1],
): unknown {
  const value = JSON.parse(source, reviver);
  const objects: Set<string>[] = [];
  for (const match of source.matchAll(/"(?:[^"\\]|\\.)*"|[{}]/gsu)) {
    if (match[0] === '{') objects.push(new Set());
    else if (match[0] === '}') objects.pop();
    else {
      let next = match.index + match[0].length;
      while (next < source.length && ' \t\r\n'.includes(source[next])) next++;
      if (source[next] !== ':') continue;
      const key = JSON.parse(match[0]) as string;
      const keys = objects.at(-1)!;
      if (keys.has(key)) throw new Error(`duplicate JSON key ${JSON.stringify(key)}`);
      keys.add(key);
    }
  }
  return value;
}
