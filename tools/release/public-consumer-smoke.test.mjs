import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PUBLIC_CONSUMER_EVIDENCE_SCHEMA,
  publicConsumerEvidence,
  publicConsumerPlan,
  runBoundedCommand,
  runSurfaceWithRetries,
  sanitizedPublicEnvironment,
  validateCargoResolution,
  validateJsrResolution,
  validateMavenResolution,
  validateNpmResolution,
  validatePublicConsumerEvidence,
  writeImmutablePublicConsumerEvidence,
} from "./public-consumer-smoke.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");

function product(id, publishTargets, version = "1.2.3") {
  return { id, version, publishTargets, dependencies: [], kind: "sdk", path: `src/${id}` };
}

function carrier(id, productId, publishOrder, dependencies = []) {
  const separator = id.indexOf(":");
  return {
    id,
    product: productId,
    ecosystem: id.slice(0, separator),
    name: id.slice(separator + 1),
    version: "1.2.3",
    publishOrder,
    dependencies,
  };
}

function lock(products, carriers) {
  return {
    lockDigest: "a".repeat(64),
    source: { commit: "b".repeat(40), tree: "c".repeat(40) },
    products,
    carriers,
  };
}

function graph(products) {
  return {
    products: Object.fromEntries(products.map((row) => [row.id, {
      tag_prefix: `${row.id}-v`,
      version: row.version,
    }])),
  };
}

test("derives every registry surface and graph-root entry from the exact selected lock", () => {
  const products = [product("runtime", ["crates-io", "maven-central", "npm"]), product("sdk", ["crates-io", "jsr", "maven-central", "npm"])];
  const frozen = lock(products, [
    carrier("cargo:runtime-leaf", "runtime", 0),
    carrier("npm:@example/runtime-leaf", "runtime", 1),
    carrier("maven:dev.example:runtime", "runtime", 2),
    carrier("cargo:sdk", "sdk", 3, ["cargo:runtime-leaf"]),
    carrier("npm:@example/sdk", "sdk", 4, ["npm:@example/runtime-leaf"]),
    carrier("maven:dev.example:sdk", "sdk", 5, ["maven:dev.example:runtime"]),
    carrier("jsr:@example/sdk", "sdk", 6),
  ]);
  const plan = publicConsumerPlan(frozen, ["runtime", "sdk"], graph(products));
  assert.deepEqual(plan.surfaces.map(({ ecosystem }) => ecosystem), ["cargo", "jsr", "maven", "npm"]);
  assert.deepEqual(plan.surfaces.find(({ ecosystem }) => ecosystem === "cargo").entryCarrierIds, ["cargo:sdk"]);
  assert.deepEqual(plan.surfaces.find(({ ecosystem }) => ecosystem === "cargo").entryClosures, [{
    entryCarrierId: "cargo:sdk",
    carrierIds: ["cargo:runtime-leaf", "cargo:sdk"],
  }]);
  assert.deepEqual(plan.surfaces.find(({ ecosystem }) => ecosystem === "npm").entryCarrierIds, ["npm:@example/sdk"]);
  assert.deepEqual(plan.surfaces.find(({ ecosystem }) => ecosystem === "maven").entryCarrierIds, ["maven:dev.example:sdk"]);
  assert.deepEqual(plan.github.productTags, [
    { product: "runtime", tag: "runtime-v1.2.3", commit: "b".repeat(40) },
    { product: "sdk", tag: "sdk-v1.2.3", commit: "b".repeat(40) },
  ]);
});

test("supports source-only selections and records the exact Swift source tag separately", () => {
  const products = [product("oliphaunt-swift", ["github-release", "swift-package-source-tag"], "0.6.0")];
  const plan = publicConsumerPlan(lock(products, []), ["oliphaunt-swift"], graph(products));
  assert.deepEqual(plan.surfaces, []);
  assert.deepEqual(plan.github.swift, {
    product: "oliphaunt-swift",
    version: "0.6.0",
    tag: "0.6.0",
    parentCommit: "b".repeat(40),
  });
});

