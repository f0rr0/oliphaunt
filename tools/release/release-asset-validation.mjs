import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { readPortableArchiveEntries } from "./portable-archive.mjs";

export async function assertFileExists(file) {
  const stat = await fs.stat(file).catch(() => null);
  return stat?.isFile() === true;
}

export async function sha256(file) {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

export async function checksumManifest(file, fail, prefix) {
  const values = new Map();
  const lines = (await fs.readFile(file, "utf8")).split(/\r?\n/u);
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const parts = line.split(/\s+/u);
    if (parts.length < 2 || parts[0].length !== 64) {
      fail(prefix, `malformed checksum line ${index + 1}: ${rawLine}`);
    }
    values.set(parts.slice(1).join(" ").replace(/^\.\//u, ""), parts[0].toLowerCase());
  }
  return values;
}

export async function readArchiveEntries(file, fail, prefix, productLabel) {
  try {
    return readPortableArchiveEntries(file);
  } catch (error) {
    fail(prefix, `${path.basename(file)} is not a valid ${productLabel} archive: ${error.message}`);
  }
}
