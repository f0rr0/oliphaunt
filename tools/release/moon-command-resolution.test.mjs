import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { moonCommand } from "../dev/moon-command.mjs";
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");
const CHECK = path.join(ROOT, "tools/release/check_release_please_config.mjs");
const roots = [];

async function fixture(name) {
  const root = await mkdtemp(path.join(tmpdir(), `oliphaunt-moon-command-${name}-`));
  roots.push(root);
  return root;
}

async function writeMoonStub(bin, script) {
  await mkdir(bin, { recursive: true });
  await writeFile(
    script,
    [
      'import { appendFileSync } from "node:fs";',
      'if (process.argv.slice(2).join(" ") !== "query projects") process.exit(41);',
      'appendFileSync(process.env.MOON_STUB_MARKER, "path-stub\\n");',
      'process.stdout.write(process.env.MOON_PROJECTS_JSON);',
      "",
    ].join("\n"),
  );
  if (process.platform === "win32") {
    await writeFile(
      path.join(bin, "moon.cmd"),
      `@echo off\r\n"%MOON_STUB_RUNTIME%" "%MOON_STUB_SCRIPT%" %*\r\n`,
    );
  } else {
    const launcher = path.join(bin, "moon");
    await writeFile(launcher, '#!/bin/sh\nexec "$MOON_STUB_RUNTIME" "$MOON_STUB_SCRIPT" "$@"\n');
    await chmod(launcher, 0o755);
  }
}

async function moonProjectsJson() {
  const config = JSON.parse(await readFile(path.join(ROOT, "release-please-config.json"), "utf8"));
  return JSON.stringify({
    projects: Object.entries(config.packages).map(([packagePath, packageConfig]) => ({
      id: packageConfig.component,
      config: {
        tags: ["release-product"],
        project: {
          metadata: {
            release: {
              component: packageConfig.component,
              packagePath,
            },
          },
        },
      },
    })),
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("Moon command resolution", () => {
  test("uses PATH by default and ignores poison home-directory installations", async () => {
    const root = await fixture("path");
    const home = path.join(root, "home");
    const bin = path.join(root, "bin");
    const script = path.join(root, "moon-stub.mjs");
    const marker = path.join(root, "moon.marker");
    await mkdir(path.join(home, ".proto", "bin"), { recursive: true });
    const poison = path.join(home, ".proto", "bin", "moon");
    await writeFile(poison, "#!/bin/sh\nexit 99\n");
    await chmod(poison, 0o755);
    await writeMoonStub(bin, script);

    const environment = {
      ...process.env,
      HOME: home,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      MOON_PROJECTS_JSON: await moonProjectsJson(),
      MOON_STUB_MARKER: marker,
      MOON_STUB_RUNTIME: process.execPath,
      MOON_STUB_SCRIPT: script,
    };
    delete environment.MOON_BIN;
    const result = spawnSync(process.execPath, [CHECK], {
      cwd: ROOT,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });

    expect(new TextDecoder().decode(result.stderr)).toBe("");
    expect(result.status).toBe(0);
    expect(await readFile(marker, "utf8")).toBe("path-stub\n");
  });

  test("honors an explicit MOON_BIN and reports a missing command cleanly", () => {
    expect(moonCommand({ MOON_BIN: "/verified/moon" })).toBe("/verified/moon");
    expect(moonCommand({})).toBe("moon");

    const missing = path.join(tmpdir(), `missing-moon-${randomUUID()}`);
    const result = spawnSync(process.execPath, [CHECK], {
      cwd: ROOT,
      env: { ...process.env, MOON_BIN: missing },
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(result.status).toBe(2);
    expect(new TextDecoder().decode(result.stderr)).toContain("moon query projects failed to start");
  });

  test("production resolvers do not consult mutable proto home paths", async () => {
    const files = [
      ".github/scripts/run-moon-targets.sh",
      ".github/scripts/select-affected-moon-targets.mjs",
      ".github/scripts/write-affected-moon-target-matrices.mjs",
      "tools/dev/moon-command.mjs",
      "tools/graph/affected.mjs",
      "tools/graph/cache-witness.mjs",
      "tools/graph/ci_plan.mjs",
      "tools/graph/graph.mjs",
      "tools/policy/moon.mjs",
      "tools/release/check_release_please_config.mjs",
      "tools/release/release-graph.mjs",
    ];
    for (const file of files) {
      const source = await readFile(path.join(ROOT, file), "utf8");
      expect(source).not.toMatch(/[.]proto[/\\](?:bin|shims)[/\\]moon/u);
    }
  });

  test("shared execution and repository interpretation policy are global Moon inputs", async () => {
    const config = Bun.YAML.parse(
      await readFile(path.join(ROOT, ".moon/tasks/inputs.yml"), "utf8"),
    );
    expect(config.implicitInputs).toContain("/.gitattributes");
    expect(config.implicitInputs).toContain("/.gitignore");
    expect(config.implicitInputs).toContain("/.prototools");
    expect(config.implicitInputs).toContain("/tools/dev/bun.sh");
    expect(config.implicitInputs).toContain("/tools/dev/capture-command-output.mjs");
    expect(config.implicitInputs).toContain("/tools/dev/moon-command.mjs");
    expect(config.implicitInputs).toContain("/tools/release/release-directory-safety.mjs");
    expect(config.implicitInputs).toContain("/tools/test/fd-backed-spawn-sync.mjs");
  });
});
