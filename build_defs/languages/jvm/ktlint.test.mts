import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stageKotlinFormatSources } from './ktlint.mts';

const formats = [
  { name: 'kotlin' as const, editorConfig: { 'ktlint_standard_property-naming': 'disabled' } },
  { name: 'kotlinGradle' as const, editorConfig: {} },
];

test('stages only declared sources and preserves the Kotlin-only Spotless editorconfig override', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-ktlint-test-'));
  try {
    const file = path.join(root, 'input.kt');
    writeFileSync(file, 'val fixture = 1\n');
    expect(
      stageKotlinFormatSources(root, formats, [
        { format: 'kotlin', member: 'src/Fixture.kt', file },
        { format: 'kotlinGradle', member: 'build.gradle.kts', file },
      ]),
    ).toEqual(['src/Fixture.kt', 'build.gradle.kts']);
    expect(readFileSync(path.join(root, 'src/Fixture.kt'), 'utf8')).toBe('val fixture = 1\n');
    expect(readFileSync(path.join(root, '.editorconfig'), 'utf8')).toBe(
      'root = true\n\n[*.kt]\nktlint_standard_property-naming = disabled\n\n[*.kts]\n',
    );
    for (const member of ['../outside.kt', '/outside.kt', 'src\\Outside.kt', 'src/*.kt'])
      expect(() =>
        stageKotlinFormatSources(root, formats, [{ format: 'kotlin', member, file }]),
      ).toThrow('safe explicit source');
    expect(() => stageKotlinFormatSources(root, formats, [])).toThrow('declared authored sources');
    expect(() =>
      stageKotlinFormatSources(root, formats, [
        { format: 'kotlin', member: 'Fixture.kt', file },
        { format: 'kotlin', member: 'Fixture.kt', file },
      ]),
    ).toThrow('Duplicate');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
