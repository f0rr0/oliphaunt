import { expect, test } from 'bun:test';
import { readPortableArchiveEntries } from '../../../tools/packaging/portable-archive.mts';
import { parseProperties } from '../../contracts/native-manifest.mts';

test('portable ICU archive preserves selected data, receipt and notices', () => {
  const archive = process.env.OLIPHAUNT_ICU_TEST_ARCHIVE;
  if (!archive)
    throw new Error('Run bash database-resources/icu/tools/package-liboliphaunt-icu-data.test.sh');
  const entries = readPortableArchiveEntries(archive);
  expect(entries.get('share/icu/icudt76l/root.res')?.data().toString()).toBe('root\n');
  expect(entries.get('share/icu/icudt76l/coll/en.res')?.data().toString()).toBe('en\n');
  expect([...entries.keys()].some((name) => name.startsWith('share/icu/76.1'))).toBe(false);
  expect(entries.has('share/icu/LICENSE')).toBe(false);
  expect([...entries.keys()].some((name) => name.startsWith('cluster-seed'))).toBe(false);
  expect(entries.has('THIRD_PARTY_LICENSES/PostgreSQL-COPYRIGHT')).toBe(false);
  expect(entries.has('THIRD_PARTY_LICENSES/ICU-LICENSE')).toBe(true);
  expect(
    Object.fromEntries(
      parseProperties(entries.get('manifest.properties').data().toString(), 'ICU receipt'),
    ),
  ).toEqual({
    schema: 'oliphaunt-icu-data-v1',
    artifactRole: 'icu-data',
    icuDataVersion: '76.1',
    icuDataForm: 'files-le',
    icuDataTreeSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
  });
  expect(entries.get('package-size.tsv').data().toString()).toMatch(
    /^kind\tid\textensions\tfiles\tbytes\npackage\ttotal\t-\t-\t[0-9]+\npackage\ticu-data\t-\t-\t[0-9]+\n$/u,
  );
});
