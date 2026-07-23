import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assertVerifiedNpmPublisherRuntime,
  assertVerifiedNpmPublisherTree,
  externalExtensionConsumerPlan,
  renderExactMavenConsumer,
  resolveVerifiedNpmPublisherRuntime,
} from "./external-extension-registry-consumer.mjs";
import {
  exactExtensionProducts,
  extensionMetadata,
  registryPackageRows,
} from "./release-artifact-targets.mjs";

const EXTERNALS = exactExtensionProducts("external-extension-registry-consumer.test")
  .filter((product) => extensionMetadata(product, "external-extension-registry-consumer.test").class === "external");

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function npmTreeIdentity(files, executablePaths) {
  const executables = new Set(executablePaths);
  const digest = createHash("sha256").update("oliphaunt-bootstrap-tree-v2\0");
  let expandedBytes = 0;
  for (const [relative, contents] of Object.entries(files)
    .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))) {
    const bytes = Buffer.from(contents);
    expandedBytes += bytes.length;
    digest.update(relative);
    digest.update("\0");
    digest.update(String(bytes.length));
    digest.update("\0");
    digest.update(executables.has(relative) ? "x" : "-");
    digest.update("\0");
    digest.update(bytes);
    digest.update("\0");
  }
  return {
    fileCount: Object.keys(files).length,
    expandedBytes,
    sha256: digest.digest("hex"),
  };
}

function verifiedNpmFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "oliphaunt-verified-npm-"));
  const toolchains = path.join(root, "src/sources/toolchains");
  const nodeExecutable = path.join(root, "runtime/node");
  const npmRoot = path.join(root, "publisher/verified/npm");
  const npmCli = path.join(npmRoot, "bin/npm-cli.js");
  const npmDependency = path.join(npmRoot, "lib/runtime.js");
  const nodeContents = "pinned node fixture\n";
  const npmContents = "pinned npm fixture\n";
  const npmDependencyContents = "module.exports = 'pinned';\n";
  const npmPackageContents = '{"name":"npm","version":"11.18.0"}\n';
  const npmFiles = {
    "bin/npm-cli.js": npmContents,
    "lib/runtime.js": npmDependencyContents,
    "package.json": npmPackageContents,
  };
  const executablePaths = ["bin/npm-cli.js"];
  const tree = npmTreeIdentity(npmFiles, executablePaths);
  mkdirSync(toolchains, { recursive: true });
  mkdirSync(path.dirname(nodeExecutable), { recursive: true });
  mkdirSync(path.dirname(npmCli), { recursive: true });
  mkdirSync(path.dirname(npmDependency), { recursive: true });
  writeFileSync(nodeExecutable, nodeContents);
  writeFileSync(npmCli, npmContents);
  chmodSync(npmCli, 0o755);
  writeFileSync(npmDependency, npmDependencyContents);
  writeFileSync(path.join(npmRoot, "package.json"), npmPackageContents);
  writeFileSync(path.join(toolchains, "node-runtime.toml"), [
    "[toolchain]",
    'version = "22.22.3"',
    "[assets.x86_64-unknown-linux-gnu]",
    `binary_sha256 = "${sha256(nodeContents)}"`,
    `binary_bytes = "${Buffer.byteLength(nodeContents)}"`,
    "",
  ].join("\n"));
  writeFileSync(path.join(toolchains, "npm-publisher.toml"), [
    "[toolchain]",
    'version = "11.18.0"',
    "[package]",
    `expanded_bytes = "${tree.expandedBytes}"`,
    `file_count = "${tree.fileCount}"`,
    `tree_sha256 = "${tree.sha256}"`,
    `executable_paths = "${executablePaths.join(",")}"`,
    'binary_path = "bin/npm-cli.js"',
    `binary_sha256 = "${sha256(npmContents)}"`,
    `binary_bytes = "${Buffer.byteLength(npmContents)}"`,
    "",
  ].join("\n"));
  const environment = {
    OLIPHAUNT_VERIFIED_NODE_EXECUTABLE: nodeExecutable,
    OLIPHAUNT_VERIFIED_NPM_CLI: npmCli,
  };
  const spawnImpl = (command, args) => ({
    status: 0,
    stdout: args[0] === "--version" ? "v22.22.3\n" : "11.18.0\n",
    stderr: "",
  });
  return {
    root,
    nodeExecutable,
    npmRoot,
    npmCli,
    npmDependency,
    npmDependencyContents,
    tree,
    executablePaths,
    environment,
    spawnImpl,
  };
}

