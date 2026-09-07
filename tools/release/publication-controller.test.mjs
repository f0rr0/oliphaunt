import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "../test/fd-backed-spawn-sync.mjs";
import { assertPublicationController } from "./publication-controller.mjs";

test("only clean publication-only descendants can execute an older frozen candidate", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "publication-controller-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const write = (file, value) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), value);
  };
  const commit = () => { git("add", "."); git("commit", "-qm", "fixture"); return git("rev-parse", "HEAD"); };
  try {
    git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
    write("product", "original");
    const source = commit();
    assertPublicationController({ source, controller: source, root });
    write("tools/release/crates-io-bootstrap-capacity.mjs", "fixed publisher");
    const controller = commit();
    assert.deepEqual(assertPublicationController({ source, controller, root }), { source, controller });
    for (const file of ["product", "tools/release/package-extension-release-carriers.mjs", "Cargo.lock", ".github/workflows/ci.yml", "tools/release/moon.yml"]) {
      git("checkout", "--detach", controller);
      write(file, "changed");
      assert.throws(() => assertPublicationController({ source, controller, root }), /clean source checkout/u);
      const changed = commit();
      assert.throws(() => assertPublicationController({ source, controller: changed, root }), /non-publication changes/u);
    }
    git("checkout", "--detach", source);
    assert.throws(() => assertPublicationController({ source: controller, controller: source, root }), /ancestor/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
