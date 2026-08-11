#!/usr/bin/env bun

import { readFileSync } from "node:fs";

const failures = [];
for await (const file of new Bun.Glob("tools/**/Cargo.toml").scan({ dot: true })) {
  const manifest = Bun.TOML.parse(readFileSync(file, "utf8"));
  if (manifest.package?.publish !== false) {
    failures.push(file);
  }
}

if (failures.length > 0) {
  console.error(`internal Rust tools must set package.publish = false:\n${failures.join("\n")}`);
  process.exit(1);
}

console.log("internal Rust tools are not publishable");
