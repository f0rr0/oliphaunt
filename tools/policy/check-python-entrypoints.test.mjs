import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const checker = path.join(import.meta.dir, "check-python-entrypoints.mjs");
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "oliphaunt-python-inventory-"));
  roots.push(root);
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(path.join(root, "tools", "policy"), { recursive: true });
  writeFileSync(path.join(root, ".gitignore"), "src/ignored.py\n");
  writeFileSync(path.join(root, "src", "tracked.py"), "print('tracked')\n");
  writeFileSync(path.join(root, "src", "untracked.py"), "print('untracked')\n");
  writeFileSync(path.join(root, "src", "ignored.py"), "print('ignored')\n");
  const init = spawnSync("git", ["init", "--quiet"], { cwd: root, encoding: "utf8" });
  expect(init.status).toBe(0);
  const add = spawnSync("git", ["add", "src/tracked.py"], { cwd: root, encoding: "utf8" });
  expect(add.status).toBe(0);
  return root;
}

function writeAllowlist(root, paths) {
  const rows = paths.map(
    (entry) =>
      `${entry}\tfixture\tretain-archive-validation\tkeeps the fixture Python entrypoint intentionally governed`,
  );
  writeFileSync(
    path.join(root, "tools", "policy", "python-entrypoints.allowlist"),
    `${rows.join("\n")}\n`,
  );
}

function runChecker(root, ...args) {
  return spawnSync(process.execPath, [checker, ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

test("inventories non-ignored untracked Python before staging", () => {
  const root = fixture();
  writeAllowlist(root, ["src/tracked.py", "src/untracked.py"]);

  const result = runChecker(root, "--json");
  expect(result.status).toBe(0);
  const inventory = JSON.parse(result.stdout);
  expect(inventory.entries.map((entry) => entry.path)).toEqual([
    "src/tracked.py",
    "src/untracked.py",
  ]);
});

test("rejects an untracked Python entrypoint missing from the inventory", () => {
  const root = fixture();
  writeAllowlist(root, ["src/tracked.py"]);

  const result = runChecker(root);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("tracked Python files missing from the intentional tooling inventory");
  expect(result.stderr).toContain("src/untracked.py");
});
