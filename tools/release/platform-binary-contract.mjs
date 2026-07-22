#!/usr/bin/env bun

import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import {
  APPLE_PLATFORM_COMPATIBILITY,
  platformCompatibilityContract,
} from "./platform-compatibility-policy.mjs";
import {
  WINDOWS_VC_RUNTIME_DLLS,
  inspectPortableExecutable,
} from "./windows-vc-runtime-closure.mjs";

const MACHO_LC_BUILD_VERSION = 0x32;
const ELF_TYPE_REL = 1;
const ELF_TYPE_EXEC = 2;
const ELF_TYPE_DYN = 3;
const ELF_SECTION_NOTE = 7;
const APPLE_PLATFORM_BY_ID = new Map(
  Object.values(APPLE_PLATFORM_COMPATIBILITY).map((platform) => [platform.id, platform]),
);
const APPLE_PLATFORM_BY_CLI_NAME = new Map(
  Object.values(APPLE_PLATFORM_COMPATIBILITY).map((platform) => [platform.cliName, platform]),
);
const WINDOWS_VC_RUNTIME_PROFILES =
  platformCompatibilityContract("windows-x64-msvc").windowsVcRuntime.profiles;

const EXPECTED_BINARY_PATH = /(?:\.dylib|\.dll|\.exe|\.node|\.so(?:\.[0-9]+)*)$/iu;
const STATIC_ARCHIVE_PATH = /\.a$/iu;
const MSVC_LIBRARY_PATH = /\.lib$/iu;
// Exact extension artifacts carry declared upstream grant text in this namespace.
// Only UTF-8 text at the canonical COPYING.LIB identity is metadata; detected
// formats and non-text bytes fail closed.
const WINDOWS_EXTENSION_LEGAL_TEXT_LIBRARY_PATH =
  /(?:^|\/)files\/share\/licenses\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/COPYING\.LIB$/iu;
const MSVC_RUNTIME_IMPORT = /^(?:CONCRT|MSVCP|VCRUNTIME)[0-9A-Z_]*\.DLL$/iu;
const WINDOWS_VC_RUNTIME_DLL_SET = new Set(WINDOWS_VC_RUNTIME_DLLS);
const WINDOWS_RUNTIME_IMPORT_LIBRARY_PATH = "lib/oliphaunt.lib";
const WINDOWS_RUNTIME_IMPORT_DLL = "oliphaunt.dll";
const WINDOWS_RUNTIME_IMPORT_SYMBOLS = Object.freeze(["oliphaunt_init", "oliphaunt_init_ex"]);
const COFF_ARCHIVE_HEADER_SIZE = 60;
const COFF_OBJECT_HEADER_SIZE = 20;
const COFF_SECTION_HEADER_SIZE = 40;
const COFF_SYMBOL_SIZE = 18;
const COFF_RELOCATION_SIZE = 10;
const COFF_LINE_NUMBER_SIZE = 6;
const COFF_IMPORT_OBJECT_SIGNATURE = 0xffff;
const COFF_IMPORT_OBJECT_NAME_EXPORT_AS = 4;

export class PlatformBinaryContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "PlatformBinaryContractError";
  }
}

function fail(label, message) {
  throw new PlatformBinaryContractError(`${label}: ${message}`);
}

function requireRange(buffer, offset, length, label, description) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > buffer.length ||
    length > buffer.length - offset
  ) {
    fail(label, `${description} is outside the ${buffer.length}-byte file`);
  }
}

function safeNumber(value, label, description) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail(label, `${description} exceeds the safe parser range`);
  }
  return Number(value);
}

function contractFor(target, label) {
  const contract = platformCompatibilityContract(target);
  if (contract === undefined) {
    fail(label, `unsupported platform-binary target ${JSON.stringify(target)}`);
  }
  return contract;
}

function compareVersion(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function formatVersion(version) {
  return version.length > 2 && version[2] !== 0
    ? `${version[0]}.${version[1]}.${version[2]}`
    : `${version[0]}.${version[1]}`;
}

function packedAppleVersion(value) {
  return [(value >>> 16) & 0xffff, (value >>> 8) & 0xff, value & 0xff];
}

function detectFormat(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from("!<arch>\n", "ascii"))) {
    return "ar";
  }
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    return "elf";
  }
  if (buffer.length >= 2 && buffer[0] === 0x4d && buffer[1] === 0x5a) {
    return "pe";
  }
  if (buffer.length >= 4) {
    const magic = buffer.readUInt32BE(0);
    if (
      magic === 0xfeedfacf ||
      magic === 0xcffaedfe ||
      magic === 0xcafebabe ||
      magic === 0xbebafeca ||
      magic === 0xcafebabf ||
      magic === 0xbfbafeca ||
      magic === 0xfeedface ||
      magic === 0xcefaedfe
    ) {
      return "macho";
    }
  }
  return null;
}

function isPlainText(buffer) {
  if (buffer.length === 0) return false;
  const text = buffer.toString("utf8");
  return (
    Buffer.from(text, "utf8").equals(buffer) &&
    !/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/u.test(text)
  );
}

function isWindowsExtensionLegalTextLibrary(name, buffer, format) {
  return (
    format === null &&
    WINDOWS_EXTENSION_LEGAL_TEXT_LIBRARY_PATH.test(name) &&
    isPlainText(buffer)
  );
}

function parseArchiveDecimal(buffer, offset, length, label, description) {
  requireRange(buffer, offset, length, label, description);
  const text = buffer.subarray(offset, offset + length).toString("ascii").trim();
  if (!/^[0-9]+$/u.test(text)) fail(label, `${description} is not an unsigned decimal integer`);
  const value = Number(text);
  if (!Number.isSafeInteger(value)) fail(label, `${description} exceeds the safe parser range`);
  return value;
}

