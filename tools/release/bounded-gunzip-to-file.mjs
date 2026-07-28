#!/usr/bin/env node

import { createReadStream, createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

const [input, output, rawLimit] = process.argv.slice(2);
const limit = Number(rawLimit);
if (
  typeof input !== "string"
  || typeof output !== "string"
  || !Number.isSafeInteger(limit)
  || limit <= 0
) {
  throw new Error("bounded-gunzip-to-file.mjs requires <input> <output> <positive-byte-limit>");
}

let expanded = 0;
const bound = new Transform({
  transform(chunk, _encoding, callback) {
    expanded += chunk.length;
    if (expanded > limit) {
      callback(new Error(`expanded gzip stream exceeds ${limit} bytes`));
      return;
    }
    callback(null, chunk);
  },
});

await pipeline(
  createReadStream(input),
  createGunzip(),
  bound,
  createWriteStream(output, { flags: "wx", mode: 0o600 }),
);
