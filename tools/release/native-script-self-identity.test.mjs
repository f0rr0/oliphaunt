import { expect, test } from "bun:test";
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import path from "node:path";

import { ROOT } from "./release-graph.mjs";

const commonScript = path.join(
  ROOT,
  "src/runtimes/liboliphaunt/native/bin/common.sh",
);

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

});
