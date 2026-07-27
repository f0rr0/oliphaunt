#!/usr/bin/env bun

function fail(message) {
  console.error(message);
  process.exit(2);
}

function usage() {
  fail("usage: wasix-toml-value.mjs string|string-list <toml-file> <top-level-key>");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const [mode, file, key] = Bun.argv.slice(2);
if ((mode !== "string" && mode !== "string-list") || !file || !key) {
  usage();
}

let data;
try {
  data = Bun.TOML.parse(await Bun.file(file).text());
} catch (error) {
  fail(`could not read TOML file ${file}: ${error.message}`);
}

if (!isObject(data)) {
  fail(`${file} must contain a TOML table`);
}

if (mode === "string-list") {
  const values = Object.hasOwn(data, key) ? data[key] : [];
  if (!Array.isArray(values) || !values.every((value) => typeof value === "string")) {
    fail(`${file} field ${key} must be an array of strings`);
  }
  for (const value of values) {
    console.log(value);
  }
} else {
  const value = data[key];
  if (typeof value !== "string" || value.length === 0) {
    fail(`${file} field ${key} must be a non-empty string`);
  }
  console.log(value);
}
