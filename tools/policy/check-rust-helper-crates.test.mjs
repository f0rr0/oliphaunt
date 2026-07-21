import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const checker = path.join(import.meta.dir, "check-rust-helper-crates.mjs");
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function manifest(name) {
  return `[package]\nname = "${name}"\npublish = false\n\n[features]\ndefault = []\n`;
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "oliphaunt-rust-helper-inventory-"));
  roots.push(root);
  mkdirSync(path.join(root, "tools", "policy"), { recursive: true });
  mkdirSync(path.join(root, "tools", "tracked"), { recursive: true });
  mkdirSync(path.join(root, "tools", "untracked"), { recursive: true });
  mkdirSync(path.join(root, "tools", "ignored"), { recursive: true });
  writeFileSync(path.join(root, ".gitignore"), "tools/ignored/\n");
  writeFileSync(path.join(root, "tools", "tracked", "Cargo.toml"), manifest("tracked-helper"));
  writeFileSync(path.join(root, "tools", "untracked", "Cargo.toml"), manifest("untracked-helper"));
  writeFileSync(path.join(root, "tools", "ignored", "Cargo.toml"), manifest("ignored-helper"));
  const init = spawnSync("git", ["init", "--quiet"], { cwd: root, encoding: "utf8" });
  expect(init.status).toBe(0);
  const add = spawnSync("git", ["add", "tools/tracked/Cargo.toml"], { cwd: root, encoding: "utf8" });
  expect(add.status).toBe(0);
  return root;
}

function writeAllowlist(root, paths) {
  const rows = paths.map(
    (entry) =>
      `${entry}\tfixture\tkeep-rust-domain-tool\tkeeps the fixture Rust helper intentionally governed`,
  );
  writeFileSync(
    path.join(root, "tools", "policy", "rust-helper-crates.allowlist"),
    `${rows.join("\n")}\n`,
  );
}

function runChecker(root, ...args) {
  return spawnSync(process.execPath, [checker, ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

test("inventories non-ignored untracked Rust helpers before staging", () => {
  const root = fixture();
  writeAllowlist(root, ["tools/tracked/Cargo.toml", "tools/untracked/Cargo.toml"]);

  const result = runChecker(root, "--json");
  expect(result.status).toBe(0);
  const inventory = JSON.parse(result.stdout);
  expect(inventory.entries.map((entry) => entry.path)).toEqual([
    "tools/tracked/Cargo.toml",
    "tools/untracked/Cargo.toml",
  ]);
});

test("rejects an untracked Rust helper missing from the inventory", () => {
  const root = fixture();
  writeAllowlist(root, ["tools/tracked/Cargo.toml"]);

  const result = runChecker(root);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Rust helper crates missing from the intentional inventory");
  expect(result.stderr).toContain("tools/untracked/Cargo.toml");
});
