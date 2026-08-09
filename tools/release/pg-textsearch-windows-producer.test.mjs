#!/usr/bin/env bun
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dir, "../..");
const producerPath = path.join(
  root,
  "src/runtimes/liboliphaunt/native/bin/build-postgres18-windows.ps1",
);
const producer = readFileSync(producerPath, "utf8");

test("pg_textsearch Windows packed structs are patched exactly and remain balanced", () => {
  assert.match(producer, /function Patch-PgTextsearchWindowsTypeLayout\(/u);
  assert.match(
    producer,
    /\$declarationPattern = "\(\?m\)\^typedef struct \$escapedTypeName\\r\?\$"/u,
  );
  assert.match(
    producer,
    /StaticAssertDecl\(sizeof\(\$TypeName\) == \$ExpectedSize/u,
  );
  assert.match(
    producer,
    /Patch-PgTextsearchWindowsTypeLayout \$text "TpSkipEntryV3" "packed" 1 16 1/u,
  );
  assert.match(
    producer,
    /Patch-PgTextsearchWindowsTypeLayout \$text "TpSkipEntry" "packed" 1 20 1/u,
  );
  assert.doesNotMatch(
    producer,
    /[.]Replace\(\s*"typedef struct TpSkipEntry"/gu,
  );

  const declarations = ["TpSkipEntryV3", "TpSkipEntry", "TpCtidMapEntry"]
    .map((name) => `typedef struct ${name}\n{\n} __attribute__((packed)) ${name};`)
    .join("\n");
  let patched = declarations;
  for (const name of ["TpSkipEntryV3", "TpSkipEntry", "TpCtidMapEntry"]) {
    const start = new RegExp(`^typedef struct ${name}$`, "mu");
    const end = new RegExp(`^\\} __attribute__\\(\\(packed\\)\\) ${name};$`, "mu");
    assert.equal(patched.match(start)?.length, 1, `${name} start`);
    assert.equal(patched.match(end)?.length, 1, `${name} end`);
    patched = patched.replace(start, `#pragma pack(push, 1)\ntypedef struct ${name}`);
    patched = patched.replace(end, `} ${name};\n#pragma pack(pop)`);
  }
  assert.equal(patched.match(/^#pragma pack\(push, 1\)$/gmu)?.length, 3);
  assert.equal(patched.match(/^#pragma pack\(pop\)$/gmu)?.length, 3);
});

test("pg_textsearch Windows inputs are derived from the pinned upstream Makefile", () => {
  assert.match(producer, /function Get-PgTextsearchMakefileList\(/u);
  assert.match(producer, /Get-PgTextsearchMakefileList \$ExtensionDir "OBJS"/u);
  assert.match(producer, /Get-PgTextsearchMakefileList \$ExtensionDir "DATA"/u);
  assert.match(producer, /input declared by the pinned Makefile is missing/u);
  assert.doesNotMatch(producer, /"src\/mod[.]c"/u);
  assert.doesNotMatch(producer, /"sql\/pg_textsearch--1[.]3[.]1[.]sql"/u);
});