function parseArArchiveMembers(buffer, label) {
  requireRange(buffer, 0, 8, label, "ar global header");
  if (!buffer.subarray(0, 8).equals(Buffer.from("!<arch>\n", "ascii"))) {
    fail(label, "ar global header is invalid");
  }
  let cursor = 8;
  let longNames = null;
  const members = [];
  while (cursor < buffer.length) {
    const headerOffset = cursor;
    requireRange(buffer, cursor, COFF_ARCHIVE_HEADER_SIZE, label, "ar member header");
    if (buffer.subarray(cursor + 58, cursor + 60).toString("ascii") !== "`\n") {
      fail(label, `ar member at offset ${cursor} has an invalid header trailer`);
    }
    const rawName = buffer.subarray(cursor, cursor + 16).toString("ascii").trim();
    const size = parseArchiveDecimal(buffer, cursor + 48, 10, label, "ar member size");
    const dataOffset = cursor + COFF_ARCHIVE_HEADER_SIZE;
    requireRange(buffer, dataOffset, size, label, `ar member ${rawName || "<unnamed>"}`);
    let name = rawName.replace(/\/$/u, "");
    let payloadOffset = dataOffset;
    let payloadSize = size;
    if (rawName.startsWith("#1/")) {
      const nameLengthText = rawName.slice(3).trim();
      if (!/^[0-9]+$/u.test(nameLengthText)) fail(label, `ar BSD member name length is invalid: ${rawName}`);
      const nameLength = Number(nameLengthText);
      if (!Number.isSafeInteger(nameLength) || nameLength <= 0 || nameLength > size) {
        fail(label, `ar BSD member name length ${nameLengthText} exceeds its member`);
      }
      name = buffer.subarray(dataOffset, dataOffset + nameLength).toString("utf8").replace(/\x00+$/u, "");
      payloadOffset += nameLength;
      payloadSize -= nameLength;
    } else if (rawName === "//") {
      longNames = buffer.subarray(dataOffset, dataOffset + size);
    } else if (/^\/[0-9]+$/u.test(rawName)) {
      if (longNames === null) fail(label, `ar member ${rawName} refers to a missing long-name table`);
      const nameOffset = Number(rawName.slice(1));
      if (!Number.isSafeInteger(nameOffset) || nameOffset < 0 || nameOffset >= longNames.length) {
        fail(label, `ar member long-name offset ${nameOffset} is out of range`);
      }
      const gnuNameEnd = longNames.indexOf(Buffer.from("/\n", "ascii"), nameOffset);
      const coffNameEnd = longNames.indexOf(0, nameOffset);
      const nameEnd = [gnuNameEnd, coffNameEnd]
        .filter((offset) => offset >= nameOffset)
        .sort((left, right) => left - right)[0];
      if (nameEnd === undefined) fail(label, `ar member long name at offset ${nameOffset} is unterminated`);
      name = longNames.subarray(nameOffset, nameEnd).toString("utf8");
    }

    const special =
      rawName === "/" ||
      rawName === "//" ||
      rawName === "/SYM64/" ||
      name.startsWith("__.SYMDEF") ||
      name === "SYM64";
    members.push({
      headerOffset,
      name,
      payload: buffer.subarray(payloadOffset, payloadOffset + payloadSize),
      rawName,
      special,
    });
    cursor = dataOffset + size + (size % 2);
  }
  if (cursor !== buffer.length) fail(label, "ar archive has a truncated alignment byte");
  return members;
}

function parseArArchive(buffer, label, contract) {
  const slices = [];
  for (const { name, payload, special } of parseArArchiveMembers(buffer, label)) {
    if (!special) {
      if (payload.length === 0) fail(label, `ar object member ${JSON.stringify(name)} is empty`);
      const format = detectFormat(payload);
      if (format === "macho" && contract.format === "macho") {
        slices.push(...parseMacho(payload, `${label}(${name})`, contract));
      } else if (format === "elf" && contract.format === "elf") {
        slices.push(parseElf(payload, `${label}(${name})`, contract));
      } else {
        fail(
          label,
          `ar member ${JSON.stringify(name)} is not a ${contract.format.toUpperCase()} object for this carrier`,
        );
      }
    }
  }
  if (slices.length === 0) fail(label, "ar archive contains no inspectable native object members");
  return slices;
}

function parseNullTerminatedStrings(buffer, offset, count, label, description) {
  const values = [];
  let cursor = offset;
  for (let index = 0; index < count; index += 1) {
    if (cursor >= buffer.length) {
      fail(label, `${description} is missing string ${index + 1} of ${count}`);
    }
    const end = buffer.indexOf(0, cursor);
    if (end < 0) fail(label, `${description} string ${index + 1} is unterminated`);
    if (end === cursor) fail(label, `${description} string ${index + 1} is empty`);
    values.push(buffer.subarray(cursor, end).toString("latin1"));
    cursor = end + 1;
  }
  if (cursor !== buffer.length) {
    fail(label, `${description} has ${buffer.length - cursor} trailing byte(s)`);
  }
  return values;
}

function parseWindowsFirstLinkerMember(member, objectOffsets, label) {
  const memberLabel = `${label} [first linker member]`;
  requireRange(member.payload, 0, 4, memberLabel, "symbol count");
  const count = member.payload.readUInt32BE(0);
  if (count === 0 || count > 1_000_000) {
    fail(memberLabel, `symbol count ${count} is invalid`);
  }
  requireRange(member.payload, 4, count * 4, memberLabel, "member-offset table");
  const offsets = [];
  for (let index = 0; index < count; index += 1) {
    const offset = member.payload.readUInt32BE(4 + index * 4);
    if (!objectOffsets.has(offset)) {
      fail(memberLabel, `symbol ${index} refers to non-object archive offset ${offset}`);
    }
    offsets.push(offset);
  }
  const names = parseNullTerminatedStrings(
    member.payload,
    4 + count * 4,
    count,
    memberLabel,
    "symbol-name table",
  );
  return { names, offsets };
}

function parseWindowsSecondLinkerMember(member, objectMembers, label) {
  const memberLabel = `${label} [second linker member]`;
  requireRange(member.payload, 0, 4, memberLabel, "archive-member count");
  const memberCount = member.payload.readUInt32LE(0);
  if (memberCount === 0 || memberCount > 1_000_000) {
    fail(memberLabel, `archive-member count ${memberCount} is invalid`);
  }
  requireRange(member.payload, 4, memberCount * 4 + 4, memberLabel, "member-offset and symbol-count tables");
  const offsets = [];
  const seenOffsets = new Set();
  for (let index = 0; index < memberCount; index += 1) {
    const offset = member.payload.readUInt32LE(4 + index * 4);
    if (seenOffsets.has(offset)) fail(memberLabel, `archive-member offset ${offset} is repeated`);
    seenOffsets.add(offset);
    offsets.push(offset);
  }
  const expectedOffsets = new Set(objectMembers.map(({ headerOffset }) => headerOffset));
  if (
    offsets.length !== expectedOffsets.size ||
    offsets.some((offset) => !expectedOffsets.has(offset))
  ) {
    fail(memberLabel, "archive-member offsets do not exactly cover the COFF object members");
  }
  const symbolCountOffset = 4 + memberCount * 4;
  const symbolCount = member.payload.readUInt32LE(symbolCountOffset);
  if (symbolCount === 0 || symbolCount > 1_000_000) {
    fail(memberLabel, `symbol count ${symbolCount} is invalid`);
  }
  const indicesOffset = symbolCountOffset + 4;
  requireRange(member.payload, indicesOffset, symbolCount * 2, memberLabel, "symbol-index table");
  for (let index = 0; index < symbolCount; index += 1) {
    const memberIndex = member.payload.readUInt16LE(indicesOffset + index * 2);
    if (memberIndex === 0 || memberIndex > memberCount) {
      fail(memberLabel, `symbol ${index} has out-of-range archive-member index ${memberIndex}`);
    }
  }
  const names = parseNullTerminatedStrings(
    member.payload,
    indicesOffset + symbolCount * 2,
    symbolCount,
    memberLabel,
    "symbol-name table",
  );
  for (let index = 1; index < names.length; index += 1) {
    if (Buffer.compare(Buffer.from(names[index - 1], "latin1"), Buffer.from(names[index], "latin1")) >= 0) {
      fail(memberLabel, "symbol names must be unique and in ascending lexical order");
    }
  }
  return names;
}

