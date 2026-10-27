import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { declaredAndroidLintArguments, stageAndroidLintSources } from './android-lint.mts';

test('complete SDK response exceeds argv capacity without expanding the launch arguments', () => {
  const root = path.join(os.tmpdir(), 'declared lint runfiles');
  const literal = JSON.stringify({ namespace: 'dev.oliphaunt', value: 'quoted " metadata' });
  const files = Array.from({ length: 12_000 }, (_, index) => ({
    file: `_main/sdk/platforms/android-36/data/res/${'declared-platform-member-'.repeat(7)}${index}.xml`,
  }));
  const response = JSON.stringify([{ literal }, ...files]);
  expect(response.length).toBeGreaterThan(2 * 1024 * 1024);
  const actual = declaredAndroidLintArguments(response, root);
  expect(actual).toHaveLength(files.length + 1);
  expect(actual[0]).toBe(literal);
  expect(actual.at(-1)).toBe(path.join(root, files.at(-1).file));
});

test('declared response paths and record kinds reject traversal and ambiguity', () => {
  const root = path.join(os.tmpdir(), 'declared-lint-runfiles');
  for (const file of [
    '../outside.jar',
    '/absolute.jar',
    'C:/absolute.jar',
    '_main/../outside',
    '_main/a\\b',
    '_main//empty',
  ]) {
    expect(() => declaredAndroidLintArguments(JSON.stringify([{ file }]), root)).toThrow(
      /safe declared/u,
    );
  }
  for (const record of [
    { file: '_main/a', literal: 'ambiguous' },
    {},
    { literal: 4 },
    { unknown: 'kind' },
  ]) {
    expect(() => declaredAndroidLintArguments(JSON.stringify([record]), root)).toThrow();
  }
  expect(() => declaredAndroidLintArguments('[]', 'relative')).toThrow(/absolute/u);
});

test('stages only declared authored, generated, Gradle and SDK inputs in isolated roots', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-lint-staging-'));
  try {
    const input = path.join(root, 'input');
    writeFileSync(input, 'declared');
    const stage = path.join(root, 'stage');
    mkdirSync(stage);
    const sources = [
      { kind: 'source' as const, member: 'src/Api.kt', file: input },
      { kind: 'generated' as const, member: 'bindings/Generated.kt', file: input },
      { kind: 'conventional' as const, member: 'oliphaunt/build.gradle.kts', file: input },
      { kind: 'sdk' as const, member: 'platforms/android-36/android.jar', file: input },
    ];
    const result = stageAndroidLintSources(stage, sources);
    expect(result.authored).toEqual([path.join(stage, 'project/oliphaunt/authored/src/Api.kt')]);
    expect(result.generated).toEqual([
      path.join(stage, 'project/oliphaunt/generated/bindings/Generated.kt'),
    ]);
    expect(readFileSync(path.join(stage, 'project/oliphaunt/build.gradle.kts'), 'utf8')).toBe(
      'declared',
    );
    expect(readFileSync(path.join(stage, 'sdk/platforms/android-36/android.jar'), 'utf8')).toBe(
      'declared',
    );
    expect(() => stageAndroidLintSources(stage, [...sources, sources[0]])).toThrow(/Duplicate/u);
    expect(() =>
      stageAndroidLintSources(stage, [{ ...sources[0], member: '../escape.kt' }]),
    ).toThrow(/safe explicit/u);
    expect(() => stageAndroidLintSources(stage, [sources[3]])).toThrow(/authored/u);
    expect(() => stageAndroidLintSources(stage, [sources[0]])).toThrow(/compiler SDK/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
