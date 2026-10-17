import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipArchive } from '../../../tools/packaging/testdata/zip-fixture.mts';
import {
  checkInstalledKotlinMaven,
  requirePublicConsumerClasses,
} from './installed-maven.test.mts';

test('the installed Android proof requires both compiled Kotlin and Java public API consumers', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-kotlin-consumer-'));
  try {
    const kotlin = path.join(root, 'kotlin.jar');
    const java = path.join(root, 'java.jar');
    writeFileSync(
      kotlin,
      zipArchive([{ name: 'dev/oliphaunt/consumer/PublicApiConsumerKt.class' }]),
    );
    writeFileSync(
      java,
      zipArchive([{ name: 'dev/oliphaunt/consumer/JavaPublicApiConsumer.class' }]),
    );
    expect(() => requirePublicConsumerClasses([kotlin, java])).not.toThrow();
    expect(() => requirePublicConsumerClasses([kotlin])).toThrow('JavaPublicApiConsumer.class');
    expect(() => requirePublicConsumerClasses([])).toThrow('declared JARs');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const member of [
  '../outside.pom',
  '/outside.pom',
  'group/../outside.pom',
  'group\\outside.pom',
])
  test(`the installed Maven proof rejects unsafe declared member ${member}`, async () => {
    await expect(
      checkInstalledKotlinMaven('0.0.1', ['maven', member, 'unread-file']),
    ).rejects.toThrow('safe repository relative file');
  });

test('the installed Maven proof rejects an incomplete final companion closure', async () => {
  await expect(checkInstalledKotlinMaven('0.0.1', [])).rejects.toThrow(
    'exact 10-file Maven Central companion closure',
  );
});
