import { afterEach, expect, test } from "bun:test";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DENO_EMBEDDED_MODULE_DIRECTORY,
  stageDenoModuleDirectory,
  stageDenoPreparedRuntime,
} from "./fixtures/js-exact-candidate-prepare-deno-runtime.mjs";

const scratch = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "oliphaunt-deno-runtime-merge-"));
  scratch.push(root);
  const source = path.join(root, "embedded-modules");
  const runtime = path.join(root, "runtime");
  const canonicalModules = path.join(runtime, "lib", "postgresql");
  const destination = path.join(runtime, ...DENO_EMBEDDED_MODULE_DIRECTORY.split("/"));
  await mkdir(source, { recursive: true });
  await mkdir(canonicalModules, { recursive: true });
  return { root, source, runtime, canonicalModules, destination };
}

test("Deno runtime staging separates embedded modules from canonical subprocess modules", async () => {
  const { source, canonicalModules, destination } = await fixture();
  await writeFile(path.join(canonicalModules, "plpgsql.so"), "canonical initdb plpgsql\n");
  await writeFile(path.join(canonicalModules, "hstore.so"), "canonical hstore\n");
  await writeFile(path.join(source, "plpgsql.so"), "embedded-linked plpgsql\n");
  await writeFile(path.join(source, "hstore.so"), "embedded hstore\n");
  await writeFile(path.join(source, "vector.so"), "selected external module\n");

  const result = await stageDenoModuleDirectory(source, destination);

  expect(await readFile(path.join(canonicalModules, "plpgsql.so"), "utf8")).toBe(
    "canonical initdb plpgsql\n",
  );
  expect(await readFile(path.join(canonicalModules, "hstore.so"), "utf8")).toBe(
    "canonical hstore\n",
  );
  expect(await readFile(path.join(destination, "plpgsql.so"), "utf8")).toBe(
    "embedded-linked plpgsql\n",
  );
  expect(await readFile(path.join(destination, "hstore.so"), "utf8")).toBe(
    "embedded hstore\n",
  );
  expect(await readFile(path.join(destination, "vector.so"), "utf8")).toBe(
    "selected external module\n",
  );
  expect(result).toEqual({
    copiedFiles: ["hstore.so", "plpgsql.so", "vector.so"],
  });
});

test("Deno runtime staging rejects links and a preexisting reserved destination", async () => {
  const linked = await fixture();
  await writeFile(path.join(linked.root, "module.so"), "module\n");
  await symlink(path.join(linked.root, "module.so"), path.join(linked.source, "linked.so"));
  await expect(stageDenoModuleDirectory(linked.source, linked.destination)).rejects.toThrow(
    "must contain only files and directories",
  );

  const collided = await fixture();
  await mkdir(collided.destination);
  await expect(stageDenoModuleDirectory(collided.source, collided.destination)).rejects.toThrow(
    "destination must not already exist",
  );
});