function requireCoffPointer(buffer, pointer, size, headerEnd, label, description) {
  if (size === 0) return;
  if (pointer < headerEnd) fail(label, `${description} overlaps the COFF headers`);
  requireRange(buffer, pointer, size, label, description);
}

function parseCoffObjectMember(buffer, label, contract) {
  requireRange(buffer, 0, COFF_OBJECT_HEADER_SIZE, label, "COFF object header");
  const machine = buffer.readUInt16LE(0);
  if (machine !== contract.pe.machine) {
    fail(label, `COFF object machine 0x${machine.toString(16)} is not ${contract.architecture}`);
  }
  const sectionCount = buffer.readUInt16LE(2);
  if (sectionCount === 0 || sectionCount > 96) {
    fail(label, `COFF object section count ${sectionCount} is invalid`);
  }
  const symbolTable = buffer.readUInt32LE(8);
  const symbolCount = buffer.readUInt32LE(12);
  const optionalHeaderSize = buffer.readUInt16LE(16);
  if (optionalHeaderSize !== 0) {
    fail(label, `COFF archive object has unexpected ${optionalHeaderSize}-byte optional header`);
  }
  const sectionTable = COFF_OBJECT_HEADER_SIZE;
  const headerEnd = sectionTable + sectionCount * COFF_SECTION_HEADER_SIZE;
  requireRange(buffer, sectionTable, sectionCount * COFF_SECTION_HEADER_SIZE, label, "COFF section table");
  for (let index = 0; index < sectionCount; index += 1) {
    const section = sectionTable + index * COFF_SECTION_HEADER_SIZE;
    const rawSize = buffer.readUInt32LE(section + 16);
    const rawPointer = buffer.readUInt32LE(section + 20);
    const relocationPointer = buffer.readUInt32LE(section + 24);
    const lineNumberPointer = buffer.readUInt32LE(section + 28);
    const relocationCount = buffer.readUInt16LE(section + 32);
    const lineNumberCount = buffer.readUInt16LE(section + 34);
    requireCoffPointer(buffer, rawPointer, rawSize, headerEnd, label, `COFF section ${index} raw data`);
    requireCoffPointer(
      buffer,
      relocationPointer,
      relocationCount * COFF_RELOCATION_SIZE,
      headerEnd,
      label,
      `COFF section ${index} relocations`,
    );
    requireCoffPointer(
      buffer,
      lineNumberPointer,
      lineNumberCount * COFF_LINE_NUMBER_SIZE,
      headerEnd,
      label,
      `COFF section ${index} line numbers`,
    );
  }
  if (symbolCount === 0) {
    if (symbolTable !== 0) fail(label, "COFF object has a symbol-table pointer but zero symbols");
  } else {
    requireCoffPointer(
      buffer,
      symbolTable,
      symbolCount * COFF_SYMBOL_SIZE,
      headerEnd,
      label,
      "COFF symbol table",
    );
    let symbolIndex = 0;
    while (symbolIndex < symbolCount) {
      const symbol = symbolTable + symbolIndex * COFF_SYMBOL_SIZE;
      const auxiliaryCount = buffer[symbol + 17];
      if (auxiliaryCount > symbolCount - symbolIndex - 1) {
        fail(label, `COFF symbol ${symbolIndex} has ${auxiliaryCount} out-of-range auxiliary record(s)`);
      }
      symbolIndex += auxiliaryCount + 1;
    }
    const stringTable = symbolTable + symbolCount * COFF_SYMBOL_SIZE;
    requireRange(buffer, stringTable, 4, label, "COFF string-table size");
    const stringTableSize = buffer.readUInt32LE(stringTable);
    if (stringTableSize < 4) fail(label, `COFF string-table size ${stringTableSize} is invalid`);
    requireRange(buffer, stringTable, stringTableSize, label, "COFF string table");
    if (stringTable + stringTableSize !== buffer.length) {
      fail(label, "COFF string table does not end at the object-member boundary");
    }
  }
  return { kind: "coff-object", machine: contract.architecture };
}

function parseCoffImportObjectMember(buffer, label, contract) {
  requireRange(buffer, 0, COFF_OBJECT_HEADER_SIZE, label, "COFF import-object header");
  if (buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== COFF_IMPORT_OBJECT_SIGNATURE) {
    fail(label, "COFF import-object signature is invalid");
  }
  const version = buffer.readUInt16LE(4);
  if (version !== 0) {
    fail(label, `unsupported anonymous COFF object version ${version}; expected a short import object`);
  }
  const machine = buffer.readUInt16LE(6);
  if (machine !== contract.pe.machine) {
    fail(label, `COFF import-object machine 0x${machine.toString(16)} is not ${contract.architecture}`);
  }
  const sizeOfData = buffer.readUInt32LE(12);
  if (sizeOfData !== buffer.length - COFF_OBJECT_HEADER_SIZE) {
    fail(
      label,
      `COFF import-object data size ${sizeOfData} does not match its ${buffer.length - COFF_OBJECT_HEADER_SIZE}-byte payload`,
    );
  }
  const typeInfo = buffer.readUInt16LE(18);
  const importType = typeInfo & 0x3;
  const nameType = (typeInfo >>> 2) & 0x7;
  if (importType > 2) fail(label, `COFF import-object type ${importType} is invalid`);
  if (nameType > COFF_IMPORT_OBJECT_NAME_EXPORT_AS) {
    fail(label, `COFF import-object name type ${nameType} is invalid`);
  }
  if ((typeInfo & 0xffe0) !== 0) fail(label, "COFF import-object reserved type bits are nonzero");
  const strings = parseNullTerminatedStrings(
    buffer,
    COFF_OBJECT_HEADER_SIZE,
    nameType === COFF_IMPORT_OBJECT_NAME_EXPORT_AS ? 3 : 2,
    label,
    "COFF import-object data",
  );
  return {
    dll: strings[1],
    kind: "coff-import-object",
    machine: contract.architecture,
    symbol: strings[0],
  };
}

