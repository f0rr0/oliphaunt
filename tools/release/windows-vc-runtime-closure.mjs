#!/usr/bin/env bun
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOOL = "windows-vc-runtime-closure.mjs";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const POLICY = JSON.parse(
  readFileSync(path.join(ROOT, "tools/release/native-runtime-payload-policy.json"), "utf8"),
);
const PE_MACHINE_AMD64 = 0x8664;
const PE_MAGIC_32 = 0x10b;
const PE_MAGIC_64 = 0x20b;
// Treat every Microsoft C/C++ runtime family as policy-controlled. This makes
// debug/non-redistributable or future runtime imports fail closed instead of
// silently relying on whatever happens to be installed on a build host.
const VC_RUNTIME_IMPORT = /^(?:atl|concrt|mfc|mfcm|msvcp|ucrtbase|vcamp|vcomp|vcruntime)[a-z0-9_]*\.dll$/iu;
const CRT_DIRECTORY = "Microsoft.VC145.CRT";

export const WINDOWS_VC_RUNTIME_DLLS = Object.freeze(
  [...POLICY.windowsVcRuntimeDlls].map((name) => String(name).toLowerCase()).sort(),
);
export const WINDOWS_VC_RUNTIME_PROFILES = Object.freeze(
  Object.fromEntries(
    Object.entries(POLICY.windowsVcRuntimeProfiles ?? {}).map(([profile, names]) => [
      profile,
      Object.freeze([...names].map((name) => String(name).toLowerCase()).sort()),
    ]),
  ),
);
export const WINDOWS_VC_RUNTIME_RECEIPT = String(POLICY.windowsVcRuntimeReceipt);

function failure(message) {
  return new Error(`${TOOL}: ${message}`);
}

function fail(message) {
  console.error(`${TOOL}: ${message}`);
  process.exit(1);
}

function requireRange(buffer, offset, length, label) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > buffer.length) {
    throw failure(`${label} is truncated at byte ${offset}`);
  }
}

function readAsciiZ(buffer, offset, label) {
  requireRange(buffer, offset, 1, label);
  const limit = Math.min(buffer.length, offset + 4096);
  let end = offset;
  while (end < limit && buffer[end] !== 0) {
    const byte = buffer[end];
    if (byte < 0x20 || byte > 0x7e) {
      throw failure(`${label} contains a non-ASCII import name`);
    }
    end += 1;
  }
  if (end === limit || buffer[end] !== 0) {
    throw failure(`${label} has an unterminated import name`);
  }
  const value = buffer.subarray(offset, end).toString("ascii");
  if (!value || value.includes("/") || value.includes("\\")) {
    throw failure(`${label} has an invalid import basename ${JSON.stringify(value)}`);
  }
  return value;
}

