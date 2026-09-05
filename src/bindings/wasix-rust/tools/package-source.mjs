#!/usr/bin/env node
import { cp, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "../../../..");

async function copy(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

export async function stageWasixRustPackageSource(outputDir) {
  const destination = path.resolve(ROOT, outputDir);
  const relative = path.relative(ROOT, destination);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`WASIX Rust package stage must stay inside the repository: ${outputDir}`);
  }

  await rm(destination, { recursive: true, force: true });
  await cp(
    path.join(ROOT, "src/bindings/wasix-rust/crates/oliphaunt-wasix"),
    destination,
    { recursive: true, filter: (source) => path.basename(source) !== "target" },
  );
  await cp(path.join(ROOT, "src/shared/fixtures"), path.join(destination, "src/testdata"), {
    recursive: true,
    filter: (source) => path.basename(source) !== "moon.yml",
  });
  await copy(
    path.join(ROOT, "src/shared/rust-query-core/query_core.rs"),
    path.join(destination, "src/oliphaunt/query_core.rs"),
  );
  await copy(
    path.join(ROOT, "src/sources/toolchains/wasix.toml"),
    path.join(destination, "src/testdata/wasix-toolchain.toml"),
  );
  await copy(path.join(ROOT, "LICENSE"), path.join(destination, "LICENSE"));
  await copy(
    path.join(ROOT, "THIRD_PARTY_NOTICES.md"),
    path.join(destination, "THIRD_PARTY_NOTICES.md"),
  );

  const manifest = path.join(destination, "Cargo.toml");
  const text = `${(await readFile(manifest, "utf8")).replace(
    /,\s*path\s*=\s*"[^"]+"/gu,
    "",
  ).trimEnd()}\n\n[workspace]\n`;
  await writeFile(manifest, text, "utf8");
  return manifest;
}

if (import.meta.main) {
  const output = process.argv[2] ?? "target/oliphaunt-wasix-rust/package/source";
  console.log(path.relative(ROOT, await stageWasixRustPackageSource(output)));
}