function parseWindowsRuntimeImportLibrary(buffer, label, contract) {
  const members = parseArArchiveMembers(buffer, label);
  if (members.length < 3 || members[0].rawName !== "/" || members[1].rawName !== "/") {
    fail(label, "MSVC import library must begin with its first and second linker members");
  }
  const objectMembers = members.filter(({ special }) => !special);
  if (objectMembers.length === 0) fail(label, "MSVC import library contains no COFF object members");
  const unexpectedSpecial = members
    .slice(2)
    .find(({ rawName, special }) => special && rawName !== "//" && rawName !== "/");
  if (unexpectedSpecial !== undefined) {
    fail(label, `MSVC import library contains unsupported special member ${JSON.stringify(unexpectedSpecial.rawName)}`);
  }
  if (members.slice(2).some(({ rawName }) => rawName === "/")) {
    fail(label, "MSVC import library contains an unexpected additional linker member");
  }
  if (members.filter(({ rawName }) => rawName === "//").length > 1) {
    fail(label, "MSVC import library repeats its long-name member");
  }
  const objectOffsets = new Set(objectMembers.map(({ headerOffset }) => headerOffset));
  parseWindowsFirstLinkerMember(members[0], objectOffsets, label);
  const linkerSymbols = parseWindowsSecondLinkerMember(members[1], objectMembers, label);

  const slices = [];
  const imports = [];
  for (const member of objectMembers) {
    if (member.payload.length === 0) {
      fail(label, `MSVC import-library member ${JSON.stringify(member.name)} is empty`);
    }
    const memberLabel = `${label}(${member.name})`;
    const shortImport =
      member.payload.length >= 4 &&
      member.payload.readUInt16LE(0) === 0 &&
      member.payload.readUInt16LE(2) === COFF_IMPORT_OBJECT_SIGNATURE;
    const parsed = shortImport
      ? parseCoffImportObjectMember(member.payload, memberLabel, contract)
      : parseCoffObjectMember(member.payload, memberLabel, contract);
    slices.push(parsed);
    if (parsed.kind === "coff-import-object") imports.push(parsed);
  }
  if (imports.length === 0) fail(label, "MSVC import library contains no short import-object members");
  const wrongDll = imports.find(({ dll }) => dll.toLowerCase() !== WINDOWS_RUNTIME_IMPORT_DLL);
  if (wrongDll !== undefined) {
    fail(
      label,
      `MSVC import object for ${JSON.stringify(wrongDll.symbol)} names unexpected DLL ${JSON.stringify(wrongDll.dll)}`,
    );
  }
  const importSymbols = new Set(imports.map(({ symbol }) => symbol));
  for (const requiredSymbol of WINDOWS_RUNTIME_IMPORT_SYMBOLS) {
    if (!importSymbols.has(requiredSymbol)) {
      fail(label, `MSVC import library does not expose required symbol ${requiredSymbol}`);
    }
    if (!linkerSymbols.includes(requiredSymbol)) {
      fail(label, `MSVC second linker member does not index required symbol ${requiredSymbol}`);
    }
  }
  return {
    archived: true,
    format: "pe",
    platforms: [],
    slices,
  };
}

function machoEndianAndWidth(buffer, offset, label) {
  requireRange(buffer, offset, 4, label, "Mach-O magic");
  const magic = buffer.readUInt32BE(offset);
  if (magic === 0xfeedfacf) return { endian: "be", bits: 64 };
  if (magic === 0xcffaedfe) return { endian: "le", bits: 64 };
  if (magic === 0xfeedface || magic === 0xcefaedfe) {
    fail(label, "Mach-O image is 32-bit; release binaries must be 64-bit arm64");
  }
  fail(label, "Mach-O slice has an invalid thin-image magic");
}

function readMachoUInt32(buffer, offset, endian) {
  return endian === "le" ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
}

function parseMachoSlice(buffer, sliceOffset, sliceSize, label, contract) {
  requireRange(buffer, sliceOffset, sliceSize, label, "Mach-O slice");
  if (sliceSize < 32) fail(label, "Mach-O 64-bit header is truncated");
  const { endian } = machoEndianAndWidth(buffer, sliceOffset, label);
  const read32 = (relative) => {
    requireRange(buffer, sliceOffset + relative, 4, label, "Mach-O header field");
    return readMachoUInt32(buffer, sliceOffset + relative, endian);
  };
  const cpuType = read32(4);
  if (cpuType !== contract.macho.cpuType) {
    fail(label, `Mach-O cpu type 0x${cpuType.toString(16)} is not arm64`);
  }
  const cpuSubtype = read32(8);
  if (cpuSubtype !== contract.macho.cpuSubtype) {
    fail(
      label,
      `Mach-O arm64 cpu subtype 0x${cpuSubtype.toString(16)} is not generic ARM64_ALL (arm64e-only slices are not portable arm64 carriers)`,
    );
  }
  const commandCount = read32(16);
  const commandsSize = read32(20);
  if (commandCount > 65_536) fail(label, `Mach-O declares unreasonable load-command count ${commandCount}`);
  requireRange(buffer, sliceOffset + 32, commandsSize, label, "Mach-O load-command table");
  if (commandsSize > sliceSize - 32) fail(label, "Mach-O load-command table exceeds its fat slice");

  let cursor = sliceOffset + 32;
  const commandsEnd = cursor + commandsSize;
  const buildVersions = [];
  for (let index = 0; index < commandCount; index += 1) {
    requireRange(buffer, cursor, 8, label, `Mach-O load command ${index}`);
    if (cursor + 8 > commandsEnd) fail(label, `Mach-O load command ${index} exceeds sizeofcmds`);
    const command = readMachoUInt32(buffer, cursor, endian);
    const commandSize = readMachoUInt32(buffer, cursor + 4, endian);
    if (commandSize < 8 || commandSize % 4 !== 0) {
      fail(label, `Mach-O load command ${index} has invalid cmdsize ${commandSize}`);
    }
    if (commandSize > commandsEnd - cursor) {
      fail(label, `Mach-O load command ${index} exceeds sizeofcmds`);
    }
    if (command === MACHO_LC_BUILD_VERSION) {
      if (commandSize < 24) fail(label, "Mach-O LC_BUILD_VERSION is truncated");
      buildVersions.push({
        platform: readMachoUInt32(buffer, cursor + 8, endian),
        minos: packedAppleVersion(readMachoUInt32(buffer, cursor + 12, endian)),
      });
    }
    cursor += commandSize;
  }
  if (cursor !== commandsEnd) {
    fail(label, `Mach-O load commands consume ${cursor - (sliceOffset + 32)} bytes, expected ${commandsSize}`);
  }
  if (buildVersions.length !== 1) {
    fail(label, `Mach-O slice must contain exactly one LC_BUILD_VERSION, found ${buildVersions.length}`);
  }
  const [{ platform, minos }] = buildVersions;
  const platformMetadata = APPLE_PLATFORM_BY_ID.get(platform);
  if (platformMetadata === undefined) {
    fail(label, `Mach-O LC_BUILD_VERSION platform ${platform} is not macOS, iOS, or iOS Simulator`);
  }
  const platformContract = Object.values(contract.apple.platforms).find(
    (candidate) => candidate.id === platform,
  );
  if (platformContract === undefined) {
    fail(
      label,
      `${contract.apple.carrier} contains unsupported ${platformMetadata.name} Mach-O content`,
    );
  }
  const maximum = platformContract.maximumMinimumOs;
  if (compareVersion(minos, maximum) > 0) {
    fail(
      label,
      `${platformMetadata.name} minimum OS ${formatVersion(minos)} exceeds the carrier contract ${formatVersion(maximum)}`,
    );
  }
  return {
    platform,
    platformName: platformMetadata.name,
    minos,
    machine: "arm64",
    cpuType,
    cpuSubtype,
  };
}