test("aggregates every selected external facade and leaf without selecting contrib", () => {
  const plan = externalExtensionConsumerPlan([
    "oliphaunt-extension-contrib-pg18",
    ...EXTERNALS,
    "liboliphaunt-native",
  ]);
  expect(plan.products).toEqual([...EXTERNALS].sort());
  expect(plan.cargo.dependencies.map(({ name }) => name)).toEqual([...EXTERNALS].sort());
  expect(plan.cargo.dependencies.every(({ features }) =>
    features.includes("native") && features.includes("wasix"))).toBe(true);
  expect(plan.cargo.expectedPackages).toEqual(EXTERNALS.flatMap((product) =>
    registryPackageRows({ product, packageKind: "crates" }, "external-extension-registry-consumer.test")
      .map(({ packageName }) => packageName)).sort());
  expect(plan.npm.targets).toEqual([
    "linux-arm64-gnu",
    "linux-x64-gnu",
    "macos-arm64",
    "windows-x64-msvc",
  ]);
  expect(Object.values(plan.npm.productsByTarget).every((products) =>
    JSON.stringify(products) === JSON.stringify([...EXTERNALS].sort()))).toBe(true);
  expect(plan.npm.expectedPackages.length).toBe(EXTERNALS.length * 5);
  expect(plan.maven.expectedCoordinates.length).toBe(EXTERNALS.length * 2);
});

test("renders one exact Maven dependency consumer over every local repository", () => {
  const rendered = renderExactMavenConsumer({
    repositories: ["/tmp/vector", "/tmp/postgis"],
    coordinates: [
      "dev.oliphaunt.extensions:vector-android-x86_64:1.2.3",
      "dev.oliphaunt.extensions:postgis-android-x86_64:3.4.5",
    ],
    outputFile: "/tmp/resolved.tsv",
  });
  expect(rendered).toContain("resolveExactCandidates");
  expect(rendered).toContain("@tar.gz");
  expect(rendered).toContain("exact Maven carrier set differs");
  expect(rendered).toContain("/tmp/vector");
  expect(rendered).toContain("/tmp/postgis");
});

