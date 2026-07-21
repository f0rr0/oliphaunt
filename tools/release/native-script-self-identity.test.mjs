import { expect, test } from "bun:test";
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";

import { ROOT } from "./release-graph.mjs";

const selfHashingScripts = [
  {
    path: "src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh",
    selfHashCount: 3,
  },
  {
    path: "src/runtimes/liboliphaunt/native/bin/build-macos-extension-archives.sh",
    selfHashCount: 1,
  },
];
const commonScript = path.join(
  ROOT,
  "src/runtimes/liboliphaunt/native/bin/common.sh",
);

test("native build self-identities remain valid after a working-directory change", () => {
  for (const script of selfHashingScripts) {
    const source = readFileSync(path.join(ROOT, script.path), "utf8");
    expect(source).toContain(
      'script_path="$script_dir/$(basename "${BASH_SOURCE[0]}")"',
    );
    expect(
      source
        .split("\n")
        .filter((line) => line.includes("shasum") && line.includes("BASH_SOURCE[0]")),
    ).toEqual([]);
    expect(source.match(/shasum -a 256 "\$script_path"/gu) ?? []).toHaveLength(
      script.selfHashCount,
    );
  }
});

test("native extension identities use the canonical generated source checkout mapping", () => {
  for (const [extension, expected] of [
    ["pg_hashids", "target/oliphaunt-sources/checkouts/pg_hashids"],
    ["vector", "target/oliphaunt-sources/checkouts/pgvector"],
    ["pgvector", "target/oliphaunt-sources/checkouts/pgvector"],
    ["postgis", "target/oliphaunt-sources/checkouts/postgis"],
  ]) {
    const result = spawnSync(
      "sh",
      [
        "-c",
        '. "$1"; oliphaunt_native_external_extension_source_rel "$2" "$3"',
        "native-extension-source-map-test",
        commonScript,
        ROOT,
        extension,
      ],
      { encoding: "utf8", cwd: path.dirname(ROOT) },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(expected);
  }

  const unknown = spawnSync(
    "sh",
    [
      "-c",
      '. "$1"; oliphaunt_native_external_extension_source_rel "$2" "$3"',
      "native-extension-source-map-test",
      commonScript,
      ROOT,
      "unknown-extension",
    ],
    { encoding: "utf8", cwd: path.dirname(ROOT) },
  );
  expect(unknown.status).not.toBe(0);
  expect(unknown.stdout).toBe("");

  for (const script of [
    "src/runtimes/liboliphaunt/native/bin/build-postgres18-linux.sh",
    "src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh",
  ]) {
    const source = readFileSync(path.join(ROOT, script), "utf8");
    expect(source).toContain(
      'source_rel="$(oliphaunt_native_external_extension_source_rel "$repo_root" "$extension" || true)"',
    );
    expect(source).not.toContain(
      'extension_checkout="$repo_root/target/oliphaunt-sources/checkouts/$extension"',
    );
  }
});