test("derives consumer closures from package-manager scopes instead of publication-only dev edges", () => {
  const products = [product("alpha", ["crates-io"])];
  const leaf = carrier("cargo:leaf", "alpha", 0);
  leaf.packageDependencies = [];
  const facade = carrier("cargo:facade", "alpha", 1, ["cargo:leaf"]);
  facade.packageDependencies = [{ ecosystem: "cargo", name: "leaf", requirement: "=1.2.3", scope: "development" }];
  const developmentPlan = publicConsumerPlan(lock(products, [leaf, facade]), ["alpha"], graph(products));
  assert.deepEqual(developmentPlan.surfaces[0].entryClosures, [
    { entryCarrierId: "cargo:facade", carrierIds: ["cargo:facade"] },
    { entryCarrierId: "cargo:leaf", carrierIds: ["cargo:leaf"] },
  ]);

  facade.packageDependencies[0].scope = "runtime";
  const runtimePlan = publicConsumerPlan(lock(products, [leaf, facade]), ["alpha"], graph(products));
  assert.deepEqual(runtimePlan.surfaces[0].entryClosures, [{
    entryCarrierId: "cargo:facade",
    carrierIds: ["cargo:facade", "cargo:leaf"],
  }]);
});

test("projects cross-registry publication edges out of each public consumer closure", () => {
  const products = [product("sdk", ["jsr", "maven-central", "npm"])];
  const frozen = lock(products, [
    carrier("npm:@example/sdk", "sdk", 0),
    carrier("maven:dev.example:sdk", "sdk", 1, ["npm:@example/sdk"]),
    carrier("jsr:@example/sdk", "sdk", 2, ["maven:dev.example:sdk"]),
  ]);
  const plan = publicConsumerPlan(frozen, ["sdk"], graph(products));
  assert.deepEqual(plan.surfaces.find(({ ecosystem }) => ecosystem === "npm").entryClosures, [
    { entryCarrierId: "npm:@example/sdk", carrierIds: ["npm:@example/sdk"] },
  ]);
  assert.deepEqual(plan.surfaces.find(({ ecosystem }) => ecosystem === "maven").entryClosures, [
    { entryCarrierId: "maven:dev.example:sdk", carrierIds: ["maven:dev.example:sdk"] },
  ]);
  assert.deepEqual(plan.surfaces.find(({ ecosystem }) => ecosystem === "jsr").entryClosures, [
    { entryCarrierId: "jsr:@example/sdk", carrierIds: ["jsr:@example/sdk"] },
  ]);
});

test("fails closed on product, target, carrier, and dependency-closure omissions", () => {
  const products = [product("alpha", ["npm"]), product("beta", ["npm"])];
  const frozen = lock(products, [
    carrier("npm:@example/alpha", "alpha", 0),
    carrier("npm:@example/beta", "beta", 1, ["npm:@example/alpha"]),
  ]);
  assert.throws(() => publicConsumerPlan(frozen, ["beta"], graph(products)), /exactly match the frozen publication lock/u);

  const unsupported = [product("alpha", ["invented-registry"])];
  assert.throws(() => publicConsumerPlan(lock(unsupported, []), ["alpha"], graph(unsupported)), /unsupported public consumer targets/u);

  const mismatch = [product("alpha", ["npm"])];
  assert.throws(() => publicConsumerPlan(lock(mismatch, []), ["alpha"], graph(mismatch)), /publish targets and frozen carrier products disagree/u);

  const omitted = lock(products, [carrier("npm:@example/beta", "beta", 0, ["npm:@example/alpha"])]);
  assert.throws(() => publicConsumerPlan(omitted, ["alpha", "beta"], graph(products)), /publish targets and frozen carrier products disagree|omits locked dependencies/u);

  const cycleProducts = [product("cycle", ["npm"])];
  const cycle = lock(cycleProducts, [
    carrier("npm:a", "cycle", 0, ["npm:b"]),
    carrier("npm:b", "cycle", 1, ["npm:a"]),
  ]);
  assert.throws(() => publicConsumerPlan(cycle, ["cycle"], graph(cycleProducts)), /no public consumer entry root/u);
});

