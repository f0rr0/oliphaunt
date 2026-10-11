import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { icuDataIdentity, icuDataObject } from './icu-data-object.mts';

const version = '#define U_ICU_VERSION_MAJOR_NUM 91\n#define U_ICU_VERSION_SHORT "91"\n';
const types = '#define U_ICUDATA_ENTRY_POINT U_DEF2_ICUDATA_ENTRY_POINT(U_ICU_VERSION_MAJOR_NUM,U_LIB_SUFFIX_C_NAME)\n' +
  '#define U_DEF_ICUDATA_ENTRY_POINT(major, suff) icudt##major##_dat\n';

function commonData(packageName: string) {
  const data = Buffer.alloc(128);
  data.writeUInt16LE(32, 0);
  data[2] = 0xda;
  data[3] = 0x27;
  data[10] = 2;
  data.write('CmnD', 12, 'ascii');
  data[16] = 1;
  data.writeUInt32LE(1, 32);
  data.writeUInt32LE(12, 36);
  data.writeUInt32LE(64, 40);
  data.write(`${packageName}/test.res\0`, 44, 'ascii');
  for (let index = 96; index < data.length; index++) data[index] = index;
  return data;
}

function checkObject(data: Buffer, versionHeader: string, typesHeader: string) {
  const object = icuDataObject(data, versionHeader, typesHeader, 'amd64');
  const { symbol } = icuDataIdentity(versionHeader, typesHeader);
  assert.equal(object.readUInt16LE(0), 0x8664);
  assert.equal(object.readUInt16LE(2), 2);
  assert.equal(object.readUInt32LE(4), 0, 'timestamp must be reproducible');
  assert.equal(object.readUInt32LE(12), 1);
  assert.equal(object.subarray(20, 28).toString('ascii'), '.drectve');
  assert.equal(object.subarray(60, 66).toString('ascii'), '.rdata');
  assert.equal(object.readUInt32LE(56), 0x00100a00);
  assert.equal(object.readUInt32LE(96), 0x40500040, 'read-only data needs 16-byte alignment');
  const directiveStart = object.readUInt32LE(40);
  const directiveEnd = directiveStart + object.readUInt32LE(36);
  assert.equal(object.subarray(directiveStart, directiveEnd).toString('ascii'), `-export:${symbol},data `);
  const rawStart = object.readUInt32LE(80);
  const rawEnd = rawStart + object.readUInt32LE(76);
  assert.deepEqual(object.subarray(rawStart, rawEnd), data, 'full data bytes must be unchanged');
  const symbolsStart = object.readUInt32LE(8);
  assert.equal(symbolsStart, rawEnd);
  assert.equal(object.readUInt32LE(symbolsStart), 0);
  assert.equal(object.readUInt32LE(symbolsStart + 4), 4);
  assert.equal(object.readUInt32LE(symbolsStart + 8), 0);
  assert.equal(object.readInt16LE(symbolsStart + 12), 2);
  assert.equal(object[symbolsStart + 16], 2);
  assert.equal(object[symbolsStart + 17], 0);
  assert.equal(object.subarray(symbolsStart + 22, -1).toString('ascii'), symbol);
  assert.equal(object.readUInt32LE(symbolsStart + 18), symbol.length + 5);
  assert.deepEqual(icuDataObject(data, versionHeader, typesHeader, 'amd64'), object);
}

const data = commonData('icudt91l');
assert.deepEqual(icuDataIdentity(version, types), { symbol: 'icudt91_dat', packageName: 'icudt91l' });
checkObject(data, version, types);
assert.throws(() => icuDataObject(data, version, types, 'arm64'), /Unsupported ICU COFF machine/u);
assert.throws(() => icuDataObject(data, version, types, 'i386'), /Unsupported ICU COFF machine/u);
assert.throws(() => icuDataObject(data.subarray(0, 12), version, types, 'amd64'), /Expected ICU/u);
assert.throws(() => icuDataObject(commonData('icudt90l'), version, types, 'amd64'), /does not match source/u);
assert.throws(() => icuDataObject(data, version.replace('"91"', '"90"'), types, 'amd64'), /macros/u);
assert.throws(() => icuDataObject(data, version, types.replace('icudt##major##_dat', 'other##major##_dat'), 'amd64'), /macros/u);
for (const mutate of [
  (bytes: Buffer) => { bytes[8] = 1; },
  (bytes: Buffer) => { bytes.writeUInt16LE(0xffff, 0); },
  (bytes: Buffer) => { bytes.writeUInt32LE(0, 32); },
  (bytes: Buffer) => { bytes.writeUInt32LE(0xffffffff, 32); },
  (bytes: Buffer) => { bytes.writeUInt32LE(0, 36); },
  (bytes: Buffer) => { bytes.writeUInt32LE(63, 40); },
  (bytes: Buffer) => { bytes.writeUInt32LE(128, 40); },
  (bytes: Buffer) => { bytes.fill(0xff, 44); },
]) {
  const invalid = Buffer.from(data);
  mutate(invalid);
  assert.throws(() => icuDataObject(invalid, version, types, 'amd64'), /ICU/u);
}

const [dataPath, versionPath, typesPath] = process.argv.slice(2);
if (dataPath || versionPath || typesPath) {
  assert(dataPath && versionPath && typesPath, 'expected canonical data and both actual source headers');
  checkObject(readFileSync(dataPath), readFileSync(versionPath, 'utf8'), readFileSync(typesPath, 'utf8'));
}
console.log('ICU COFF data layout, source identity, raw bytes and malformed inputs: PASS');
