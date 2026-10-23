import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Format = { name: 'kotlin' | 'kotlinGradle'; editorConfig: Record<string, string> };
type Source = { format: string; member: string; file: string };

export function stageKotlinFormatSources(root: string, formats: Format[], sources: Source[]) {
  assert(sources.length, 'Kotlin formatter must check declared authored sources');
  assert.equal(
    formats
      .map(({ name }) => name)
      .sort()
      .join(','),
    'kotlin,kotlinGradle',
    'Kotlin formatter requires its two conventional source scopes',
  );
  const config = ['root = true'];
  for (const format of formats) {
    config.push('', format.name === 'kotlin' ? '[*.kt]' : '[*.kts]');
    for (const [key, value] of Object.entries(format.editorConfig)) {
      assert(/^[A-Za-z0-9_.-]+$/u.test(key) && /^[A-Za-z0-9_.-]+$/u.test(value));
      config.push(`${key} = ${value}`);
    }
  }
  // A private root prevents ambient home/ancestor .editorconfig from changing the check.
  writeFileSync(path.join(root, '.editorconfig'), `${config.join('\n')}\n`);
  const seen = new Set<string>();
  for (const source of sources) {
    assert(
      formats.some(({ name }) => name === source.format),
      'Unknown Kotlin formatter scope',
    );
    assert(
      source.member &&
        !/^[A-Za-z]:/u.test(source.member) &&
        !/[\\\u0000-\u001f*?{}[\]!]/u.test(source.member) &&
        !path.posix.isAbsolute(source.member) &&
        source.member.split('/').every((part) => part && part !== '.' && part !== '..') &&
        source.member.endsWith(source.format === 'kotlin' ? '.kt' : '.gradle.kts'),
      'Kotlin formatter requires safe explicit source members',
    );
    assert(!seen.has(source.member), `Duplicate Kotlin formatter source ${source.member}`);
    seen.add(source.member);
    const destination = path.join(root, source.member);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source.file, destination);
  }
  return [...seen];
}

if (import.meta.main) {
  const [java, config, ...arguments_] = process.argv.slice(2);
  assert(java && config, 'Kotlin formatter requires declared Java and conventional configuration');
  const jars: string[] = [];
  const sources: Source[] = [];
  for (let index = 0; index < arguments_.length; ) {
    const kind = arguments_[index++];
    if (kind === 'jar') {
      const file = arguments_[index++];
      assert(file, 'Kotlin formatter requires declared CLI JARs');
      jars.push(file);
    } else {
      assert.equal(kind, 'source', 'Kotlin formatter accepts declared JARs and source files');
      const [format, member, file] = arguments_.slice(index, index + 3);
      assert(format && member && file, 'Incomplete Kotlin formatter source declaration');
      index += 3;
      sources.push({ format, member, file });
    }
  }
  assert(jars.length, 'Kotlin formatter requires its declared CLI classpath');
  const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-ktlint-'));
  try {
    const members = stageKotlinFormatSources(root, JSON.parse(config), sources);
    const result = spawnSync(
      java,
      [
        '-Xmx512m',
        '-XX:ActiveProcessorCount=2',
        `-Duser.home=${root}`,
        '-Dfile.encoding=UTF-8',
        '-cp',
        jars.join(path.delimiter),
        'com.pinterest.ktlint.Main',
        '--relative',
        ...members,
      ],
      { cwd: root, stdio: 'inherit' },
    );
    if (result.error) throw result.error;
    assert.equal(result.status, 0, 'Conventional Kotlin source formatting failed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