function parseMacho(buffer, label, contract) {
  requireRange(buffer, 0, 4, label, "Mach-O magic");
  const magic = buffer.readUInt32BE(0);
  if (![0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic)) {
    return [parseMachoSlice(buffer, 0, buffer.length, label, contract)];
  }
  const littleEndian = magic === 0xbebafeca || magic === 0xbfbafeca;
  const fat64 = magic === 0xcafebabf || magic === 0xbfbafeca;
  const read32 = (offset) => (littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset));
  const read64 = (offset) =>
    safeNumber(littleEndian ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset), label, "fat Mach-O offset or size");
  requireRange(buffer, 0, 8, label, "fat Mach-O header");
  const count = read32(4);
  if (count === 0 || count > 64) fail(label, `fat Mach-O declares invalid slice count ${count}`);
  const entrySize = fat64 ? 32 : 20;
  requireRange(buffer, 8, count * entrySize, label, "fat Mach-O architecture table");
  const tableEnd = 8 + count * entrySize;
  const ranges = [];
  const identities = new Set();
  const results = [];
  for (let index = 0; index < count; index += 1) {
    const entry = 8 + index * entrySize;
    const cpuType = read32(entry);
    if (cpuType !== contract.macho.cpuType) {
      fail(label, `fat Mach-O slice ${index} cpu type 0x${cpuType.toString(16)} is not arm64`);
    }
    const cpuSubtype = read32(entry + 4);
    if (cpuSubtype !== contract.macho.cpuSubtype) {
      fail(
        label,
        `fat Mach-O slice ${index} arm64 cpu subtype 0x${cpuSubtype.toString(16)} is not generic ARM64_ALL`,
      );
    }
    const identity = `${cpuType}:${cpuSubtype}`;
    if (identities.has(identity)) {
      fail(label, `fat Mach-O slice ${index} duplicates architecture identity arm64/ARM64_ALL`);
    }
    identities.add(identity);
    const offset = fat64 ? read64(entry + 8) : read32(entry + 8);
    const size = fat64 ? read64(entry + 16) : read32(entry + 12);
    const alignment = fat64 ? read32(entry + 24) : read32(entry + 16);
    if (size === 0) fail(label, `fat Mach-O slice ${index} is empty`);
    if (alignment > 31) fail(label, `fat Mach-O slice ${index} has unsafe alignment exponent ${alignment}`);
    if (offset < tableEnd) fail(label, `fat Mach-O slice ${index} overlaps its architecture table`);
    if (offset % 2 ** alignment !== 0) fail(label, `fat Mach-O slice ${index} offset is not aligned`);
    requireRange(buffer, offset, size, label, `fat Mach-O slice ${index}`);
    for (const range of ranges) {
      if (offset < range.end && range.start < offset + size) {
        fail(label, `fat Mach-O slice ${index} overlaps another slice`);
      }
    }
    ranges.push({ start: offset, end: offset + size });
    const slice = parseMachoSlice(buffer, offset, size, `${label} [slice ${index}]`, contract);
    if (slice.cpuType !== cpuType || slice.cpuSubtype !== cpuSubtype) {
      fail(label, `fat Mach-O slice ${index} architecture table identity does not match its thin header`);
    }
    results.push(slice);
  }
  return results;
}

function scanRequiredElfVersions(buffer) {
  const text = buffer.toString("latin1");
  const versions = [];
  const pattern = /(?:^|(?<=\x00))(GLIBC(?:XX)?_([0-9]+)\.([0-9]+)(?:\.([0-9]+))?)(?=\x00)/gu;
  for (const match of text.matchAll(pattern)) {
    versions.push({
      name: match[1],
      family: match[1].startsWith("GLIBCXX_") ? "GLIBCXX" : "GLIBC",
      version: [Number(match[2]), Number(match[3]), Number(match[4] ?? 0)],
    });
  }
  return versions;
}

function validateElfTable(buffer, offset, entrySize, count, minimumSize, label, name) {
  if (count === 0) return;
  if (offset === 0) fail(label, `ELF ${name} count is nonzero but its offset is zero`);
  if (entrySize < minimumSize) fail(label, `ELF ${name} entry size ${entrySize} is below ${minimumSize}`);
  if (count > 65_536) fail(label, `ELF ${name} count ${count} is unreasonable`);
  requireRange(buffer, offset, entrySize * count, label, `ELF ${name}`);
}

function alignFour(value) {
  return (value + 3) & ~3;
}

function androidApiNotes(buffer, sectionOffset, sectionEntrySize, sectionCount, label) {
  const values = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const section = sectionOffset + index * sectionEntrySize;
    if (buffer.readUInt32LE(section + 4) !== ELF_SECTION_NOTE) continue;
    const noteOffset = safeNumber(buffer.readBigUInt64LE(section + 24), label, `ELF note section ${index} offset`);
    const noteSize = safeNumber(buffer.readBigUInt64LE(section + 32), label, `ELF note section ${index} size`);
    requireRange(buffer, noteOffset, noteSize, label, `ELF note section ${index}`);
    let cursor = noteOffset;
    const end = noteOffset + noteSize;
    while (cursor < end) {
      if (end - cursor < 12) {
        if (buffer.subarray(cursor, end).every((byte) => byte === 0)) break;
        fail(label, `ELF note section ${index} has a truncated note header`);
      }
      const nameSize = buffer.readUInt32LE(cursor);
      const descriptionSize = buffer.readUInt32LE(cursor + 4);
      const type = buffer.readUInt32LE(cursor + 8);
      if (nameSize === 0 || nameSize > 256 || descriptionSize > 1024 * 1024) {
        fail(label, `ELF note section ${index} has unreasonable note sizes`);
      }
      const nameOffset = cursor + 12;
      const descriptionOffset = nameOffset + alignFour(nameSize);
      const next = descriptionOffset + alignFour(descriptionSize);
      if (next > end) fail(label, `ELF note section ${index} contains a truncated note payload`);
      const owner = buffer.subarray(nameOffset, nameOffset + nameSize).toString("ascii").replace(/\x00+$/u, "");
      if (owner === "Android" && type === 1) {
        if (descriptionSize < 4) fail(label, ".note.android.ident NT_VERSION description is truncated");
        values.push(buffer.readUInt32LE(descriptionOffset));
      }
      cursor = next;
    }
  }
  return values;
}

