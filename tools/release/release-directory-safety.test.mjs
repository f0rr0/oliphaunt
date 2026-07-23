import assert from "node:assert/strict";
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  canonicalSystemDirectoryPath,
  requireSafeDirectoryChain,
} from "./release-directory-safety.mjs";

function directoryIdentity(device, inode) {
  return {
    dev: BigInt(device),
    ino: BigInt(inode),
    isDirectory: () => true,
  };
}

function symbolicLinkMetadata() {
  return {
    isDirectory: () => false,
    isSymbolicLink: () => true,
  };
}

test("canonicalizes only identity-matching Darwin root directory aliases", () => {
  const aliases = new Map([
    ["/etc", { canonical: "/private/etc", identity: directoryIdentity(1, 11) }],
    ["/tmp", { canonical: "/private/tmp", identity: directoryIdentity(1, 12) }],
    ["/var", { canonical: "/private/var", identity: directoryIdentity(1, 13) }],
  ]);
  const canonicalIdentities = new Map(
    [...aliases.values()].map(({ canonical, identity }) => [canonical, identity]),
  );
  const lstat = (file, options) => {
    assert.deepEqual(options, { bigint: true });
    if (!aliases.has(file)) throw Object.assign(new Error(`missing ${file}`), { code: "ENOENT" });
    return symbolicLinkMetadata();
  };
  const stat = (file, options) => {
    assert.deepEqual(options, { bigint: true });
    const identity = aliases.get(file)?.identity ?? canonicalIdentities.get(file);
    if (!identity) throw Object.assign(new Error(`missing ${file}`), { code: "ENOENT" });
    return identity;
  };

  assert.equal(
    canonicalSystemDirectoryPath("/var/folders/user/stage", {
      platform: "darwin",
      lstat,
      stat,
    }),
    "/private/var/folders/user/stage",
  );
  assert.equal(
    canonicalSystemDirectoryPath("/tmp/stage", { platform: "darwin", lstat, stat }),
    "/private/tmp/stage",
  );
  assert.equal(
    canonicalSystemDirectoryPath("/etc/oliphaunt", { platform: "darwin", lstat, stat }),
    "/private/etc/oliphaunt",
  );
  assert.equal(
    canonicalSystemDirectoryPath("/Users/runner/stage", {
      platform: "darwin",
      lstat: () => assert.fail("an unrecognized root path must not be inspected as an alias"),
      stat: () => assert.fail("an unrecognized root path must not be inspected as an alias"),
    }),
    "/Users/runner/stage",
  );
  assert.equal(
    canonicalSystemDirectoryPath("/var/folders/user/stage", {
      platform: "linux",
      lstat: () => assert.fail("non-Darwin paths must not inspect system aliases"),
      stat: () => assert.fail("non-Darwin paths must not inspect system aliases"),
    }),
    "/var/folders/user/stage",
  );

  const mismatchedStat = (file, options) => {
    if (file === "/var") return stat(file, options);
    if (file === "/private/var") return directoryIdentity(1, 99);
    throw Object.assign(new Error(`missing ${file}`), { code: "ENOENT" });
  };
  assert.equal(
    canonicalSystemDirectoryPath("/var/folders/user/stage", {
      platform: "darwin",
      lstat,
      stat: mismatchedStat,
    }),
    "/var/folders/user/stage",
  );
  assert.equal(
    canonicalSystemDirectoryPath("/var/folders/user/stage", {
      platform: "darwin",
      lstat: () => {
        throw Object.assign(new Error("unavailable"), { code: "EACCES" });
      },
      stat,
    }),
    "/var/folders/user/stage",
  );
  assert.equal(
    canonicalSystemDirectoryPath("/var/folders/user/stage", {
      platform: "darwin",
      lstat,
      stat: (file, options) => file === "/var"
        ? stat(file, options)
        : directoryIdentity(0, 0),
    }),
    "/var/folders/user/stage",
  );
});

test("creates only missing real suffixes and rejects caller-created aliases", (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "release-directory-safety-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const created = path.join(root, "created", "suffix");
  assert.equal(
    requireSafeDirectoryChain(created, { create: true, label: "shared test root" }),
    created,
  );
  assert.equal(lstatSync(created).isDirectory(), true);

  const missing = path.join(root, "missing", "suffix");
  assert.throws(
    () => requireSafeDirectoryChain(missing, { label: "shared test root" }),
    /cannot be inspected/u,
  );

  const outside = path.join(root, "outside");
  mkdirSync(outside);
  const alias = path.join(root, "alias");
  symlinkSync(outside, alias, process.platform === "win32" ? "junction" : "dir");
  assert.throws(
    () => requireSafeDirectoryChain(path.join(alias, "suffix"), {
      create: true,
      label: "shared test root",
    }),
    /symlink or non-directory ancestor/u,
  );
});

test("re-inspects created suffixes and rejects a changed canonical target", () => {
  const existing = new Set(["/", "/private", "/private/var"]);
  const inspections = new Map();
  const lstat = (file, options) => {
    if (options?.bigint === true && file === "/var") return symbolicLinkMetadata();
    inspections.set(file, (inspections.get(file) ?? 0) + 1);
    if (!existing.has(file)) throw Object.assign(new Error(`missing ${file}`), { code: "ENOENT" });
    return {
      isDirectory: () => true,
      isSymbolicLink: () => file === "/private/var" && inspections.get(file) > 1,
    };
  };
  const stat = () => directoryIdentity(1, 13);
  const mkdir = (file, options) => {
    assert.deepEqual(options, { mode: 0o755 });
    existing.add(file);
  };
  assert.equal(
    requireSafeDirectoryChain("/var/new/suffix", {
      create: true,
      label: "injected chain",
      platform: "darwin",
      lstat,
      stat,
      mkdir,
    }),
    "/private/var/new/suffix",
  );
  assert.equal(inspections.get("/private/var/new"), 2);
  assert.equal(inspections.get("/private/var/new/suffix"), 2);

  assert.throws(
    () => requireSafeDirectoryChain("/var/unsafe", {
      create: true,
      label: "injected chain",
      platform: "darwin",
      lstat,
      stat,
      mkdir,
    }),
    /symlink or non-directory ancestor/u,
  );
});

test("accepts the verified Darwin temporary-directory alias", {
  skip: process.platform !== "darwin",
}, (t) => {
  const raw = mkdtempSync(path.join(tmpdir(), "release-directory-safety-darwin-"));
  const canonical = realpathSync(raw);
  t.after(() => rmSync(canonical, { recursive: true, force: true }));
  assert.equal(requireSafeDirectoryChain(raw), canonical);
});
