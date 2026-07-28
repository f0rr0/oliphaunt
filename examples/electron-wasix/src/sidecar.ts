import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

export type WasixSidecar = {
  databaseUrl: string;
  process: ChildProcess;
};

export async function startWasixSidecar(root: string): Promise<WasixSidecar> {
  const configured = process.env.OLIPHAUNT_WASIX_TODO_SIDECAR;
  const command = configured || "cargo";
  const args = configured
    ? ["--root", root]
    : [
        "run",
        "--quiet",
        "--manifest-path",
        join(process.cwd(), "src-wasix/Cargo.toml"),
        "--",
        "--root",
        root,
      ];
  if (configured && !existsSync(configured)) {
    throw new Error(`OLIPHAUNT_WASIX_TODO_SIDECAR does not exist: ${configured}`);
  }

  const child = spawn(command, args, {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
  });

  const lines = createInterface({ input: child.stdout });
  const firstLine = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for WASIX sidecar")), 60_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`WASIX sidecar exited before ready: ${code ?? "signal"}`));
    });
    lines.once("line", (line) => {
      clearTimeout(timer);
      resolve(line);
    });
  });
  const payload = JSON.parse(firstLine) as { databaseUrl?: string };
  if (!payload.databaseUrl) throw new Error("WASIX sidecar did not print databaseUrl");
  return {
    databaseUrl: payload.databaseUrl,
    process: child,
  };
}
