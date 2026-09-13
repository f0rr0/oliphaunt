import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createDeterministicTar } from "../../src/shared/artifact-packaging/archive-directory.mjs";
import { canonicalGzipSync, readPortableArchiveEntries } from "../../src/shared/artifact-packaging/portable-archive.mjs";
import { stageReleaseNotices } from "./release-notices.mjs";
import { NATIVE_CLUSTER_SEED_TARGETS, validateNativeClusterSeedDirectory } from "./native-cluster-seed-contract.mjs";

export function nativeIcuSeedAsset(version, target) {
  if (!NATIVE_CLUSTER_SEED_TARGETS.includes(target)) throw new Error(`unsupported ICU seed target ${target}`);
  return `liboliphaunt-${version}-icu-seed-${target}.tar.gz`;
}

export async function splitNativeIcuSeed(root, icuData, target, output) {
  const seed = path.join(root, "cluster-seed-icu");
  validateNativeClusterSeedDirectory(seed, "icu", { target, icuData });
  stageReleaseNotices(seed, { profile: "native-runtime-resources" });
  const bytes = canonicalGzipSync(await createDeterministicTar(seed));
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(`${output}.partial`, bytes);
  renameSync(`${output}.partial`, output);
  rmSync(seed, { recursive: true });
  const report = path.join(root, "package-size.tsv");
  if (existsSync(report)) {
    const rows = readFileSync(report, "utf8").split("\n");
    const removed = Number(rows.find(row => row.startsWith("package\tcluster-seed-icu\t"))?.split("\t")[4] ?? 0);
    writeFileSync(report, rows.map(row => {
      const fields = row.split("\t");
      if (fields[0] === "package" && fields[1] === "cluster-seed-icu") fields[4] = "0";
      if (fields[0] === "package" && fields[1] === "total") fields[4] = String(Number(fields[4]) - removed);
      return fields.join("\t");
    }).join("\n"));
  }
}

export function stageNativeIcuSeeds(assetDir, version, destination, icuData, targets = NATIVE_CLUSTER_SEED_TARGETS) {
  for (const target of targets) {
    const archive = path.join(assetDir, nativeIcuSeedAsset(version, target));
    const seed = path.join(destination, target);
    rmSync(seed, { recursive: true, force: true });
    mkdirSync(seed, { recursive: true });
    for (const entry of readPortableArchiveEntries(archive).values()) {
      const file = path.join(seed, entry.name);
      if (entry.isDirectory) mkdirSync(file, { recursive: true });
      else {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, entry.data());
      }
    }
    validateNativeClusterSeedDirectory(seed, "icu", { target, icuData });
  }
}

export async function stageNativeIcuArchive(assetDir, version, destination, targets) {
  const stage = `${destination}.stage`;
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  try {
    const source = path.join(assetDir, `liboliphaunt-${version}-icu-data.tar.gz`);
    for (const entry of readPortableArchiveEntries(source).values()) {
      const file = path.join(stage, entry.name);
      if (entry.isDirectory) mkdirSync(file, { recursive: true });
      else {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, entry.data());
      }
    }
    stageNativeIcuSeeds(assetDir, version, path.join(stage, "native-seeds"), path.join(stage, "share/icu"), targets);
    writeFileSync(destination, canonicalGzipSync(await createDeterministicTar(stage)));
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [root, icuData, target, output, ...extra] = process.argv.slice(2);
  if (!output || extra.length) throw new Error("usage: native-icu-seeds.mjs ROOT ICU_DATA TARGET OUTPUT.tar.gz");
  await splitNativeIcuSeed(root, icuData, target, output);
}