function parsePortableExecutable(input, label = "portable executable") {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  requireRange(buffer, 0, 0x40, label);
  if (buffer.subarray(0, 2).toString("ascii") !== "MZ") {
    throw failure(`${label} is not a PE image`);
  }
  const peOffset = buffer.readUInt32LE(0x3c);
  requireRange(buffer, peOffset, 24, label);
  if (!buffer.subarray(peOffset, peOffset + 4).equals(Buffer.from("PE\0\0", "binary"))) {
    throw failure(`${label} has no PE signature`);
  }
  const coff = peOffset + 4;
  const machine = buffer.readUInt16LE(coff);
  const sectionCount = buffer.readUInt16LE(coff + 2);
  const optionalSize = buffer.readUInt16LE(coff + 16);
  const optional = coff + 20;
  requireRange(buffer, optional, optionalSize, label);
  const magic = buffer.readUInt16LE(optional);
  if (magic !== PE_MAGIC_32 && magic !== PE_MAGIC_64) {
    throw failure(`${label} has unsupported PE optional-header magic 0x${magic.toString(16)}`);
  }
  const imageBase = magic === PE_MAGIC_64
    ? Number(buffer.readBigUInt64LE(optional + 24))
    : buffer.readUInt32LE(optional + 28);
  if (!Number.isSafeInteger(imageBase)) {
    throw failure(`${label} has an unsupported image base`);
  }
  const dataDirectoryOffset = optional + (magic === PE_MAGIC_64 ? 112 : 96);
  const directoryCountOffset = optional + (magic === PE_MAGIC_64 ? 108 : 92);
  requireRange(buffer, directoryCountOffset, 4, label);
  const directoryCount = buffer.readUInt32LE(directoryCountOffset);

  const sections = [];
  let sectionOffset = optional + optionalSize;
  for (let index = 0; index < sectionCount; index += 1) {
    requireRange(buffer, sectionOffset, 40, label);
    sections.push({
      virtualSize: buffer.readUInt32LE(sectionOffset + 8),
      virtualAddress: buffer.readUInt32LE(sectionOffset + 12),
      rawSize: buffer.readUInt32LE(sectionOffset + 16),
      rawOffset: buffer.readUInt32LE(sectionOffset + 20),
    });
    sectionOffset += 40;
  }

  const rvaOffset = (rva, field) => {
    for (const section of sections) {
      const span = Math.max(section.virtualSize, section.rawSize);
      if (rva >= section.virtualAddress && rva < section.virtualAddress + span) {
        const delta = rva - section.virtualAddress;
        if (delta >= section.rawSize) {
          throw failure(`${label} ${field} points outside section file data`);
        }
        const offset = section.rawOffset + delta;
        requireRange(buffer, offset, 1, label);
        return offset;
      }
    }
    throw failure(`${label} ${field} RVA 0x${rva.toString(16)} is not mapped by a section`);
  };

  const directory = (index) => {
    if (directoryCount <= index || dataDirectoryOffset + (index + 1) * 8 > optional + optionalSize) {
      return { rva: 0, size: 0 };
    }
    return {
      rva: buffer.readUInt32LE(dataDirectoryOffset + index * 8),
      size: buffer.readUInt32LE(dataDirectoryOffset + index * 8 + 4),
    };
  };

  const imports = new Set();
  const normal = directory(1);
  if (normal.rva !== 0) {
    let descriptor = rvaOffset(normal.rva, "import directory");
    const end = normal.size > 0 ? Math.min(buffer.length, descriptor + normal.size) : buffer.length;
    let terminated = false;
    for (let count = 0; descriptor + 20 <= end && count < 4096; count += 1) {
      requireRange(buffer, descriptor, 20, label);
      const empty = buffer.subarray(descriptor, descriptor + 20).every((byte) => byte === 0);
      if (empty) {
        terminated = true;
        break;
      }
      const nameRva = buffer.readUInt32LE(descriptor + 12);
      if (nameRva === 0) {
        throw failure(`${label} has an import descriptor without a DLL name`);
      }
      imports.add(readAsciiZ(buffer, rvaOffset(nameRva, "import name"), label));
      descriptor += 20;
    }
    if (!terminated) {
      throw failure(`${label} has an unterminated import descriptor table`);
    }
  }

  const delayed = directory(13);
  if (delayed.rva !== 0) {
    let descriptor = rvaOffset(delayed.rva, "delay import directory");
    const end = delayed.size > 0 ? Math.min(buffer.length, descriptor + delayed.size) : buffer.length;
    let terminated = false;
    for (let count = 0; descriptor + 32 <= end && count < 4096; count += 1) {
      requireRange(buffer, descriptor, 32, label);
      const empty = buffer.subarray(descriptor, descriptor + 32).every((byte) => byte === 0);
      if (empty) {
        terminated = true;
        break;
      }
      const attributes = buffer.readUInt32LE(descriptor);
      const rawName = buffer.readUInt32LE(descriptor + 4);
      const nameRva = (attributes & 1) !== 0 ? rawName : rawName - imageBase;
      if (!Number.isSafeInteger(nameRva) || nameRva <= 0) {
        throw failure(`${label} has an invalid delay-import DLL name`);
      }
      imports.add(readAsciiZ(buffer, rvaOffset(nameRva, "delay import name"), label));
      descriptor += 32;
    }
    if (!terminated) {
      throw failure(`${label} has an unterminated delay-import descriptor table`);
    }
  }

  return {
    machine,
    magic,
    imports: [...imports].sort(),
  };
}