test("keeps the aggregate registry consumer mandatory after every selected product dry-run", () => {
  const source = readFileSync(new URL("./release-publish.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function runProductDryRunPlan");
  const end = source.indexOf("\nasync function publishNoProduct", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const body = source.slice(start, end);
  expect(body.match(/runExternalExtensionRegistryConsumerProof\(/gu)).toHaveLength(1);
  expect(body.indexOf("runExternalExtensionRegistryConsumerProof("))
    .toBeGreaterThan(body.lastIndexOf("runBunProductDryRun("));
});

test("revalidates the complete npm tree immediately before every exact npm consumer install", () => {
  const source = readFileSync(new URL("./external-extension-registry-consumer.mjs", import.meta.url), "utf8");
  const start = source.indexOf("function publishAndConsumeNpm");
  const end = source.indexOf("\nfunction mavenParts", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const body = source.slice(start, end);
  expect(body.match(/run\(checkedRuntime[.]nodeExecutable/gu)).toHaveLength(1);
  expect(body).toContain(
    "const checkedRuntime = assertVerifiedNpmPublisherRuntime(npmRuntime);\n"
      + "      run(checkedRuntime.nodeExecutable",
  );
});

test("resolves only setup-exported Node and npm files after manifest identity checks", () => {
  const fixture = verifiedNpmFixture();
  try {
    const runtime = resolveVerifiedNpmPublisherRuntime({
      environment: fixture.environment,
      root: fixture.root,
      platform: "linux",
      arch: "x64",
      spawnImpl: fixture.spawnImpl,
    });
    expect({
      nodeExecutable: runtime.nodeExecutable,
      npmCli: runtime.npmCli,
      nodeVersion: runtime.nodeVersion,
      npmVersion: runtime.npmVersion,
    }).toEqual({
      nodeExecutable: fixture.nodeExecutable,
      npmCli: fixture.npmCli,
      nodeVersion: "22.22.3",
      npmVersion: "11.18.0",
    });
    expect(runtime.npmTree).toEqual({
      root: fixture.npmRoot,
      fileCount: fixture.tree.fileCount,
      expandedBytes: fixture.tree.expandedBytes,
      sha256: fixture.tree.sha256,
      executablePaths: fixture.executablePaths,
      platform: "linux",
    });
    expect(runtime.nodeIdentity).toEqual({
      bytes: Buffer.byteLength("pinned node fixture\n"),
      sha256: sha256("pinned node fixture\n"),
    });
    expect(typeof runtime.nodeFileIdentity.dev).toBe("bigint");
    expect(typeof runtime.nodeFileIdentity.ino).toBe("bigint");
    expect(typeof runtime.npmCliFileIdentity.dev).toBe("bigint");
    expect(typeof runtime.npmCliFileIdentity.ino).toBe("bigint");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects a dependency-file mutation after npm setup resolution and before invocation", () => {
  const fixture = verifiedNpmFixture();
  try {
    const runtime = resolveVerifiedNpmPublisherRuntime({
      environment: fixture.environment,
      root: fixture.root,
      platform: "linux",
      arch: "x64",
      spawnImpl: fixture.spawnImpl,
    });
    writeFileSync(fixture.npmDependency, "module.exports = 'forged';\n");
    expect(() => assertVerifiedNpmPublisherTree(runtime))
      .toThrow("verified npm tree identity differs");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects a Node binary mutation after setup resolution and before npm invocation", () => {
  const fixture = verifiedNpmFixture();
  try {
    const runtime = resolveVerifiedNpmPublisherRuntime({
      environment: fixture.environment,
      root: fixture.root,
      platform: "linux",
      arch: "x64",
      spawnImpl: fixture.spawnImpl,
    });
    writeFileSync(fixture.nodeExecutable, "forged node fixture\n");
    expect(() => assertVerifiedNpmPublisherRuntime(runtime))
      .toThrow(/verified Node[.]js executable (?:filesystem identity changed|byte count|SHA-256 differs)/u);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects an identical-byte Node executable identity substitution", () => {
  const fixture = verifiedNpmFixture();
  try {
    const runtime = resolveVerifiedNpmPublisherRuntime({
      environment: fixture.environment,
      root: fixture.root,
      platform: "linux",
      arch: "x64",
      spawnImpl: fixture.spawnImpl,
    });
    const displaced = `${fixture.nodeExecutable}.original`;
    renameSync(fixture.nodeExecutable, displaced);
    writeFileSync(fixture.nodeExecutable, readFileSync(displaced));
    expect(() => assertVerifiedNpmPublisherRuntime(runtime))
      .toThrow("verified Node.js executable filesystem identity changed after setup");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects an identical-byte npm CLI identity substitution", () => {
  const fixture = verifiedNpmFixture();
  try {
    const runtime = resolveVerifiedNpmPublisherRuntime({
      environment: fixture.environment,
      root: fixture.root,
      platform: "linux",
      arch: "x64",
      spawnImpl: fixture.spawnImpl,
    });
    const displaced = path.join(fixture.root, "displaced-npm-cli.js");
    renameSync(fixture.npmCli, displaced);
    writeFileSync(fixture.npmCli, readFileSync(displaced));
    chmodSync(fixture.npmCli, 0o755);
    expect(() => assertVerifiedNpmPublisherRuntime(runtime))
      .toThrow("verified npm CLI filesystem identity changed after setup");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects a runtime pathname replaced by a symbolic link after setup", () => {
  const fixture = verifiedNpmFixture();
  try {
    const runtime = resolveVerifiedNpmPublisherRuntime({
      environment: fixture.environment,
      root: fixture.root,
      platform: "linux",
      arch: "x64",
      spawnImpl: fixture.spawnImpl,
    });
    const displaced = `${fixture.nodeExecutable}.original`;
    renameSync(fixture.nodeExecutable, displaced);
    symlinkSync(displaced, fixture.nodeExecutable);
    expect(() => assertVerifiedNpmPublisherRuntime(runtime))
      .toThrow("OLIPHAUNT_VERIFIED_NODE_EXECUTABLE must be a regular non-symbolic-link file");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("fails closed for missing, relative, modified, and symbolic-link npm setup outputs", () => {
  const fixture = verifiedNpmFixture();
  try {
    const options = {
      root: fixture.root,
      platform: "linux",
      arch: "x64",
      spawnImpl: fixture.spawnImpl,
    };
    expect(() => resolveVerifiedNpmPublisherRuntime({ ...options, environment: {} }))
      .toThrow("OLIPHAUNT_VERIFIED_NODE_EXECUTABLE must be a non-empty absolute path");
    expect(() => resolveVerifiedNpmPublisherRuntime({
      ...options,
      environment: { ...fixture.environment, OLIPHAUNT_VERIFIED_NPM_CLI: "npm" },
    })).toThrow("OLIPHAUNT_VERIFIED_NPM_CLI must be a non-empty absolute path");

    writeFileSync(fixture.npmCli, "modified npm fixture\n");
    expect(() => resolveVerifiedNpmPublisherRuntime({ ...options, environment: fixture.environment }))
      .toThrow(/verified npm CLI (?:byte count|SHA-256) differs/u);

    writeFileSync(fixture.npmCli, "pinned npm fixture\n");
    writeFileSync(fixture.nodeExecutable, "modified node fixture\n");
    expect(() => resolveVerifiedNpmPublisherRuntime({ ...options, environment: fixture.environment }))
      .toThrow(/verified Node[.]js executable (?:byte count|SHA-256) differs/u);
    writeFileSync(fixture.nodeExecutable, "pinned node fixture\n");

    const link = path.join(fixture.root, "publisher/verified/npm/bin/npm-cli-link.js");
    symlinkSync(fixture.npmCli, link);
    expect(() => resolveVerifiedNpmPublisherRuntime({
      ...options,
      environment: { ...fixture.environment, OLIPHAUNT_VERIFIED_NPM_CLI: link },
    })).toThrow("OLIPHAUNT_VERIFIED_NPM_CLI must be a regular non-symbolic-link file");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("fails closed when the verified files report a different runtime version", () => {
  const fixture = verifiedNpmFixture();
  try {
    expect(() => resolveVerifiedNpmPublisherRuntime({
      environment: fixture.environment,
      root: fixture.root,
      platform: "linux",
      arch: "x64",
      spawnImpl: (command, args) => ({
        status: 0,
        stdout: args[0] === "--version" ? "v22.22.3\n" : "11.17.0\n",
        stderr: "",
      }),
    })).toThrow("verified npm version differs: expected 11.18.0");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
