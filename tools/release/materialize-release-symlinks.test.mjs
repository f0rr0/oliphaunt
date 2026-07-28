import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { materializeReleaseSymlinks } from "./materialize-release-symlinks.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");
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

  test("all Unix native release packagers validate a link-free stage", async () => {
    const coreScripts = [
      "tools/release/package-liboliphaunt-linux-assets.sh",
      "tools/release/package-liboliphaunt-macos-assets.sh",
    ];
    for (const script of coreScripts) {
      const source = await readFile(path.join(ROOT, script), "utf8");
      const materialize = source.indexOf("materialize-release-symlinks.mjs \"$stage\"");
      const contract = source.indexOf("platform-binary-contract.mjs --target \"$target_id\" --root \"$stage\"");
      expect(materialize).toBeGreaterThan(-1);
      expect(contract).toBeGreaterThan(materialize);
    }

    const extensionScript = await readFile(
      path.join(ROOT, "src/extensions/artifacts/native/tools/package-release-assets.sh"),
      "utf8",
    );
    const copy = extensionScript.indexOf('rsync -a --delete "$source_runtime/" "$staged_runtime/"');
    const materialize = extensionScript.indexOf(
      'materialize-release-symlinks.mjs "$staged_runtime"',
    );
    const prepare = extensionScript.indexOf(
      'runtime="$(prepare_extension_release_runtime "$source_runtime")"',
    );
    const contract = extensionScript.indexOf(
      'platform-binary-contract.mjs --target "$target_id" --root "$runtime"',
    );
    expect(copy).toBeGreaterThan(-1);
    expect(materialize).toBeGreaterThan(copy);
    expect(prepare).toBeGreaterThan(materialize);
    expect(contract).toBeGreaterThan(prepare);
  });

  test("the materializer is an explicit input of every native release task", async () => {
    const input = "/tools/release/materialize-release-symlinks.mjs";
    const extensionConfig = Bun.YAML.parse(
      await readFile(path.join(ROOT, "src/extensions/artifacts/native/moon.yml"), "utf8"),
    );
    expect(extensionConfig.tasks["release-check"].inputs).toContain(input);
    expect(extensionConfig.tasks["build-target"].inputs).toContain(input);

    const runtimeConfig = Bun.YAML.parse(
      await readFile(path.join(ROOT, "src/runtimes/liboliphaunt/native/moon.yml"), "utf8"),
    );
    expect(runtimeConfig.tasks["release-runtime"].inputs).toContain(input);
    expect(runtimeConfig.tasks["release-runtime-desktop"].inputs).toContain(input);
  });

  test("desktop release tasks track every OS-specific post-build packager", async () => {
    const config = Bun.YAML.parse(
      await readFile(path.join(ROOT, "src/runtimes/liboliphaunt/native/moon.yml"), "utf8"),
    );
    const packagers = [
      "/tools/release/package-liboliphaunt-linux-assets.sh",
      "/tools/release/package-liboliphaunt-macos-assets.sh",
      "/tools/release/package-liboliphaunt-windows-assets.ps1",
    ];
    for (const task of ["release-runtime", "release-runtime-desktop"]) {
      for (const packager of packagers) {
        expect(config.tasks[task].inputs).toContain(packager);
      }
    }
  });
});
