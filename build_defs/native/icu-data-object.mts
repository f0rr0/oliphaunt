import { readFileSync, writeFileSync } from 'node:fs';

export function icuDataIdentity(versionHeader: string, typesHeader: string) {
  const major = versionHeader.match(/^\s*#\s*define\s+U_ICU_VERSION_MAJOR_NUM\s+(\d+)\s*$/mu)?.[1];
  const short = versionHeader.match(/^\s*#\s*define\s+U_ICU_VERSION_SHORT\s+"(\d+)"\s*$/mu)?.[1];
  const entryMacro = typesHeader.match(/^\s*#\s*define\s+U_ICUDATA_ENTRY_POINT\s+(.+)$/mu)?.[1];
  const body = typesHeader.match(
    /^\s*#\s*define\s+U_DEF_ICUDATA_ENTRY_POINT\(major,\s*suff\)\s+(.+)$/mu,
  )?.[1];
  if (
    !major ||
    short !== major ||
    entryMacro?.replace(/\s+/gu, '') !==
      'U_DEF2_ICUDATA_ENTRY_POINT(U_ICU_VERSION_MAJOR_NUM,U_LIB_SUFFIX_C_NAME)' ||
    body?.replace(/\s+/gu, '') !== 'icudt##major##_dat'
  ) {
    throw new Error('Unsupported ICU source data entry-point/version macros');
  }
  // Expand the unsuffixed upstream token-paste definition. Neither the version
  // nor the concrete symbol is maintained separately from the source headers.
  const symbol = body.replace(/\bmajor\b/gu, major).replace(/\s|##/gu, '');
  return { symbol, packageName: `icudt${short}l` };
}

function checkCommonData(data: Buffer, packageName: string) {
  if (
    data.length < 28 ||
    data[2] !== 0xda ||
    data[3] !== 0x27 ||
    data[8] !== 0 ||
    data[9] !== 0 ||
    data[10] !== 2 ||
    data.toString('ascii', 12, 16) !== 'CmnD' ||
    data[16] !== 1
  ) {
    throw new Error('Expected ICU little-endian ASCII common data (CmnD v1)');
  }
  const headerSize = data.readUInt16LE(0);
  if (headerSize < 24 || headerSize + 4 > data.length)
    throw new Error('Truncated ICU common-data header');
  const count = data.readUInt32LE(headerSize);
  const tableEnd = 4 + count * 8;
  if (!count || headerSize + tableEnd > data.length)
    throw new Error('Empty or truncated ICU common-data table');
  for (let index = 0; index < count; index++) {
    const entry = headerSize + 4 + index * 8;
    const nameOffset = data.readUInt32LE(entry);
    const itemOffset = data.readUInt32LE(entry + 4);
    const nameEnd = data.indexOf(0, headerSize + nameOffset);
    if (
      nameOffset < tableEnd ||
      itemOffset <= nameOffset ||
      headerSize + itemOffset >= data.length ||
      itemOffset % 16 !== 0 ||
      nameEnd < 0 ||
      nameEnd >= headerSize + itemOffset
    ) {
      throw new Error('Invalid ICU common-data item offsets');
    }
    const name = data.toString('ascii', headerSize + nameOffset, nameEnd);
    if (!name.startsWith(`${packageName}/`))
      throw new Error(`ICU data package ${name} does not match source ${packageName}`);
  }
}

export function icuDataObject(
  data: Buffer,
  versionHeader: string,
  typesHeader: string,
  machine: string,
) {
  if (machine !== 'amd64') throw new Error(`Unsupported ICU COFF machine: ${machine}`);
  const { symbol, packageName } = icuDataIdentity(versionHeader, typesHeader);
  checkCommonData(data, packageName);

  // Same bounded COFF layout as ICU tools/toolutil/pkg_genc.cpp writeObjectCode:
  // linker directives, 16-aligned read-only data, one external DATA symbol, and
  // its long-name string table. A zero timestamp makes the output reproducible.
  const directive = Buffer.from(`-export:${symbol},data `, 'ascii');
  const names = Buffer.from(`${symbol}\0`, 'ascii');
  const headerSize = 20 + 2 * 40;
  const dataOffset = headerSize + directive.length;
  const symbolsOffset = dataOffset + data.length;
  if (symbolsOffset + 18 + 4 + names.length > 0xffffffff)
    throw new Error('ICU data exceeds the supported COFF object size');
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0x8664, 0); // IMAGE_FILE_MACHINE_AMD64
  header.writeUInt16LE(2, 2);
  header.writeUInt32LE(symbolsOffset, 8);
  header.writeUInt32LE(1, 12);
  header.write('.drectve', 20, 'ascii');
  header.writeUInt32LE(directive.length, 36);
  header.writeUInt32LE(headerSize, 40);
  header.writeUInt32LE(0x00100a00, 56); // INFO | REMOVE | ALIGN_1BYTES
  header.write('.rdata', 60, 'ascii');
  header.writeUInt32LE(data.length, 76);
  header.writeUInt32LE(dataOffset, 80);
  header.writeUInt32LE(0x40500040, 96); // INITIALIZED_DATA | ALIGN_16BYTES | READ
  const symbols = Buffer.alloc(18 + 4);
  symbols.writeUInt32LE(4, 4); // long symbol name at string-table offset 4
  symbols.writeInt16LE(2, 12); // section 2, offset 0
  symbols[16] = 2; // IMAGE_SYM_CLASS_EXTERNAL
  symbols.writeUInt32LE(4 + names.length, 18);
  return Buffer.concat([header, directive, data, symbols, names]);
}

if (import.meta.main) {
  const [dataPath, versionPath, typesPath, machine, output] = process.argv.slice(2);
  if (!dataPath || !versionPath || !typesPath || !machine || !output)
    throw new Error('Expected data, uvernum.h, utypes.h, machine, output.obj');
  writeFileSync(
    output,
    icuDataObject(
      readFileSync(dataPath),
      readFileSync(versionPath, 'utf8'),
      readFileSync(typesPath, 'utf8'),
      machine,
    ),
  );
}
