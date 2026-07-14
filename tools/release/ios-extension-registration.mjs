#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const PREFIX = "ios-extension-registration.mjs";
const SCHEMA = "oliphaunt-ios-extension-registration-v1";
const PORTABLE_RE = /^[A-Za-z0-9._-]{1,128}$/u;
const C_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function fail(message) {
  console.error(`${PREFIX}: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--help" || key === "-h") {
      console.log(
        `usage: ${PREFIX} --sql-name NAME --native-module-stem STEM ` +
          "--simulator-out DIR --device-out DIR --output FILE",
      );
      process.exit(0);
    }
    const field = new Map([
      ["--sql-name", "sqlName"],
      ["--native-module-stem", "nativeModuleStem"],
      ["--simulator-out", "simulatorOut"],
      ["--device-out", "deviceOut"],
      ["--output", "output"],
    ]).get(key);
    if (field === undefined || argv[index + 1] === undefined) {
      fail(`unknown or incomplete argument ${key}`);
    }
    result[field] = argv[index + 1];
    index += 1;
  }
  for (const field of ["sqlName", "nativeModuleStem", "simulatorOut", "deviceOut", "output"]) {
    if (typeof result[field] !== "string" || result[field].length === 0) {
      fail(`--${field.replace(/[A-Z]/gu, (value) => `-${value.toLowerCase()}`)} is required`);
    }
  }
  for (const field of ["sqlName", "nativeModuleStem"]) {
    if (!PORTABLE_RE.test(result[field])) {
      fail(`${field} must be a portable identifier`);
    }
  }
  return result;
}

function lines(file) {
  return readFileSync(file, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function readRegistrationSymbols(out, stem) {
  const root = path.join(out, "extensions", stem);
  const exported = lines(path.join(root, "symbols.list")).map((name) => ({ name, address: name }));
  const aliasFile = path.join(root, "symbol-aliases.list");
  const aliases = (existsSync(aliasFile) ? lines(aliasFile) : []).map((line) => {
    const fields = line.split("\t");
    if (fields.length !== 2) {
      fail(`${aliasFile} contains an invalid alias row`);
    }
    return { name: fields[0], address: fields[1] };
  });
  const result = [...exported, ...aliases].sort((left, right) =>
    `${left.name}\0${left.address}`.localeCompare(`${right.name}\0${right.address}`),
  );
  for (const row of result) {
    if (!C_IDENTIFIER_RE.test(row.name) || !C_IDENTIFIER_RE.test(row.address)) {
      fail(`${root} contains a non-C registration symbol`);
    }
  }
  if (new Set(result.map(({ name }) => name)).size !== result.length) {
    fail(`${root} repeats a SQL-visible registration symbol`);
  }
  return result;
}

function objectFiles(out, stem) {
  const file = path.join(out, "extensions", stem, "objects.list");
  const result = lines(file);
  if (result.length === 0) {
    fail(`${file} is empty`);
  }
  return result;
}

function definedSymbols(out, stem) {
  const objects = objectFiles(out, stem);
  const result = spawnSync("nm", ["-g", ...objects], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0) {
    fail(`nm failed for ${out}/${stem}: ${(result.stderr || result.error?.message || "").trim()}`);
  }
  const names = new Set();
  for (const raw of result.stdout.split(/\r?\n/u)) {
    const fields = raw.trim().split(/\s+/u);
    if (fields.length < 2) continue;
    const type = fields.at(-2);
    const rawName = fields.at(-1);
    if (!/^[A-Za-z]$/u.test(type) || type.toUpperCase() === "U") continue;
    names.add(rawName.startsWith("_") ? rawName.slice(1) : rawName);
  }
  return names;
}

function registration(out, sqlName, stem) {
  const prefix = `oliphaunt_static_${stem.replaceAll(/[^A-Za-z0-9_]/gu, "_")}`;
  const names = definedSymbols(out, stem);
  const magicSymbol = `${prefix}_Pg_magic_func`;
  if (!names.has(magicSymbol)) {
    fail(`${out} ${sqlName} archive does not export required ${magicSymbol}`);
  }
  const init = `${prefix}__PG_init`;
  return {
    initSymbol: names.has(init) ? init : null,
    magicSymbol,
    symbols: readRegistrationSymbols(out, stem),
  };
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const simulator = registration(args.simulatorOut, args.sqlName, args.nativeModuleStem);
  const device = registration(args.deviceOut, args.sqlName, args.nativeModuleStem);
  if (JSON.stringify(simulator) !== JSON.stringify(device)) {
    fail(`${args.sqlName} simulator and device registration metadata differ`);
  }
  const output = stable({
    schema: SCHEMA,
    sqlName: args.sqlName,
    nativeModuleStem: args.nativeModuleStem,
    ...simulator,
  });
  mkdirSync(path.dirname(args.output), { recursive: true });
  writeFileSync(args.output, `${JSON.stringify(output, null, 2)}\n`, "utf8");
}
