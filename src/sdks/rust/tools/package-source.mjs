#!/usr/bin/env node
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "../../../..");

function copy(source, destination) {
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

export function stageRustPackageSource(outputDir) {
  const destination = path.resolve(ROOT, outputDir);
  const relative = path.relative(ROOT, destination);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Rust package stage must stay inside the repository: ${outputDir}`);
  }

  rmSync(destination, { recursive: true, force: true });
  cpSync(path.join(ROOT, "src/sdks/rust"), destination, {
    recursive: true,
    filter: (source) => path.basename(source) !== "target",
  });
  rmSync(path.join(destination, "crates/oliphaunt-build"), { recursive: true, force: true });
  cpSync(path.join(ROOT, "src/shared/fixtures"), path.join(destination, "testdata"), {
    recursive: true,
    filter: (source) => path.basename(source) !== "moon.yml",
  });
  copy(
    path.join(ROOT, "src/shared/rust-query-core/query_core.rs"),
    path.join(destination, "src/query_core.rs"),
  );
  copy(path.join(ROOT, "LICENSE"), path.join(destination, "LICENSE"));
  copy(path.join(ROOT, "THIRD_PARTY_NOTICES.md"), path.join(destination, "THIRD_PARTY_NOTICES.md"));

  const manifest = path.join(destination, "Cargo.toml");
  let text = readFileSync(manifest, "utf8")
    .replace("repository.workspace = true", 'repository = "https://github.com/f0rr0/oliphaunt"')
    .replace("homepage.workspace = true", 'homepage = "https://oliphaunt.dev"');
  if (!text.includes("[workspace]")) text = `${text.trimEnd()}\n\n[workspace]\n`;
  writeFileSync(manifest, text, "utf8");
  return manifest;
}

if (import.meta.main) {
  const output = process.argv[2] ?? "target/liboliphaunt-sdk-check/oliphaunt-rust/package-source";
  console.log(path.relative(ROOT, stageRustPackageSource(output)));
}