function parseElf(buffer, label, contract) {
  requireRange(buffer, 0, 64, label, "ELF64 header");
  if (contract.elf.bits !== 64 || buffer[4] !== 2) {
    fail(label, `ELF class ${buffer[4]} is not ELF${contract.elf.bits}`);
  }
  if (contract.elf.endianness !== "little" || buffer[5] !== 1) {
    fail(label, `ELF data encoding ${buffer[5]} is not ${contract.elf.endianness}-endian`);
  }
  if (buffer[6] !== 1) fail(label, `ELF identification version ${buffer[6]} is invalid`);
  const elfType = buffer.readUInt16LE(16);
  if (![ELF_TYPE_REL, ELF_TYPE_EXEC, ELF_TYPE_DYN].includes(elfType)) {
    fail(label, `ELF type ${elfType} is not a relocatable object, executable, or shared library`);
  }
  const machine = buffer.readUInt16LE(18);
  if (machine !== contract.elf.machine) {
    fail(label, `ELF machine ${machine} does not match ${contract.architecture}`);
  }
  const headerSize = buffer.readUInt16LE(52);
  if (headerSize < 64 || headerSize > buffer.length) fail(label, `ELF header size ${headerSize} is invalid`);
  const programOffset = safeNumber(buffer.readBigUInt64LE(32), label, "ELF program-header offset");
  const sectionOffset = safeNumber(buffer.readBigUInt64LE(40), label, "ELF section-header offset");
  const programEntrySize = buffer.readUInt16LE(54);
  const programCount = buffer.readUInt16LE(56);
  const sectionEntrySize = buffer.readUInt16LE(58);
  const sectionCount = buffer.readUInt16LE(60);
  const sectionNames = buffer.readUInt16LE(62);
  if (programCount === 0xffff) fail(label, "ELF extended program-header counts are not accepted");
  if (sectionCount === 0 && sectionOffset !== 0) fail(label, "ELF extended section-header counts are not accepted");
  if (sectionCount > 0 && sectionNames !== 0 && sectionNames >= sectionCount) {
    fail(label, `ELF section-name table index ${sectionNames} is out of range`);
  }
  validateElfTable(buffer, programOffset, programEntrySize, programCount, 56, label, "program-header table");
  validateElfTable(buffer, sectionOffset, sectionEntrySize, sectionCount, 64, label, "section-header table");

  const requiredVersions = scanRequiredElfVersions(buffer);
  let androidApi = null;
  if (Number.isSafeInteger(contract.elf.androidApiLevel)) {
    const forbiddenFamilies = new Set(contract.elf.forbiddenRequiredVersionFamilies);
    const forbidden = requiredVersions.find(({ family }) => forbiddenFamilies.has(family));
    if (forbidden !== undefined) {
      fail(label, `Android ELF requires forbidden GNU desktop runtime version ${forbidden.name}`);
    }
    if (elfType === ELF_TYPE_EXEC || elfType === ELF_TYPE_DYN) {
      const apiNotes = androidApiNotes(buffer, sectionOffset, sectionEntrySize, sectionCount, label);
      if (apiNotes.length !== 1) {
        fail(label, `Android ELF must contain exactly one .note.android.ident API record, found ${apiNotes.length}`);
      }
      androidApi = apiNotes[0];
      if (androidApi !== contract.elf.androidApiLevel) {
        fail(
          label,
          `Android ELF API level ${androidApi} does not match the release contract ${contract.elf.androidApiLevel}`,
        );
      }
    }
  } else {
    for (const required of requiredVersions) {
      const ceiling = contract.elf.maximumRequiredVersions[required.family];
      if (ceiling === undefined) continue;
      if (compareVersion(required.version, ceiling) > 0) {
        fail(
          label,
          `${required.name} exceeds the ${required.family} compatibility ceiling ${formatVersion(ceiling)}`,
        );
      }
    }
  }
  return {
    machine: contract.architecture,
    androidApi,
    requiredVersions: requiredVersions.map(({ name }) => name).sort(),
  };
}

function parsePe(buffer, label, contract) {
  requireRange(buffer, 0, 64, label, "DOS header");
  if (buffer[0] !== 0x4d || buffer[1] !== 0x5a) fail(label, "DOS signature is invalid");
  const peOffset = buffer.readUInt32LE(0x3c);
  requireRange(buffer, peOffset, 24, label, "PE signature and COFF header");
  if (!buffer.subarray(peOffset, peOffset + 4).equals(Buffer.from([0x50, 0x45, 0, 0]))) {
    fail(label, "PE signature is invalid");
  }
  const coff = peOffset + 4;
  const machine = buffer.readUInt16LE(coff);
  if (machine !== contract.pe.machine) {
    fail(label, `PE machine 0x${machine.toString(16)} is not ${contract.architecture}`);
  }
  const sectionCount = buffer.readUInt16LE(coff + 2);
  if (sectionCount === 0 || sectionCount > 96) fail(label, `PE section count ${sectionCount} is invalid`);
  const optionalSize = buffer.readUInt16LE(coff + 16);
  const optional = coff + 20;
  requireRange(buffer, optional, optionalSize, label, "PE optional header");
  if (optionalSize < 112) fail(label, `PE32+ optional header is only ${optionalSize} bytes`);
  if (buffer.readUInt16LE(optional) !== contract.pe.optionalHeaderMagic) {
    fail(label, "PE optional header is not PE32+");
  }
  const sizeOfHeaders = buffer.readUInt32LE(optional + 60);
  if (sizeOfHeaders === 0 || sizeOfHeaders > buffer.length) fail(label, `PE SizeOfHeaders ${sizeOfHeaders} is invalid`);
  const directoryCount = buffer.readUInt32LE(optional + 108);
  const availableDirectories = Math.floor((optionalSize - 112) / 8);
  if (directoryCount > availableDirectories) {
    fail(
      label,
      `PE optional header declares ${directoryCount} data directories but contains space for ${availableDirectories}`,
    );
  }
  const sectionTable = optional + optionalSize;
  requireRange(buffer, sectionTable, sectionCount * 40, label, "PE section table");
  const sections = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const entry = sectionTable + index * 40;
    const virtualSize = buffer.readUInt32LE(entry + 8);
    const virtualAddress = buffer.readUInt32LE(entry + 12);
    const rawSize = buffer.readUInt32LE(entry + 16);
    const rawOffset = buffer.readUInt32LE(entry + 20);
    if (rawSize > 0) requireRange(buffer, rawOffset, rawSize, label, `PE section ${index} raw data`);
    sections.push({ virtualSize, virtualAddress, rawSize, rawOffset });
  }
  let imports;
  try {
    const portableExecutable = inspectPortableExecutable(buffer, label);
    if (portableExecutable.machine !== contract.pe.machine) {
      fail(
        label,
        `PE machine 0x${portableExecutable.machine.toString(16)} is not ${contract.architecture}`,
      );
    }
    imports = portableExecutable.imports;
  } catch (error) {
    if (error instanceof PlatformBinaryContractError) throw error;
    fail(label, `PE dependency inspection failed: ${error.message}`);
  }
  const msvcRuntimeImports = imports.filter((name) => MSVC_RUNTIME_IMPORT.test(name));
  const undeclaredRuntime = msvcRuntimeImports.find(
    (name) => !WINDOWS_VC_RUNTIME_DLL_SET.has(name.toLowerCase()),
  );
  if (undeclaredRuntime !== undefined) {
    fail(label, `release PE imports undeclared or debug VC runtime ${undeclaredRuntime}`);
  }
  return {
    machine: "x64",
    imports,
    msvcRuntimeImports,
  };
}

