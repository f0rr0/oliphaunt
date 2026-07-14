import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  cargoPublishMetadataFromCrate,
  encodeCargoPublishRequest,
  publishFrozenCargoCrate,
} from "./frozen-cargo-publish.mjs";

const temporaryDirectories = [];

function cargoFixture({ pathDependency = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-frozen-cargo-"));
  temporaryDirectories.push(root);
  const packageRoot = path.join(root, "fixture-crate-1.2.3");
  mkdirSync(path.join(packageRoot, "src"), { recursive: true });
  writeFileSync(path.join(packageRoot, "README.md"), "# Frozen fixture\n");
  writeFileSync(path.join(packageRoot, "src/lib.rs"), "pub const FROZEN: bool = true;\n");
  writeFileSync(path.join(packageRoot, "Cargo.toml"), `[package]
name = "fixture-crate"
version = "1.2.3"
edition = "2024"
rust-version = "1.85"
authors = ["Oliphaunt Maintainers"]
description = "Frozen publication fixture"
documentation = "https://docs.rs/fixture-crate"
homepage = "https://oliphaunt.dev"
readme = "README.md"
keywords = ["postgres"]
categories = ["database"]
license = "MIT OR Apache-2.0"
repository = "https://github.com/f0rr0/oliphaunt"
links = "fixture_native"

[dependencies.serde_alias]
version = "1"
package = "serde"
features = ["derive"]
optional = true
default-features = false
${pathDependency ? "path = \"../serde\"" : ""}

[target.'cfg(unix)'.build-dependencies.cc]
version = "1.1"

[features]
default = ["serde_alias"]

[badges.maintenance]
status = "actively-developed"
`);
  const cratePath = path.join(root, "fixture-crate-1.2.3.crate");
  const result = spawnSync("tar", ["-czf", cratePath, "-C", root, "fixture-crate-1.2.3"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `tar exited ${result.status}`);
  }
  return cratePath;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

describe("frozen Cargo registry publication", () => {
  test("derives Cargo Publish API metadata from the packaged manifest", () => {
    const metadata = cargoPublishMetadataFromCrate(cargoFixture());
    expect(metadata).toMatchObject({
      name: "fixture-crate",
      vers: "1.2.3",
      authors: ["Oliphaunt Maintainers"],
      description: "Frozen publication fixture",
      readme: "# Frozen fixture\n",
      readme_file: "README.md",
      license: "MIT OR Apache-2.0",
      rust_version: "1.85",
      features: { default: ["serde_alias"] },
      badges: { maintenance: { status: "actively-developed" } },
    });
    expect(metadata.deps).toEqual([
      {
        optional: true,
        default_features: false,
        name: "serde",
        features: ["derive"],
        version_req: "1",
        target: null,
        kind: "normal",
        explicit_name_in_toml: "serde_alias",
      },
      {
        optional: false,
        default_features: true,
        name: "cc",
        features: [],
        version_req: "1.1",
        target: "cfg(unix)",
        kind: "build",
      },
    ]);
  });

  test("encodes and uploads the exact supplied crate bytes with the raw Cargo token", async () => {
    const cratePath = cargoFixture();
    const crateBytes = readFileSync(cratePath);
    let request = null;
    const result = await publishFrozenCargoCrate({
      cratePath,
      expectedName: "fixture-crate",
      expectedVersion: "1.2.3",
      token: "cargo-oidc-token",
      apiBase: "https://registry.invalid/api/v1/",
      fetchImpl: async (url, init) => {
        request = { url, init };
        return new Response(JSON.stringify({ warnings: { other: ["fixture warning"] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    expect(request.url).toBe("https://registry.invalid/api/v1/crates/new");
    const headers = new Headers(request.init.headers);
    expect(headers.get("authorization")).toBe("cargo-oidc-token");
    expect(headers.get("content-type")).toBe("application/octet-stream");
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("user-agent")).toContain("oliphaunt-frozen-publisher");
    const body = Buffer.from(request.init.body);
    const jsonLength = body.readUInt32LE(0);
    const metadata = JSON.parse(body.subarray(4, 4 + jsonLength).toString("utf8"));
    const crateLengthOffset = 4 + jsonLength;
    const crateLength = body.readUInt32LE(crateLengthOffset);
    expect(metadata.name).toBe("fixture-crate");
    expect(crateLength).toBe(crateBytes.length);
    expect(body.subarray(crateLengthOffset + 4)).toEqual(crateBytes);
    expect(result.warnings.other).toEqual(["fixture warning"]);
  });

  test("rejects non-registry dependency sources and identity substitutions", async () => {
    expect(() => cargoPublishMetadataFromCrate(cargoFixture({ pathDependency: true }))).toThrow(
      "forbidden path",
    );
    await expect(publishFrozenCargoCrate({
      cratePath: cargoFixture(),
      expectedName: "substituted-name",
      expectedVersion: "1.2.3",
      token: "token",
      fetchImpl: () => {
        throw new Error("must not be called");
      },
    })).rejects.toThrow("expected substituted-name@1.2.3");
  });

  test("treats Cargo API errors as failure even with HTTP 200", async () => {
    await expect(publishFrozenCargoCrate({
      cratePath: cargoFixture(),
      expectedName: "fixture-crate",
      expectedVersion: "1.2.3",
      token: "token",
      fetchImpl: async () => Response.json({ errors: [{ detail: "identity is not authorized" }] }, { status: 200 }),
    })).rejects.toThrow("identity is not authorized");
  });

  test("honors crates.io Retry-After and replays only the exact frozen bytes after HTTP 429", async () => {
    const cratePath = cargoFixture();
    const requests = [];
    const sleeps = [];
    let now = Date.parse("Wed, 21 Oct 2015 07:27:00 GMT");
    const result = await publishFrozenCargoCrate({
      cratePath,
      expectedName: "fixture-crate",
      expectedVersion: "1.2.3",
      token: "token",
      deadlineEpochMs: now + 700_000,
      nowImpl: () => now,
      sleepImpl: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
      fetchImpl: async (_url, init) => {
        requests.push(Buffer.from(init.body));
        if (requests.length === 1) {
          return Response.json(
            { errors: [{ detail: "new-crate bucket empty" }] },
            {
              status: 429,
              headers: { "Retry-After": "Wed, 21 Oct 2015 07:37:00 GMT" },
            },
          );
        }
        return Response.json({ warnings: {} });
      },
    });

    expect(sleeps).toEqual([602_000]);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(result.warnings).toEqual({ invalid_categories: [], invalid_badges: [], other: [] });
  });

  test("does not guess a rate-limit delay or wait beyond the mutation deadline", async () => {
    const request = (headers = {}) => publishFrozenCargoCrate({
      cratePath: cargoFixture(),
      expectedName: "fixture-crate",
      expectedVersion: "1.2.3",
      token: "token",
      nowImpl: () => 1_000_000,
      deadlineEpochMs: 1_500_000,
      sleepImpl: async () => {
        throw new Error("must not sleep");
      },
      fetchImpl: async () => Response.json({ errors: [{ detail: "limited" }] }, { status: 429, headers }),
    });

    await expect(request()).rejects.toThrow("without a valid Retry-After");
    await expect(request({ "Retry-After": "600" })).rejects.toThrow("cannot clear before the bounded registry mutation deadline");
  });

  test("rejects malformed success warning shapes", async () => {
    await expect(publishFrozenCargoCrate({
      cratePath: cargoFixture(),
      expectedName: "fixture-crate",
      expectedVersion: "1.2.3",
      token: "token",
      fetchImpl: async () => Response.json({ warnings: { other: "not-a-list" } }),
    })).rejects.toThrow("warnings.other must be a string list");
  });

  test("rejects an oversized registry response before parsing diagnostics", async () => {
    await expect(publishFrozenCargoCrate({
      cratePath: cargoFixture(),
      expectedName: "fixture-crate",
      expectedVersion: "1.2.3",
      token: "token",
      fetchImpl: async () => new Response("x".repeat(64 * 1024 + 1), {
        status: 502,
        headers: { "Content-Type": "text/plain" },
      }),
    })).rejects.toThrow("registry response for fixture-crate@1.2.3 exceeds 65536 bytes");
  });

  test("encodes protocol lengths independently from caller buffers", () => {
    const body = encodeCargoPublishRequest({ name: "x" }, Buffer.from([1, 2, 3]));
    const jsonLength = body.readUInt32LE(0);
    expect(JSON.parse(body.subarray(4, 4 + jsonLength).toString("utf8"))).toEqual({ name: "x" });
    expect(body.readUInt32LE(4 + jsonLength)).toBe(3);
    expect([...body.subarray(8 + jsonLength)]).toEqual([1, 2, 3]);
  });
});