test("Deno prepared runtime reserves lib/modules for separately materialized module bytes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "oliphaunt-deno-prepared-runtime-"));
  scratch.push(root);
  const runtimeSource = path.join(root, "release-shaped-runtime");
  const runtimeModules = path.join(runtimeSource, ...DENO_EMBEDDED_MODULE_DIRECTORY.split("/"));
  const canonicalModules = path.join(runtimeSource, "lib", "postgresql");
  const separateModules = path.join(root, "separate-embedded-modules");
  const destination = path.join(root, "prepared", "deno-runtime");
  await mkdir(runtimeModules, { recursive: true });
  await mkdir(canonicalModules, { recursive: true });
  await mkdir(separateModules, { recursive: true });
  await mkdir(path.join(runtimeSource, "share", "postgresql", "extension"), { recursive: true });
  await writeFile(path.join(runtimeSource, "share", "postgresql", "extension", "vector.control"), "runtime control\n");
  await writeFile(path.join(canonicalModules, "plpgsql.so"), "canonical subprocess module\n");
  await writeFile(path.join(runtimeModules, "runtime-only.so"), "must be excluded\n");
  await writeFile(path.join(runtimeModules, "vector.so"), "runtime copy\n");
  await writeFile(path.join(separateModules, "vector.so"), "separately materialized\n");
  await writeFile(path.join(separateModules, "hstore.so"), "separate hstore\n");

  const result = await stageDenoPreparedRuntime(
    runtimeSource,
    separateModules,
    destination,
  );
  const destinationModules = path.join(
    destination,
    ...DENO_EMBEDDED_MODULE_DIRECTORY.split("/"),
  );

  expect(await readFile(
    path.join(destination, "share", "postgresql", "extension", "vector.control"),
    "utf8",
  )).toBe("runtime control\n");
  expect(await readFile(path.join(destination, "lib", "postgresql", "plpgsql.so"), "utf8")).toBe(
    "canonical subprocess module\n",
  );
  expect(await readFile(path.join(destinationModules, "vector.so"), "utf8")).toBe(
    "separately materialized\n",
  );
  expect(await readFile(path.join(destinationModules, "hstore.so"), "utf8")).toBe(
    "separate hstore\n",
  );
  await expect(access(path.join(destinationModules, "runtime-only.so"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(result).toEqual({
    moduleDirectory: destinationModules,
    moduleStaging: {
      copiedFiles: ["hstore.so", "vector.so"],
    },
    runtimeStaging: {
      copiedFiles: [
        "lib/postgresql/plpgsql.so",
        "share/postgresql/extension/vector.control",
      ],
      excludedModuleDirectory: DENO_EMBEDDED_MODULE_DIRECTORY,
    },
  });
});

test("Deno prepared runtime fails closed on reserved-path and runtime-tree aliases", async () => {
  async function prepareCase(name) {
    const root = await mkdtemp(path.join(tmpdir(), `oliphaunt-deno-runtime-${name}-`));
    scratch.push(root);
    const runtimeSource = path.join(root, "runtime");
    const separateModules = path.join(root, "separate-modules");
    const destination = path.join(root, "output");
    await mkdir(path.join(runtimeSource, "lib"), { recursive: true });
    await mkdir(separateModules);
    await writeFile(path.join(separateModules, "vector.so"), "separate module\n");
    return { root, runtimeSource, separateModules, destination };
  }

  const reservedFile = await prepareCase("reserved-file");
  await writeFile(
    path.join(reservedFile.runtimeSource, ...DENO_EMBEDDED_MODULE_DIRECTORY.split("/")),
    "not a directory\n",
  );
  await expect(stageDenoPreparedRuntime(
    reservedFile.runtimeSource,
    reservedFile.separateModules,
    reservedFile.destination,
  )).rejects.toThrow("reserved module path must be a directory");

  const reservedLink = await prepareCase("reserved-link");
  const linkedModules = path.join(reservedLink.root, "linked-modules");
  await mkdir(linkedModules);
  await symlink(
    linkedModules,
    path.join(reservedLink.runtimeSource, ...DENO_EMBEDDED_MODULE_DIRECTORY.split("/")),
  );
  await expect(stageDenoPreparedRuntime(
    reservedLink.runtimeSource,
    reservedLink.separateModules,
    reservedLink.destination,
  )).rejects.toThrow("reserved module path must be a directory");

  const runtimeLink = await prepareCase("runtime-link");
  const linkedFile = path.join(runtimeLink.root, "linked-control");
  await writeFile(linkedFile, "control\n");
  await symlink(linkedFile, path.join(runtimeLink.runtimeSource, "linked.control"));
  await expect(stageDenoPreparedRuntime(
    runtimeLink.runtimeSource,
    runtimeLink.separateModules,
    runtimeLink.destination,
  )).rejects.toThrow("must contain only files and directories");

  const collided = await prepareCase("destination-collision");
  await mkdir(collided.destination);
  await expect(stageDenoPreparedRuntime(
    collided.runtimeSource,
    collided.separateModules,
    collided.destination,
  )).rejects.toThrow("destination must not already exist");
});

test("Deno prepared runtime rejects source and destination overlap before writing", async () => {
  async function prepareCase(name) {
    const root = await mkdtemp(path.join(tmpdir(), `oliphaunt-deno-overlap-${name}-`));
    scratch.push(root);
    const runtimeSource = path.join(root, "runtime");
    const moduleSource = path.join(root, "modules");
    await mkdir(runtimeSource, { recursive: true });
    await mkdir(moduleSource, { recursive: true });
    await writeFile(path.join(runtimeSource, "runtime-marker"), "runtime\n");
    await writeFile(path.join(moduleSource, "module-marker"), "module\n");
    return { root, runtimeSource, moduleSource };
  }

  const destinationInsideRuntime = await prepareCase("destination-inside-runtime");
  const nestedRuntimeDestination = path.join(
    destinationInsideRuntime.runtimeSource,
    "prepared",
    "deno-runtime",
  );
  await expect(stageDenoPreparedRuntime(
    destinationInsideRuntime.runtimeSource,
    destinationInsideRuntime.moduleSource,
    nestedRuntimeDestination,
  )).rejects.toThrow("destination must not overlap runtime source");
  await expect(access(nestedRuntimeDestination)).rejects.toMatchObject({ code: "ENOENT" });

  const runtimeInsideDestination = await prepareCase("runtime-inside-destination");
  const runtimeParentDestination = path.dirname(runtimeInsideDestination.runtimeSource);
  await expect(stageDenoPreparedRuntime(
    runtimeInsideDestination.runtimeSource,
    runtimeInsideDestination.moduleSource,
    runtimeParentDestination,
  )).rejects.toThrow("destination must not overlap runtime source");
  expect(await readFile(path.join(runtimeInsideDestination.runtimeSource, "runtime-marker"), "utf8"))
    .toBe("runtime\n");

  const destinationInsideModules = await prepareCase("destination-inside-modules");
  const nestedModuleDestination = path.join(
    destinationInsideModules.moduleSource,
    "prepared",
    "deno-runtime",
  );
  await expect(stageDenoPreparedRuntime(
    destinationInsideModules.runtimeSource,
    destinationInsideModules.moduleSource,
    nestedModuleDestination,
  )).rejects.toThrow("destination must not overlap module source");
  await expect(access(nestedModuleDestination)).rejects.toMatchObject({ code: "ENOENT" });

  const modulesInsideDestination = await prepareCase("modules-inside-destination");
  const externalRuntime = await prepareCase("modules-inside-destination-external-runtime");
  const moduleParentDestination = path.dirname(modulesInsideDestination.moduleSource);
  await expect(stageDenoPreparedRuntime(
    externalRuntime.runtimeSource,
    modulesInsideDestination.moduleSource,
    moduleParentDestination,
  )).rejects.toThrow("destination must not overlap module source");
  expect(await readFile(path.join(modulesInsideDestination.moduleSource, "module-marker"), "utf8"))
    .toBe("module\n");
});

test("Deno prepared runtime overlap checks use path components rather than prefixes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "oliphaunt-deno-prefixes-"));
  scratch.push(root);
  const runtimeSource = path.join(root, "runtime");
  const moduleSource = path.join(root, "modules");
  const destination = path.join(root, "runtime-prepared");
  await mkdir(runtimeSource);
  await mkdir(moduleSource);
  await writeFile(path.join(runtimeSource, "postgres"), "runtime\n");
  await writeFile(path.join(moduleSource, "vector.so"), "module\n");

  await stageDenoPreparedRuntime(runtimeSource, moduleSource, destination);

  expect(await readFile(path.join(destination, "postgres"), "utf8")).toBe("runtime\n");
  expect(await readFile(
    path.join(destination, ...DENO_EMBEDDED_MODULE_DIRECTORY.split("/"), "vector.so"),
    "utf8",
  )).toBe("module\n");
});
