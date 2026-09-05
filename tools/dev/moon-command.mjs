import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PROTOTOOLS = new URL("../../.prototools", import.meta.url);
const PINNED_VERSION = readFileSync(PROTOTOOLS, "utf8").match(/^moon\s*=\s*"([^"]+)"/mu)?.[1];
const VERIFIED = new Set();

if (!PINNED_VERSION) throw new Error(".prototools does not pin Moon");

function cleanEnvironment(environment) {
  const clean = { ...environment };
  for (const name of Object.keys(clean)) {
    if (name.startsWith("PROTO_")) delete clean[name];
  }
  return clean;
}

/** Resolve and verify the repository-pinned Moon executable once per process. */
export function moonCommand(environment = process.env) {
  const command = environment.MOON_BIN || "moon";
  const key = `${command}\0${environment.PATH ?? ""}`;
  if (VERIFIED.has(key)) return command;

  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    env: cleanEnvironment(environment),
  });
  if (result.error) {
    throw new Error(`Moon ${PINNED_VERSION} is required, but ${command} failed to start: ${result.error.message}`);
  }
  const actual = result.stdout.trim().match(/^moon\s+([^\s]+)$/u)?.[1];
  if (result.status !== 0 || actual !== PINNED_VERSION) {
    throw new Error(`Moon ${PINNED_VERSION} is required, but ${command} reported ${actual ?? "an invalid version"}`);
  }
  VERIFIED.add(key);
  return command;
}

export function moonEnvironment(environment = process.env) {
  return cleanEnvironment(environment);
}