test("validates exact public Cargo, npm, Maven, and JSR resolution records", () => {
  const cargo = [carrier("cargo:alpha", "alpha", 0)];
  assert.deepEqual(validateCargoResolution(`version = 4

[[package]]
name = "alpha"
version = "1.2.3"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "${"d".repeat(64)}"
`, cargo), [{ id: "cargo:alpha", version: "1.2.3", checksum: "d".repeat(64) }]);
  assert.throws(() => validateCargoResolution(`version = 4
[[package]]
name = "alpha"
version = "1.2.3"
source = "path+file:///workspace"
checksum = "${"d".repeat(64)}"
`, cargo), /non-public or substituted Cargo source/u);
  assert.throws(() => validateCargoResolution(`version = 4
[[package]]
name = "alpha"
version = "1.2.3"
source = "registry+https://github.com/rust-lang/crates.io-index-substitute"
checksum = "${"d".repeat(64)}"
`, cargo), /non-public or substituted Cargo source/u);

  const root = mkdtempSync(path.join(tmpdir(), "oliphaunt-public-consumer-test-"));
  try {
    const packageRoot = path.join(root, "node_modules", "@example", "alpha");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(path.join(packageRoot, "package.json"), '{"name":"@example/alpha","version":"1.2.3"}\n');
    const npmCarrier = [carrier("npm:@example/alpha", "alpha", 0)];
    const npm = validateNpmResolution({
      lockfileVersion: 3,
      packages: {
        "": { name: "consumer", version: "0.0.0" },
        "node_modules/@example/alpha": {
          version: "1.2.3",
          resolved: "https://registry.npmjs.org/@example/alpha/-/alpha-1.2.3.tgz",
          integrity: "sha512-exact",
        },
      },
    }, npmCarrier, ["npm:@example/alpha"], root);
    assert.deepEqual(npm.installedCarrierIds, ["npm:@example/alpha"]);
    assert.throws(() => validateNpmResolution({
      lockfileVersion: 3,
      packages: { "node_modules/@example/alpha": { version: "1.2.3", resolved: "file:../alpha", integrity: "sha512-exact" } },
    }, npmCarrier, ["npm:@example/alpha"], root), /non-public, linked, or integrity-free/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const mavenCarrier = [carrier("maven:dev.example:alpha", "alpha", 0)];
  assert.deepEqual(
    validateMavenResolution("OLIPHAUNT_PUBLIC_COMPONENT\tmaven:dev.example:alpha\tdev.example\talpha\t1.2.3\n", mavenCarrier),
    {
      entries: [{ entryCarrierId: "maven:dev.example:alpha", resolvedCarrierIds: ["maven:dev.example:alpha"] }],
      resolved: [{ id: "maven:dev.example:alpha", version: "1.2.3" }],
    },
  );
  assert.throws(() => validateMavenResolution("", mavenCarrier), /omitted from its independent clean Maven Central resolution/u);

  const jsrCarrier = [carrier("jsr:@example/alpha", "alpha", 0)];
  assert.deepEqual(
    validateJsrResolution({
      version: "5",
      jsr: { "@example/alpha@1.2.3": { integrity: "d".repeat(64) } },
    }, jsrCarrier),
    [{ id: "jsr:@example/alpha", version: "1.2.3", integrity: "d".repeat(64) }],
  );
  assert.throws(() => validateJsrResolution({ version: "5", jsr: {} }, jsrCarrier), /omitted from clean resolution/u);
});

test("public probes discard inherited credentials and package-manager substitution settings", () => {
  const env = sanitizedPublicEnvironment({
    NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
  }, {
    PATH: "/usr/bin",
    CARGO_SOURCE_CRATES_IO_REPLACE_WITH: "local-mirror",
    DENO_CONFIG: "/workspace/deno.json",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "url.file:///workspace/.insteadOf",
    GIT_CONFIG_VALUE_0: "https://github.com/",
    GRADLE_OPTS: "-I /workspace/substitute.gradle",
    NPM_CONFIG_REGISTRY: "https://private.invalid/",
    npm_config_userconfig: "/workspace/.npmrc",
    ORG_GRADLE_PROJECT_repositoryPassword: "secret",
    RELEASE_TOKEN: "secret",
  });
  assert.deepEqual(env, {
    PATH: "/usr/bin",
    NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
  });
});

test("builds canonical lock/receipt-bound evidence and writes it immutably", () => {
  const products = [product("alpha", ["npm"])];
  const frozen = lock(products, [carrier("npm:@example/alpha", "alpha", 0)]);
  const plan = publicConsumerPlan(frozen, ["alpha"], graph(products));
  const surfaces = [{
    surface: "npm",
    mode: "anonymous-public-independent-entry-host-install-and-lock-resolution",
    carrierIds: ["npm:@example/alpha"],
    dependencyScopes: ["optional", "peer", "runtime"],
    entryCarrierIds: ["npm:@example/alpha"],
    plannedEntryClosures: [{ entryCarrierId: "npm:@example/alpha", carrierIds: ["npm:@example/alpha"] }],
    entries: [{ entryCarrierId: "npm:@example/alpha", resolvedCarrierIds: ["npm:@example/alpha"] }],
    installedCarrierIds: ["npm:@example/alpha"],
    resolved: [{ id: "npm:@example/alpha", version: "1.2.3", integrity: "sha512-exact" }],
    receiptCoveredNotHostInstalledCarrierIds: [],
  }, {
    surface: "github",
    mode: "anonymous-public-exact-tag-resolution",
    productTags: plan.github.productTags,
    swift: null,
  }];
  const evidence = publicConsumerEvidence({
    lock: frozen,
    plan,
    registryReceiptSha256: "e".repeat(64),
    githubReceiptDigest: "f".repeat(64),
    surfaces,
  });
  assert.equal(evidence.schema, PUBLIC_CONSUMER_EVIDENCE_SCHEMA);
  assert.equal(validatePublicConsumerEvidence(evidence, frozen, plan), evidence);
  const changed = structuredClone(evidence);
  changed.surfaces.find(({ surface }) => surface === "github").productTags = [];
  assert.throws(() => validatePublicConsumerEvidence(changed, frozen, plan), /every exact product tag/u);

  const root = mkdtempSync(path.join(tmpdir(), "oliphaunt-public-evidence-test-"));
  try {
    const file = path.join(root, "evidence.json");
    writeImmutablePublicConsumerEvidence(file, evidence);
    writeImmutablePublicConsumerEvidence(file, evidence);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).evidenceDigest, evidence.evidenceDigest);
    const conflict = { ...evidence, evidenceDigest: digest("different") };
    assert.throws(() => writeImmutablePublicConsumerEvidence(file, conflict), /non-identical immutable/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cannot silently relabel a frozen entry dependency as receipt-only", () => {
  const products = [product("alpha", ["npm"])];
  const frozen = lock(products, [
    carrier("npm:@example/leaf", "alpha", 0),
    carrier("npm:@example/alpha", "alpha", 1, ["npm:@example/leaf"]),
  ]);
  const plan = publicConsumerPlan(frozen, ["alpha"], graph(products));
  const evidence = publicConsumerEvidence({
    lock: frozen,
    plan,
    registryReceiptSha256: "e".repeat(64),
    githubReceiptDigest: "f".repeat(64),
    surfaces: [{
      surface: "npm",
      mode: "anonymous-public-independent-entry-host-install-and-lock-resolution",
      carrierIds: ["npm:@example/alpha", "npm:@example/leaf"],
      dependencyScopes: ["optional", "peer", "runtime"],
      entryCarrierIds: ["npm:@example/alpha"],
      plannedEntryClosures: [{
        entryCarrierId: "npm:@example/alpha",
        carrierIds: ["npm:@example/alpha", "npm:@example/leaf"],
      }],
      entries: [{ entryCarrierId: "npm:@example/alpha", resolvedCarrierIds: ["npm:@example/alpha"] }],
      installedCarrierIds: ["npm:@example/alpha"],
      receiptCoveredNotHostInstalledCarrierIds: ["npm:@example/leaf"],
      resolved: [{ id: "npm:@example/alpha", version: "1.2.3", integrity: "sha512-exact" }],
    }, {
      surface: "github",
      mode: "anonymous-public-exact-tag-resolution",
      productTags: plan.github.productTags,
      swift: null,
    }],
  });
  assert.throws(
    () => validatePublicConsumerEvidence(evidence, frozen, plan),
    /omitted frozen platform-independent lock dependencies/u,
  );
});

test("subprocesses share one hard deadline and honor peer cancellation", async () => {
  const ok = await runBoundedCommand(process.execPath, ["-e", "process.stdout.write('ok')"], {
    deadlineMilliseconds: Date.now() + 5_000,
  });
  assert.equal(ok.stdout, "ok");
  await assert.rejects(
    () => runBoundedCommand(process.execPath, ["-e", "0"], { deadlineMilliseconds: Date.now() - 1 }),
    /shared public-consumer deadline reached/u,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => runBoundedCommand(process.execPath, ["-e", "0"], {
      deadlineMilliseconds: Date.now() + 5_000,
      signal: controller.signal,
    }),
    /cancelled before it could access/u,
  );
});

test("transient registry visibility failures retry from an empty workspace and cache", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oliphaunt-public-retry-test-"));
  const attempts = [];
  try {
    const result = await runSurfaceWithRetries(
      "npm",
      root,
      Date.now() + 60_000,
      new AbortController().signal,
      async (attemptRoot) => {
        attempts.push(attemptRoot);
        if (attempts.length === 1) {
          writeFileSync(path.join(attemptRoot, "partial-install"), "must not survive\n");
          await runBoundedCommand(process.execPath, ["-e", "console.error('npm E404 Not Found'); process.exit(1)"], {
            deadlineMilliseconds: Date.now() + 5_000,
          });
        }
        assert.equal(existsSync(path.join(attemptRoot, "partial-install")), false);
        return "resolved";
      },
      { maxAttempts: 2, retryDelays: [1] },
    );
    assert.equal(result, "resolved");
    assert.equal(attempts.length, 2);
    assert.notEqual(attempts[0], attempts[1]);
    assert.equal(existsSync(attempts[0]), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