export function inspectPlatformBinaryBuffer(input, { target, label = "binary" }) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const contract = contractFor(target, label);
  const format = detectFormat(buffer);
  if (format === null) fail(label, "file does not contain a recognized Mach-O, ELF, or PE image");
  if (format === "ar") {
    if (!["macho", "elf"].includes(contract.format)) {
      fail(label, `static ar archive is not a valid ${target} release binary`);
    }
    const slices = parseArArchive(buffer, label, contract);
    return {
      format: contract.format,
      archived: true,
      slices,
      platforms: contract.format === "macho" ? [...new Set(slices.map(({ platform }) => platform))] : [],
    };
  }
  if (format !== contract.format) {
    fail(label, `${format.toUpperCase()} content does not match target ${target} (${contract.format.toUpperCase()})`);
  }
  if (format === "macho") {
    const slices = parseMacho(buffer, label, contract);
    return { format, slices, platforms: [...new Set(slices.map(({ platform }) => platform))] };
  }
  if (format === "elf") return { format, slices: [parseElf(buffer, label, contract)], platforms: [] };
  return { format, slices: [parsePe(buffer, label, contract)], platforms: [] };
}

function finalizeInspection(
  target,
  inspected,
  labels,
  requiredApplePlatforms,
  windowsVcRuntimeProfile,
) {
  const contract = contractFor(target, "platform-binary contract");
  if (inspected.length === 0) {
    fail("platform-binary contract", `no ${contract.format.toUpperCase()} binaries were found for ${target}`);
  }
  const platforms = new Set(inspected.flatMap(({ result }) => result.platforms));
  if (contract.apple !== undefined) {
    if (requiredApplePlatforms !== undefined && !contract.apple.allowPlatformOverride) {
      fail(
        "platform-binary contract",
        `${contract.apple.carrier} does not allow a required-platform override`,
      );
    }
    const required =
      requiredApplePlatforms ??
      contract.apple.requiredPlatforms.map((key) => contract.apple.platforms[key].id);
    const missing = required.filter((platform) => !platforms.has(platform));
    if (missing.length > 0) {
      fail(
        "platform-binary contract",
        `${contract.apple.carrier} is missing ${missing.map((platform) => APPLE_PLATFORM_BY_ID.get(platform).name).join(" and ")} Mach-O content`,
      );
    }
  }
  if (contract.windowsVcRuntime !== undefined) {
    const profile = windowsVcRuntimeProfile ?? "direct";
    if (!contract.windowsVcRuntime.profiles.includes(profile)) {
      fail(
        "platform-binary contract",
        `unknown Windows VC runtime profile ${JSON.stringify(profile)}; expected ${contract.windowsVcRuntime.profiles.join(" or ")}`,
      );
    }
    const bundledRuntimeNames = labels
      .map((name) => path.basename(name))
      .filter((name) => MSVC_RUNTIME_IMPORT.test(name));
    const undeclaredPayload = bundledRuntimeNames.find(
      (name) => !WINDOWS_VC_RUNTIME_DLL_SET.has(name.toLowerCase()),
    );
    if (undeclaredPayload !== undefined) {
      fail(
        "platform-binary contract",
        `Windows carrier bundles undeclared or debug VC runtime ${undeclaredPayload}`,
      );
    }
    const bundled = new Set(bundledRuntimeNames.map((name) => name.toLowerCase()));
    const required = new Set();
    for (const { result, label } of inspected) {
      for (const slice of result.slices) {
        for (const imported of slice.msvcRuntimeImports ?? []) {
          const normalized = imported.toLowerCase();
          required.add(normalized);
          if (!bundled.has(normalized)) {
            fail(
              label,
              `imports MSVC runtime ${imported}, but the exact DLL is not bundled in the same carrier closure`,
            );
          }
        }
      }
    }
    const expected = profile === "provider" ? WINDOWS_VC_RUNTIME_DLL_SET : required;
    const missing = [...expected].filter((name) => !bundled.has(name));
    if (missing.length > 0) {
      fail(
        "platform-binary contract",
        `Windows ${profile} VC runtime profile is missing ${missing.sort().join(", ")}`,
      );
    }
    const extra = [...bundled].filter((name) => !expected.has(name));
    if (extra.length > 0) {
      fail(
        "platform-binary contract",
        `Windows carrier bundles unneeded VC runtime closure member${extra.length === 1 ? "" : "s"} ${extra.sort().join(", ")}`,
      );
    }
  }
  return {
    target,
    binaries: inspected.length,
    slices: inspected.reduce((sum, { result }) => sum + result.slices.length, 0),
    platforms: [...platforms].sort((left, right) => left - right),
    files: labels,
  };
}

