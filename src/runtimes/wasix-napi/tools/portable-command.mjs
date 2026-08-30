import path from "node:path";

const WINDOWS_PACKAGE_MANAGERS = new Set(["npm", "pnpm"]);

/** Resolve script and package-manager shims without asking Node to execute them directly. */
export function portableCommand(
  command,
  args,
  { platform = process.platform, comspec = process.env.ComSpec } = {},
) {
  if (path.extname(command).toLowerCase() === ".sh") {
    const script = platform === "win32" ? command.replaceAll("\\", "/") : command;
    return { command: "bash", args: [script, ...args] };
  }
  if (platform === "win32" && WINDOWS_PACKAGE_MANAGERS.has(command)) {
    return {
      command: comspec || "cmd.exe",
      args: ["/d", "/s", "/c", `${command}.cmd`, ...args],
    };
  }
  return { command, args };
}
