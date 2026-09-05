import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { materializeReleaseSymlinks } from "./materialize-release-symlinks.mjs";

const roots = [];

async function fixture(name) {
  const root = await mkdtemp(path.join(tmpdir(), `oliphaunt-materialize-${name}-`));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("release symlink materialization", () => {
  test("materializes contained versioned library aliases as regular files", async () => {
    const root = await fixture("aliases");
    const lib = path.join(root, "runtime", "lib");
    await mkdir(lib, { recursive: true });
    const versioned = path.join(lib, "libexample.so.3.1");
    await writeFile(versioned, "verified-library-bytes\n");
    await chmod(versioned, 0o555);
    await symlink("libexample.so.3.1", path.join(lib, "libexample.so.3"));
    await symlink("libexample.so.3", path.join(lib, "libexample.so"));
    await symlink("libexample.so.3.1", path.join(lib, "libexample.dylib"));

    expect(await materializeReleaseSymlinks(root)).toBe(3);
    for (const name of ["libexample.so.3", "libexample.so", "libexample.dylib"]) {
      const file = path.join(lib, name);
      const stat = await lstat(file);
      expect(stat.isFile()).toBe(true);
      expect(stat.isSymbolicLink()).toBe(false);
      expect(stat.mode & 0o777).toBe(0o555);
      expect(await readFile(file, "utf8")).toBe("verified-library-bytes\n");
    }
  });

  test("validates the complete tree before replacing any link", async () => {
    const root = await fixture("transaction");
    const outside = await fixture("outside");
    await writeFile(path.join(root, "library.so.1"), "library\n");
    await writeFile(path.join(outside, "escape.so"), "escape\n");
    const valid = path.join(root, "library.so");
    const escape = path.join(root, "escape.so");
    await symlink("library.so.1", valid);
    await symlink(path.relative(root, path.join(outside, "escape.so")), escape);

    await expect(materializeReleaseSymlinks(root)).rejects.toThrow(/escapes the staged release tree/u);
    expect((await lstat(valid)).isSymbolicLink()).toBe(true);
    expect((await lstat(escape)).isSymbolicLink()).toBe(true);
  });

  test("rejects absolute, broken, directory, cyclic, and symlink-root inputs", async () => {
    const absoluteRoot = await fixture("absolute");
    await writeFile(path.join(absoluteRoot, "real.so"), "library\n");
    await symlink(path.join(absoluteRoot, "real.so"), path.join(absoluteRoot, "absolute.so"));
    await expect(materializeReleaseSymlinks(absoluteRoot)).rejects.toThrow(/only relative/u);

    const brokenRoot = await fixture("broken");
    await symlink("missing.so", path.join(brokenRoot, "broken.so"));
    await expect(materializeReleaseSymlinks(brokenRoot)).rejects.toThrow(/broken symbolic-link target/u);

    const directoryRoot = await fixture("directory");
    await mkdir(path.join(directoryRoot, "real-directory"));
    await symlink("real-directory", path.join(directoryRoot, "directory-link"));
    await expect(materializeReleaseSymlinks(directoryRoot)).rejects.toThrow(/regular file/u);

    const cycleRoot = await fixture("cycle");
    await symlink("second.so", path.join(cycleRoot, "first.so"));
    await symlink("first.so", path.join(cycleRoot, "second.so"));
    await expect(materializeReleaseSymlinks(cycleRoot)).rejects.toThrow(/cycle/u);

    const targetRoot = await fixture("root-target");
    const linkedRoot = `${targetRoot}-link`;
    roots.push(linkedRoot);
    await symlink(targetRoot, linkedRoot);
    await expect(materializeReleaseSymlinks(linkedRoot)).rejects.toThrow(/root must be a real directory/u);
  });

});