export function inspectPlatformBinaryEntries(
  entries,
  {
    target,
    rootLabel = "staged release tree",
    requiredApplePlatforms,
    requireWindowsRuntimeImportLibrary = false,
    windowsVcRuntimeProfile,
  },
) {
  contractFor(target, rootLabel);
  if (requireWindowsRuntimeImportLibrary && target !== "windows-x64-msvc") {
    fail(rootLabel, "the Windows runtime import library can only be required for windows-x64-msvc");
  }
  const inspected = [];
  const labels = [];
  let windowsRuntimeImportLibrarySeen = false;
  for (const entry of entries) {
    if (entry === null || entry === undefined) continue;
    const name = String(entry.name ?? "");
    if (entry.isSymbolicLink === true) {
      fail(name || rootLabel, "staged release tree contains a symbolic link");
    }
    if (entry.isDirectory === true) continue;
    if (entry.isFile === false) {
      fail(name || rootLabel, "staged release tree contains a non-regular special entry");
    }
    const data = typeof entry.data === "function" ? entry.data() : entry.data;
    if (data === undefined) fail(name || rootLabel, "binary entry has no readable data");
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const format = detectFormat(buffer);
    const windowsRuntimeImportLibrary = name === WINDOWS_RUNTIME_IMPORT_LIBRARY_PATH;
    const windowsExtensionLegalTextLibrary =
      target === "windows-x64-msvc" &&
      isWindowsExtensionLegalTextLibrary(name, buffer, format);
    const msvcLibraryPath =
      target === "windows-x64-msvc" &&
      MSVC_LIBRARY_PATH.test(name) &&
      !windowsExtensionLegalTextLibrary;
    const expectedPath =
      EXPECTED_BINARY_PATH.test(name) ||
      STATIC_ARCHIVE_PATH.test(name) ||
      msvcLibraryPath;
    if (format === null && !expectedPath) continue;
    if (format === null) fail(name || rootLabel, "expected native binary is malformed or truncated");
    const label = name ? `${rootLabel}/${name}` : rootLabel;
    if (!windowsRuntimeImportLibrary && msvcLibraryPath) {
      fail(label, `only the exact ${WINDOWS_RUNTIME_IMPORT_LIBRARY_PATH} runtime import library is permitted`);
    }
    if (target === "windows-x64-msvc" && STATIC_ARCHIVE_PATH.test(name)) {
      fail(label, "static .a archives are not permitted in a Windows release carrier");
    }
    let result;
    if (windowsRuntimeImportLibrary) {
      if (!requireWindowsRuntimeImportLibrary) {
        fail(
          label,
          `MSVC import library is only permitted when the exact ${WINDOWS_RUNTIME_IMPORT_LIBRARY_PATH} runtime contract is required`,
        );
      }
      if (windowsRuntimeImportLibrarySeen) {
        fail(label, `staged release tree repeats ${WINDOWS_RUNTIME_IMPORT_LIBRARY_PATH}`);
      }
      if (format !== "ar") fail(label, "required MSVC import library is not an ar-format COFF archive");
      windowsRuntimeImportLibrarySeen = true;
      result = parseWindowsRuntimeImportLibrary(buffer, label, contractFor(target, label));
    } else {
      result = inspectPlatformBinaryBuffer(buffer, { target, label });
    }
    inspected.push({ result, label });
    labels.push(name);
  }
  if (requireWindowsRuntimeImportLibrary && !windowsRuntimeImportLibrarySeen) {
    fail(
      `${rootLabel}/${WINDOWS_RUNTIME_IMPORT_LIBRARY_PATH}`,
      "required Windows runtime import library is missing",
    );
  }
  return finalizeInspection(
    target,
    inspected,
    labels.sort(),
    requiredApplePlatforms,
    windowsVcRuntimeProfile,
  );
}

async function walkTree(root, relative = "") {
  const directory = path.join(root, relative);
  const names = await readdir(directory);
  names.sort();
  const entries = [];
  for (const name of names) {
    const childRelative = relative ? path.join(relative, name) : name;
    const child = path.join(root, childRelative);
    const stat = await lstat(child);
    if (stat.isSymbolicLink()) {
      fail(child, "staged release tree contains a symbolic link");
    } else if (stat.isDirectory()) {
      entries.push(...(await walkTree(root, childRelative)));
    } else if (stat.isFile()) {
      entries.push({ name: childRelative.split(path.sep).join("/"), data: await readFile(child), isFile: true });
    } else {
      fail(child, "staged release tree contains a non-regular special entry");
    }
  }
  return entries;
}

export async function inspectPlatformBinaryTree(
  root,
  {
    target,
    requiredApplePlatforms,
    requireWindowsRuntimeImportLibrary = false,
    windowsVcRuntimeProfile,
  },
) {
  const absolute = path.resolve(root);
  const stat = await lstat(absolute).catch(() => null);
  if (stat === null || !stat.isDirectory()) {
    fail(absolute, "staged release tree is missing or is not a directory");
  }
  return inspectPlatformBinaryEntries(await walkTree(absolute), {
    target,
    rootLabel: absolute,
    requiredApplePlatforms,
    requireWindowsRuntimeImportLibrary,
    windowsVcRuntimeProfile,
  });
}

function usage() {
  return "usage: tools/release/platform-binary-contract.mjs --target TARGET --root STAGED_RELEASE_TREE [--required-apple-platforms macos,ios,ios-simulator] [--require-windows-runtime-import-library] [--windows-vc-runtime-profile direct|provider]\n";
}

async function main(argv) {
  let target = "";
  let root = "";
  let requiredApplePlatforms;
  let requireWindowsRuntimeImportLibrary = false;
  let windowsVcRuntimeProfile;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--target") {
      target = argv[++index] ?? "";
    } else if (argv[index] === "--root") {
      root = argv[++index] ?? "";
    } else if (argv[index] === "--required-apple-platforms") {
      const raw = argv[++index] ?? "";
      const names = raw.split(",").filter(Boolean);
      if (names.length === 0 || new Set(names).size !== names.length) {
        fail("platform-binary-contract.mjs", "--required-apple-platforms must be a nonempty unique CSV");
      }
      requiredApplePlatforms = names.map((name) => {
        const platform = APPLE_PLATFORM_BY_CLI_NAME.get(name);
        if (platform === undefined) {
          fail("platform-binary-contract.mjs", `unknown Apple platform ${JSON.stringify(name)}`);
        }
        return platform.id;
      });
    } else if (argv[index] === "--require-windows-runtime-import-library") {
      requireWindowsRuntimeImportLibrary = true;
    } else if (argv[index] === "--windows-vc-runtime-profile") {
      windowsVcRuntimeProfile = argv[++index] ?? "";
      if (!WINDOWS_VC_RUNTIME_PROFILES.includes(windowsVcRuntimeProfile)) {
        fail(
          "platform-binary-contract.mjs",
          `--windows-vc-runtime-profile must be ${WINDOWS_VC_RUNTIME_PROFILES.join(" or ")}`,
        );
      }
    } else if (argv[index] === "--help" || argv[index] === "-h") {
      process.stdout.write(usage());
      return;
    } else {
      fail("platform-binary-contract.mjs", `unknown argument ${JSON.stringify(argv[index])}`);
    }
  }
  if (!target || !root) {
    process.stderr.write(usage());
    process.exitCode = 2;
    return;
  }
  const result = await inspectPlatformBinaryTree(root, {
    target,
    requiredApplePlatforms,
    requireWindowsRuntimeImportLibrary,
    windowsVcRuntimeProfile,
  });
  console.log(
    `platform binary contract passed: target=${result.target} binaries=${result.binaries} slices=${result.slices}`,
  );
}

if (import.meta.main) {
  try {
    await main(Bun.argv.slice(2));
  } catch (error) {
    console.error(`platform-binary-contract.mjs: ${error.message}`);
    process.exit(1);
  }
}
