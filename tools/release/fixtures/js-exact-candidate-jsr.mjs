import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

const candidateSha = requiredEnv("OLIPHAUNT_CANDIDATE_SHA");
const candidateTree = requiredEnv("OLIPHAUNT_CANDIDATE_TREE");
const jsrSourceRoot = path.resolve(requiredEnv("OLIPHAUNT_JSR_SOURCE_ROOT"));
const receiptPath = path.resolve(requiredEnv("OLIPHAUNT_CONSUMER_RECEIPT"));
assert.match(candidateSha, /^[0-9a-f]{40}$/u);
assert.match(candidateTree, /^[0-9a-f]{40}$/u);
assert.equal(typeof globalThis.Deno?.version?.deno, "string", "JSR proof must execute in Deno");

const staged = await import(pathToFileURL(path.join(jsrSourceRoot, "src", "jsr.ts")).href);
assert.deepEqual(await staged.Oliphaunt.supportedModes(), []);
await assert.rejects(
  () => staged.Oliphaunt.open(),
  /Native Oliphaunt runtimes are not available from jsr:@oliphaunt\/ts/u,
);
const request = staged.simpleQuery("SELECT 1");
assert.ok(request instanceof Uint8Array);
assert.equal(new TextDecoder().decode(request.slice(5)), "SELECT 1\0");

await mkdir(path.dirname(receiptPath), { recursive: true });
await writeFile(receiptPath, `${JSON.stringify({
  schemaVersion: 1,
  candidateSha,
  candidateTree,
  runtime: "deno",
  carrier: "jsr-source",
  nativeModes: [],
  portableProtocolApiVerified: true,
  nativeBoundaryRejected: true,
}, null, 2)}\n`, "utf8");
