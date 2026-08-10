#!/usr/bin/env bun
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dir, "../..");
const productRoot = path.join(root, "src/extensions/external/pg_textsearch");
const recipePath = path.join(productRoot, "patches/windows-msvc/recipe.json");
const sourceManifestPath = path.join(productRoot, "source.toml");
const checkout = path.join(root, "target/oliphaunt-sources/checkouts/pg_textsearch");
const producerPath = path.join(
  root,
  "src/runtimes/liboliphaunt/native/bin/build-postgres18-windows.ps1",
);
const recipe = JSON.parse(readFileSync(recipePath, "utf8"));
const sourceManifest = Bun.TOML.parse(readFileSync(sourceManifestPath, "utf8"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result.stdout.trim();
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function contained(rootPath, relativePath, label) {
  assert.equal(typeof relativePath, "string", `${label} must be a string`);
  assert.match(relativePath, /^[A-Za-z0-9_./-]+$/u, `${label} alphabet`);
  assert.equal(relativePath.includes("\\"), false, `${label} must use forward slashes`);
  assert.equal(path.posix.isAbsolute(relativePath), false, `${label} POSIX root`);
  assert.equal(path.win32.isAbsolute(relativePath), false, `${label} Windows root`);
  const segments = relativePath.split("/");
  assert.equal(
    segments.some((segment) => segment === "" || segment === "." || segment === ".."),
    false,
    `${label} traversal segment`,
  );
  const resolvedRoot = path.resolve(rootPath);
  const resolved = path.resolve(resolvedRoot, ...segments);
  assert.equal(
    resolved.startsWith(`${resolvedRoot}${path.sep}`),
    true,
    `${label} must remain checkout-contained`,
  );
  return resolved;
}

function occurrences(text, literal) {
  return text.split(literal).length - 1;
}

test("pg_textsearch owns a content-addressed exact-pin Windows recipe", () => {
  assert.deepEqual(Object.keys(recipe).sort(), [
    "compiler_arguments",
    "data_files",
    "default_version",
    "export_contracts",
    "force_include_files",
    "layout_contracts",
    "local_include_directories",
    "patches",
    "schema",
    "source_commit",
    "sources",
    "sql_name",
    "version_defines",
  ]);
  assert.equal(recipe.schema, "oliphaunt-external-pgxs-windows-recipe-v1");
  assert.equal(recipe.sql_name, "pg_textsearch");
  assert.equal(recipe.source_commit, sourceManifest.commit);
  assert.equal(recipe.default_version, sourceManifest["extension-control"]["default-version"]);
  assert.match(recipe.source_commit, /^[0-9a-f]{40}$/u);
  assert.ok(recipe.sources.length > 0);
  assert.ok(recipe.data_files.length > 0);
  assert.ok(recipe.layout_contracts.length > 0);
  assert.ok(recipe.export_contracts.length > 0);
  assert.deepEqual(
    Object.fromEntries(
      recipe.layout_contracts
        .map((contract) => [contract.type, [contract.size, contract.alignment]])
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
    {
      TpCtidMapEntry: [6, 1],
      TpDictEntry: [16, 8],
      TpDictEntryV3: [12, 4],
      TpExpullEntry: [7, 1],
      TpSegmentPosting: [14, 1],
      TpSkipEntry: [20, 1],
      TpSkipEntryV3: [16, 1],
    },
  );

  for (const [property, base] of [
    ["sources", checkout],
    ["data_files", checkout],
    ["local_include_directories", checkout],
    ["force_include_files", checkout],
  ]) {
    assert.equal(new Set(recipe[property]).size, recipe[property].length, `${property} uniqueness`);
    for (const entry of recipe[property]) contained(base, entry, `${property} entry`);
  }
  for (const patch of recipe.patches) {
    assert.deepEqual(Object.keys(patch).sort(), ["path", "sha256"]);
    const patchPath = contained(productRoot, patch.path, "patch path");
    assert.equal(sha256(patchPath), patch.sha256, `${patch.path} digest`);
  }
  for (const contract of recipe.layout_contracts) {
    assert.deepEqual(Object.keys(contract).sort(), ["alignment", "path", "size", "type"]);
    contained(checkout, contract.path, "layout contract path");
  }
  for (const contract of recipe.export_contracts) {
    assert.deepEqual(Object.keys(contract).sort(), ["path", "symbols"]);
    contained(checkout, contract.path, "contract path");
  }
  for (const hostile of ["../outside.c", "/rooted.c", "C:\\rooted.c", "src//empty.c", "src/./dot.c"]) {
    assert.throws(() => contained(checkout, hostile, "hostile fixture"));
  }
});

test("shared producer consumes the generic recipe without pg_textsearch source rewriting", () => {
  const producer = readFileSync(producerPath, "utf8");
  assert.match(producer, /function Apply-ExternalPgxsWindowsRecipe\(/u);
  assert.match(producer, /git -C \$ExtensionDir apply --check --whitespace=error-all/u);
  assert.match(
    producer,
    /\$previousGitCeiling = \[Environment\]::GetEnvironmentVariable\(\s*"GIT_CEILING_DIRECTORIES",\s*\[EnvironmentVariableTarget\]::Process\s*\)/u,
  );
  assert.match(producer, /"GIT_CEILING_DIRECTORIES",\s*\$patchCeiling,\s*\[EnvironmentVariableTarget\]::Process/u);
  assert.match(
    producer,
    /finally\s*\{\s*\[Environment\]::SetEnvironmentVariable\(\s*"GIT_CEILING_DIRECTORIES",\s*\$previousGitCeiling,\s*\[EnvironmentVariableTarget\]::Process\s*\)\s*\}/u,
  );
  assert.match(producer, /external-windows-input:/u);
  assert.match(producer, /Resolve-ExternalWindowsRecipePath/u);
  assert.match(producer, /Add-ExternalPgxsMesonProducerFromWindowsRecipe/u);
  assert.doesNotMatch(producer, /function Patch-PgTextsearchWindows/u);
  assert.doesNotMatch(producer, /function Get-PgTextsearchMakefileList/u);
  assert.doesNotMatch(producer, /if \(\$SqlName -eq "pg_textsearch"\)/u);
  assert.doesNotMatch(producer, /Set-Content[^\n]+oliphaunt_windows_compat/u);
});

test(
  "the real recipe applies to a clean archive of the exact checkout",
  { skip: !existsSync(path.join(checkout, ".git")) && "exact pinned checkout is not materialized" },
  () => {
    const checkoutCommit = run("git", ["-C", checkout, "rev-parse", "HEAD"]);
    assert.equal(checkoutCommit, recipe.source_commit);
    assert.equal(
      run("git", ["-C", checkout, "status", "--porcelain=v1", "--untracked-files=all"]),
      "",
      "the canonical exact checkout must be clean before staging",
    );

    const scratch = mkdtempSync(path.join(tmpdir(), "oliphaunt-pg-textsearch-windows-"));
    const archive = path.join(scratch, "source.tar");
    const staged = path.join(scratch, "source");
    mkdirSync(staged);
    try {
      run("git", ["-C", scratch, "init", "-q"]);
      run("git", ["-C", checkout, "archive", "--format=tar", `--output=${archive}`, recipe.source_commit]);
      run("tar", ["-xf", archive, "-C", staged]);
      assert.equal(
        realpathSync(run("git", ["-C", staged, "rev-parse", "--show-toplevel"])),
        realpathSync(scratch),
        "fixture must reproduce an enclosing worktree around the staged source",
      );

      const control = readFileSync(path.join(staged, "pg_textsearch.control"), "utf8");
      const version = /^\s*default_version\s*=\s*'([^']+)'\s*$/mu.exec(control)?.[1];
      assert.equal(version, recipe.default_version);

      const patchEnvironment = { ...process.env, GIT_CEILING_DIRECTORIES: scratch };
      for (const patch of recipe.patches) {
        const patchPath = contained(productRoot, patch.path, "patch path");
        run(
          "git",
          ["-C", staged, "apply", "--check", "--whitespace=error-all", patchPath],
          { env: patchEnvironment },
        );
        run(
          "git",
          ["-C", staged, "apply", "--whitespace=error-all", patchPath],
          { env: patchEnvironment },
        );
      }

      for (const relativePath of [
        ...recipe.sources,
        ...recipe.data_files,
        ...recipe.force_include_files,
      ]) {
        assert.equal(existsSync(contained(staged, relativePath, "staged input")), true, relativePath);
      }

      for (const contract of recipe.layout_contracts) {
        const header = readFileSync(contained(staged, contract.path, "layout path"), "utf8");
        const declaration = `typedef struct ${contract.type}\n{`;
        const closing = `} ${contract.type};`;
        const push = `#pragma pack(push, ${contract.alignment})`;
        const pop = "#pragma pack(pop)";
        const size = `StaticAssertDecl(sizeof(${contract.type}) == ${contract.size},`;
        const alignment = `StaticAssertDecl(__alignof(${contract.type}) == ${contract.alignment},`;
        for (const marker of [declaration, closing, size, alignment]) {
          assert.equal(occurrences(header, marker), 1, `${contract.type} marker ${marker}`);
        }
        const declarationIndex = header.indexOf(declaration);
        const closingIndex = header.indexOf(closing, declarationIndex);
        const pushIndex = header.lastIndexOf(push, declarationIndex);
        const popIndex = header.indexOf(pop, closingIndex);
        assert.ok(pushIndex >= 0 && pushIndex < declarationIndex, `${contract.type} pack push`);
        assert.ok(declarationIndex < closingIndex, `${contract.type} declaration`);
        assert.ok(closingIndex < popIndex, `${contract.type} pack pop`);
        assert.ok(popIndex < header.indexOf(size), `${contract.type} size assertion`);
        assert.ok(header.indexOf(size) < header.indexOf(alignment), `${contract.type} alignment assertion`);
      }
      for (const headerPath of new Set(recipe.layout_contracts.map(({ path: value }) => value))) {
        const header = readFileSync(contained(staged, headerPath, "layout path"), "utf8");
        assert.equal(
          occurrences(header, "#pragma pack(push,"),
          occurrences(header, "#pragma pack(pop)"),
          `${headerPath} pack stack must remain balanced`,
        );
      }

      for (const contract of recipe.export_contracts) {
        const header = readFileSync(contained(staged, contract.path, "export path"), "utf8");
        for (const symbol of contract.symbols) {
          const declaration = `extern PGDLLEXPORT Datum ${symbol}(PG_FUNCTION_ARGS);`;
          assert.equal(occurrences(header, declaration), 1, `${symbol} export declaration`);
        }
      }

      const makeContract = run(
        "make",
        [
          "-s",
          "-C",
          staged,
          "-f",
          "Makefile",
          "--eval=.PHONY: oliphaunt-print-windows-contract\noliphaunt-print-windows-contract:\n\t@printf '%s\\n' 'OBJS=$(OBJS)' 'DATA=$(DATA)'",
          "oliphaunt-print-windows-contract",
        ],
        { env: { ...process.env, PG_CONFIG: "false" } },
      );
      const values = Object.fromEntries(
        makeContract.split("\n").map((line) => {
          const equals = line.indexOf("=");
          return [line.slice(0, equals), line.slice(equals + 1).trim().split(/\s+/u)];
        }),
      );
      assert.deepEqual(
        values.OBJS.map((object) => `${object.slice(0, -2)}.c`),
        recipe.sources,
        "recipe sources must equal GNU make's evaluation of the pinned OBJS contract",
      );
      assert.deepEqual(
        [...values.DATA, "pg_textsearch.control"],
        recipe.data_files,
        "recipe data files must equal GNU make's evaluation of the pinned DATA contract",
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);
