#!/usr/bin/env node

import path from "node:path";
import { extractVerifiedZipArchive } from "./swift-carrier-resolver.mjs";

function fail(message) {
  throw new Error(`extract-verified-zip.mjs: ${message}`);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--help" || key === "-h") {
      console.log("usage: extract-verified-zip.mjs --archive FILE --destination DIRECTORY");
      process.exit(0);
    }
    const field = new Map([
      ["--archive", "archive"],
      ["--destination", "destination"],
    ]).get(key);
    if (field === undefined || argv[index + 1] === undefined) {
      fail(`unknown or incomplete option: ${key}`);
    }
    result[field] = argv[index + 1];
    index += 1;
  }
  for (const field of ["archive", "destination"]) {
    if (typeof result[field] !== "string" || result[field].length === 0) {
      fail(`--${field} is required`);
    }
  }
  return result;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const tree = await extractVerifiedZipArchive({
    archive: path.resolve(args.archive),
    destination: path.resolve(args.destination),
  });
  console.log(`verified and extracted ${tree.length} ZIP entries to ${path.resolve(args.destination)}`);
} catch (error) {
  console.error(error.stack ?? String(error));
  process.exit(1);
}
