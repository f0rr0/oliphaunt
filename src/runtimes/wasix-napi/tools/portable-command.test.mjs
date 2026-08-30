import { describe, expect, test } from "bun:test";

import { portableCommand } from "./portable-command.mjs";

describe("WASIX Node-API portable subprocess commands", () => {
  test("always invokes repository shell wrappers through bash", () => {
    expect(portableCommand("tools/dev/bun.sh", ["script.mjs"], { platform: "linux" })).toEqual({
      command: "bash",
      args: ["tools/dev/bun.sh", "script.mjs"],
    });
    expect(portableCommand("C:\\repo\\tools\\dev\\deno.sh", ["run"], { platform: "win32" })).toEqual({
      command: "bash",
      args: ["C:/repo/tools/dev/deno.sh", "run"],
    });
  });

  test("invokes Windows npm and pnpm command shims through ComSpec", () => {
    expect(
      portableCommand("pnpm", ["install", "--ignore-scripts"], {
        platform: "win32",
        comspec: "C:\\Windows\\System32\\cmd.exe",
      }),
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "pnpm.cmd", "install", "--ignore-scripts"],
    });
    expect(portableCommand("npm", ["exec"], { platform: "win32" })).toEqual({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "npm.cmd", "exec"],
    });
  });

  test("leaves native executables and Unix package managers unchanged", () => {
    expect(portableCommand("node", ["verify.mjs"], { platform: "win32" })).toEqual({
      command: "node",
      args: ["verify.mjs"],
    });
    expect(portableCommand("pnpm", ["pack"], { platform: "linux" })).toEqual({
      command: "pnpm",
      args: ["pack"],
    });
  });
});