export function inspectPortableExecutable(input, label) {
  const buffer = Buffer.isBuffer(input) ? input : readFileSync(input);
  return parsePortableExecutable(buffer, label ?? String(input));
}

export function windowsVcRuntimeImports(input, label) {
  return inspectPortableExecutable(input, label).imports.filter((name) => VC_RUNTIME_IMPORT.test(name));
}

function isRegularFile(file) {
  try {
    const stat = lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function requireDirectory(directory, label) {
  let stat;
  try {
    stat = lstatSync(directory);
  } catch (error) {
    throw failure(`${label} does not exist at ${directory}: ${error.message}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw failure(`${label} must be a real directory: ${directory}`);
  }
}

function entriesByLowercase(directory) {
  const result = new Map();
  for (const name of readdirSync(directory)) {
    const key = name.toLowerCase();
    if (result.has(key)) {
      throw failure(`${directory} has case-colliding entries ${result.get(key)} and ${name}`);
    }
    result.set(key, name);
  }
  return result;
}

export function resolveInitializedVcRuntimeDirectory(redistRoot = process.env.VCToolsRedistDir) {
  if (typeof redistRoot !== "string" || !redistRoot.trim()) {
    throw failure("VCToolsRedistDir is not set; initialize the exact x64 MSVC developer environment first");
  }
  const root = path.resolve(redistRoot);
  requireDirectory(root, "VCToolsRedistDir");
  const x64 = path.join(root, "x64");
  requireDirectory(x64, "x64 VC redistributable directory");
  const candidates = readdirSync(x64, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && entry.name === CRT_DIRECTORY)
    .map((entry) => path.join(x64, entry.name))
    .filter((directory) => {
      const names = entriesByLowercase(directory);
      return WINDOWS_VC_RUNTIME_DLLS.every((name) => names.has(name));
    });
  if (candidates.length !== 1) {
    throw failure(
      `${x64} must contain exactly one initialized ${CRT_DIRECTORY} directory with ${WINDOWS_VC_RUNTIME_DLLS.join(", ")}; found ${candidates.length}`,
    );
  }
  return candidates[0];
}

function requiredSource(sourceDirectory, expected) {
  requireDirectory(sourceDirectory, "VC runtime source directory");
  const names = entriesByLowercase(sourceDirectory);
  const actual = names.get(expected);
  if (!actual) {
    throw failure(`${sourceDirectory} is missing import-derived ${expected}`);
  }
  const source = path.join(sourceDirectory, actual);
  if (!isRegularFile(source) || path.basename(source).toLowerCase() !== expected) {
    throw failure(`${source} must be a regular file with exact basename ${expected}`);
  }
  const pe = inspectPortableExecutable(source);
  if (pe.machine !== PE_MACHINE_AMD64 || pe.magic !== PE_MAGIC_64) {
    throw failure(
      `${source} is not an x64 PE32+ image (machine 0x${pe.machine.toString(16)}, magic 0x${pe.magic.toString(16)})`,
    );
  }
  return { expected, source, pe };
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function copyAtomic(source, destination) {
  mkdirSync(path.dirname(destination), { recursive: true });
  const sourceDigest = sha256(source);
  if (existsSync(destination)) {
    if (!isRegularFile(destination)) {
      throw failure(`${destination} already exists and is not a regular file`);
    }
    if (sha256(destination) === sourceDigest) return;
  }
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.partial.${process.pid}.${randomUUID()}`,
  );
  let descriptor;
  try {
    copyFileSync(source, temporary, constants.COPYFILE_EXCL);
    // FlushFileBuffers requires a handle opened with write access on Windows.
    // Bun forwards fsyncSync to that API, so reopening the copied file read-only
    // makes an otherwise valid atomic stage fail with EPERM on Windows runners.
    descriptor = openSync(temporary, "r+");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    if (sha256(temporary) !== sourceDigest) {
      throw failure(`atomic copy of ${source} changed bytes before promotion`);
    }
    // libuv maps rename-over-file to an atomic replace on Windows. If the
    // replace is denied (for example, a locked DLL), the old durable file is
    // retained and the unique partial is removed in finally.
    renameSync(temporary, destination);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function writeAtomic(destination, content) {
  mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.partial.${process.pid}.${randomUUID()}`,
  );
  let descriptor;
  try {
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o644);
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, destination);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function checkedRuntimeImport(name, importer) {
  const normalized = name.toLowerCase();
  if (!WINDOWS_VC_RUNTIME_DLLS.includes(normalized)) {
    throw failure(`${importer} imports undeclared or debug VC runtime ${name}; update the audited production closure from actual binary evidence`);
  }
  return normalized;
}

export function windowsVcRuntimeProfileNames(profile) {
  if (profile === undefined || profile === null || profile === "") return [];
  const names = WINDOWS_VC_RUNTIME_PROFILES[profile];
  if (names === undefined) {
    throw failure(
      `unknown VC runtime profile ${profile}; expected one of ${Object.keys(WINDOWS_VC_RUNTIME_PROFILES).sort().join(", ")}`,
    );
  }
  for (const name of names) checkedRuntimeImport(name, `VC runtime profile ${profile}`);
  return [...names];
}

function carrierInventory(root) {
  const inventory = [];
  const direct = new Set();
  for (const file of walkRegularFiles(root)) {
    if (!isPe(file)) continue;
    const pe = inspectPortableExecutable(file);
    if (pe.machine !== PE_MACHINE_AMD64 || pe.magic !== PE_MAGIC_64) {
      throw failure(
        `${file} is not an x64 PE32+ image (machine 0x${pe.machine.toString(16)}, magic 0x${pe.magic.toString(16)})`,
      );
    }
    const imports = pe.imports.filter((name) => VC_RUNTIME_IMPORT.test(name));
    const basename = path.basename(file).toLowerCase();
    if (!WINDOWS_VC_RUNTIME_DLLS.includes(basename)) {
      for (const imported of imports) direct.add(checkedRuntimeImport(imported, file));
    }
    inventory.push({
      file: path.relative(root, file).split(path.sep).join("/"),
      vcRuntimeImports: imports,
    });
  }
  return { direct, inventory };
}

function closureFromSource(direct, sourceDirectory) {
  const required = new Map();
  const pending = [...direct].sort();
  while (pending.length > 0) {
    const name = pending.shift();
    if (required.has(name)) continue;
    const source = requiredSource(sourceDirectory, name);
    required.set(name, source);
    for (const imported of source.pe.imports.filter((value) => VC_RUNTIME_IMPORT.test(value))) {
      const dependency = checkedRuntimeImport(imported, source.source);
      if (!required.has(dependency)) pending.push(dependency);
    }
    pending.sort();
  }
  return required;
}

function receiptText(required) {
  return [...required]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([name, { source }]) => `${sha256(source)}  ${name}\n`)
    .join("");
}

export function parseWindowsVcRuntimeReceipt(input, label = WINDOWS_VC_RUNTIME_RECEIPT) {
  const text = Buffer.isBuffer(input) ? input.toString("utf8") : String(input);
  const values = new Map();
  for (const [index, raw] of text.split(/\r?\n/u).entries()) {
    if (!raw) continue;
    const match = /^([0-9a-f]{64})  ([a-z0-9_]+\.dll)$/u.exec(raw);
    if (!match) throw failure(`${label} has malformed line ${index + 1}`);
    const [, digest, name] = match;
    if (!WINDOWS_VC_RUNTIME_DLLS.includes(name) || values.has(name)) {
      throw failure(`${label} has undeclared or duplicate entry ${name}`);
    }
    values.set(name, digest);
  }
  if (values.size === 0) throw failure(`${label} must not be empty`);
  const sorted = [...values.keys()].sort();
  if (text !== sorted.map((name) => `${values.get(name)}  ${name}\n`).join("")) {
    throw failure(`${label} must be lowercase, sorted, and canonical`);
  }
  return values;
}

function parseReceipt(directory) {
  const receipt = path.join(directory, WINDOWS_VC_RUNTIME_RECEIPT);
  if (!isRegularFile(receipt)) {
    throw failure(`${directory} is missing regular VC runtime digest receipt ${WINDOWS_VC_RUNTIME_RECEIPT}`);
  }
  const values = parseWindowsVcRuntimeReceipt(readFileSync(receipt), receipt);
  for (const [name, digest] of values) {
    const file = path.join(directory, name);
    if (!isRegularFile(file) || sha256(file) !== digest) {
      throw failure(`${receipt} does not match regular ${file}`);
    }
  }
  return values;
}

function removeStaleRuntimeFiles(destination, requiredNames) {
  const names = entriesByLowercase(destination);
  for (const allowed of WINDOWS_VC_RUNTIME_DLLS) {
    const actual = names.get(allowed);
    if (actual === undefined || requiredNames.has(allowed)) continue;
    const stale = path.join(destination, actual);
    if (!isRegularFile(stale)) throw failure(`refusing to remove non-regular stale VC runtime ${stale}`);
    rmSync(stale);
  }
}

export function stageWindowsVcRuntime({ root, redistRoot, sourceDirectory, destinations, profile }) {
  const resolvedRoot = path.resolve(root);
  requireDirectory(resolvedRoot, "dependency-closure root");
  if (!Array.isArray(destinations) || destinations.length === 0) {
    throw failure("at least one destination is required");
  }
  if (redistRoot !== undefined && sourceDirectory !== undefined) {
    throw failure("redistRoot and sourceDirectory are mutually exclusive");
  }
  const source = sourceDirectory === undefined
    ? resolveInitializedVcRuntimeDirectory(redistRoot)
    : path.resolve(sourceDirectory);
  if (sourceDirectory !== undefined) parseReceipt(source);
  const { direct } = carrierInventory(resolvedRoot);
  for (const name of windowsVcRuntimeProfileNames(profile)) direct.add(name);
  const sources = closureFromSource(direct, source);
  const requiredNames = new Set(sources.keys());
  for (const destinationValue of destinations) {
    const destination = path.resolve(destinationValue);
    if (!within(resolvedRoot, destination)) {
      throw failure(`VC runtime destination must stay within ${resolvedRoot}: ${destination}`);
    }
    mkdirSync(destination, { recursive: true });
    requireDirectory(destination, "VC runtime destination");
    for (const entry of sources.values()) {
      copyAtomic(entry.source, path.join(destination, entry.expected));
    }
    removeStaleRuntimeFiles(destination, requiredNames);
    const receipt = path.join(destination, WINDOWS_VC_RUNTIME_RECEIPT);
    if (sources.size === 0) rmSync(receipt, { force: true });
    else writeAtomic(receipt, receiptText(sources));
  }
  return verifyWindowsVcRuntimeClosure({ root: resolvedRoot, searchRoots: destinations, profile });
}

function walkRegularFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw failure(`dependency-closure root contains a symbolic link: ${file}`);
      }
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) files.push(file);
    }
  };
  visit(root);
  return files.sort();
}

function isPe(file) {
  if (!isRegularFile(file)) return false;
  const buffer = readFileSync(file);
  return buffer.length >= 2 && buffer[0] === 0x4d && buffer[1] === 0x5a;
}

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function verifyWindowsVcRuntimeClosure({ root, searchRoots, profile }) {
  const resolvedRoot = path.resolve(root);
  requireDirectory(resolvedRoot, "dependency-closure root");
  if (!Array.isArray(searchRoots) || searchRoots.length === 0) {
    throw failure("at least one dependency search root is required");
  }
  const resolvedSearchRoots = searchRoots.map((value) => path.resolve(value));
  const { direct, inventory } = carrierInventory(resolvedRoot);
  for (const name of windowsVcRuntimeProfileNames(profile)) direct.add(name);
  const sourceRoot = resolvedSearchRoots[0];
  const required = closureFromSource(direct, sourceRoot);
  const expected = new Set(required.keys());
  for (const searchRoot of resolvedSearchRoots) {
    if (!within(resolvedRoot, searchRoot)) {
      throw failure(`dependency search root must stay within ${resolvedRoot}: ${searchRoot}`);
    }
    requireDirectory(searchRoot, "dependency search root");
    const names = entriesByLowercase(searchRoot);
    const actual = new Set(WINDOWS_VC_RUNTIME_DLLS.filter((name) => names.has(name)));
    const missing = [...expected].filter((name) => !actual.has(name));
    const extra = [...actual].filter((name) => !expected.has(name));
    if (missing.length > 0 || extra.length > 0) {
      throw failure(`${searchRoot} VC runtime closure mismatch; missing [${missing.sort().join(", ")}], extra [${extra.sort().join(", ")}]`);
    }
    if (expected.size === 0) {
      if (names.has(WINDOWS_VC_RUNTIME_RECEIPT.toLowerCase())) {
        throw failure(`${searchRoot} has a VC runtime receipt but its carrier imports no VC runtime`);
      }
      continue;
    }
    const receipt = parseReceipt(searchRoot);
    if ([...receipt.keys()].sort().join("\0") !== [...expected].sort().join("\0")) {
      throw failure(`${searchRoot} digest receipt does not exactly describe its import-derived VC runtime closure`);
    }
  }
  return { required: [...expected].sort(), inventory };
}

function parseArgs(argv) {
  const command = argv[0];
  const args = {
    command,
    redistRoot: undefined,
    sourceDirectory: undefined,
    profile: undefined,
    destinations: [],
    root: undefined,
    searchRoots: [],
    json: false,
    printRequired: false,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--json") {
      args.json = true;
      continue;
    }
    if (flag === "--print-required") {
      args.printRequired = true;
      continue;
    }
    const value = argv[++index];
    if (value === undefined) throw failure(`${flag} requires a value`);
    if (flag === "--redist-root") args.redistRoot = value;
    else if (flag === "--source-dir") args.sourceDirectory = value;
    else if (flag === "--destination") args.destinations.push(value);
    else if (flag === "--profile") args.profile = value;
    else if (flag === "--root") args.root = value;
    else if (flag === "--search-root") args.searchRoots.push(value);
    else throw failure(`unknown argument ${flag}`);
  }
  return args;
}

function usage() {
  return `Usage:
  ${TOOL} stage --root DIR [--redist-root DIR | --source-dir DIR] [--profile NAME] --destination DIR [--destination DIR ...] [--print-required]
  ${TOOL} verify --root DIR [--profile NAME] --search-root DIR [--search-root DIR ...] [--json] [--print-required]
`;
}

export function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
    if (args.command === "stage") {
      if (!args.root) throw failure("stage requires --root");
      const result = stageWindowsVcRuntime({
        root: args.root,
        redistRoot: args.redistRoot,
        sourceDirectory: args.sourceDirectory,
        destinations: args.destinations,
        profile: args.profile,
      });
      if (args.printRequired) console.log(result.required.join(","));
      return;
    }
    if (args.command === "verify") {
      if (!args.root) throw failure("verify requires --root");
      const result = verifyWindowsVcRuntimeClosure({ root: args.root, searchRoots: args.searchRoots, profile: args.profile });
      if (args.json) console.log(JSON.stringify(result, null, 2));
      if (args.printRequired) console.log(result.required.join(","));
      return;
    }
    console.error(usage());
    process.exit(2);
  } catch (error) {
    fail(error instanceof Error ? error.message.replace(`${TOOL}: `, "") : String(error));
  }
}

if (import.meta.main) main();
