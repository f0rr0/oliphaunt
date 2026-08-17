import assert from "node:assert/strict";
import { execFileSync } from "../test/fd-backed-spawn-sync.mjs";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  compatibilityEntriesForBumpedProducts,
  releasePleaseManifestTransitions,
  releasePleaseWorktreeTransitions,
  sharedContribReleaseCandidates,
} from "./release-please-transition.mjs";

const PRODUCT_PATHS = {
  "liboliphaunt-native": "packages/native",
  "liboliphaunt-wasix": "packages/wasix",
  "oliphaunt-extension-amcheck": "packages/amcheck",
  "oliphaunt-extension-vector": "packages/vector",
};

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function manifest(versions) {
  return Object.fromEntries(
    Object.entries(PRODUCT_PATHS).map(([product, packagePath]) => [packagePath, versions[product]]),
  );
}

function writeReleaseState(root, versions) {
  const config = {
    packages: Object.fromEntries(
      Object.entries(PRODUCT_PATHS).map(([product, packagePath]) => [packagePath, { component: product }]),
    ),
  };
  writeFileSync(path.join(root, "release-please-config.json"), `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(
    path.join(root, ".release-please-manifest.json"),
    `${JSON.stringify(manifest(versions), null, 2)}\n`,
  );
}

function commit(root, subject) {
  git(root, "add", ".");
  git(root, "commit", "-m", subject);
  return git(root, "rev-parse", "HEAD");
}

function fixture(t, versions = null) {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-release-please-transition-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Release Test");
  git(root, "config", "user.email", "release-test@example.invalid");
  writeFileSync(path.join(root, "legacy.txt"), "legacy history\n");
  commit(root, "legacy history");
  if (versions !== null) {
    for (const directory of Object.values(PRODUCT_PATHS)) mkdirSync(path.join(root, directory), { recursive: true });
    writeReleaseState(root, versions);
    commit(root, "feat: introduce products");
  }
  return root;
}

const ZERO = Object.fromEntries(Object.keys(PRODUCT_PATHS).map((product) => [product, "0.0.0"]));
const V1 = Object.fromEntries(Object.keys(PRODUCT_PATHS).map((product) => [product, "1.0.0"]));

function contribManifest(version) {
  return `postgres-version = ${JSON.stringify(version)}\n\n[[extensions]]\nid = "amcheck"\n`;
}

function writeCarrierDescriptor(root) {
  mkdirSync(path.join(root, "src/extensions/contrib"), { recursive: true });
  mkdirSync(path.join(root, "tools/release"), { recursive: true });
  mkdirSync(path.join(root, "src/postgres/versions/18"), { recursive: true });
  mkdirSync(path.join(root, "src/shared/extension-runtime-contract"), { recursive: true });
  writeFileSync(
    path.join(root, "src/extensions/contrib/carriers.toml"),
    [
      'logical_product = "oliphaunt-extension-contrib-pg18"',
      'member_manifest = "src/extensions/contrib/postgres18.toml"',
      'source = "src/postgres/versions/18/source.toml"',
      'contract = "src/shared/extension-runtime-contract/contract.toml"',
      'native_owner = "liboliphaunt-native"',
      'wasix_owner = "liboliphaunt-wasix"',
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(root, "src/extensions/contrib/postgres18.toml"),
    contribManifest("18.4"),
  );
  writeFileSync(
    path.join(root, "tools/release/extension-target-profiles.toml"),
    'schema = "oliphaunt-extension-artifact-target-profiles-v1"\n',
  );
  writeFileSync(path.join(root, "src/postgres/versions/18/source.toml"), 'version = "18.4"\n');
  writeFileSync(path.join(root, "src/shared/extension-runtime-contract/contract.toml"), 'schema = "v1"\n');
}

function runtimeGraph(versions) {
  return {
    products: Object.fromEntries(["liboliphaunt-native", "liboliphaunt-wasix"].map((product) => [product, {
      path: PRODUCT_PATHS[product],
      tag_prefix: `${product}-v`,
      version: versions[product],
    }])),
  };
}

test("the unreleased introduction may have no parent release manifest", (t) => {
  const root = fixture(t);
  for (const directory of Object.values(PRODUCT_PATHS)) mkdirSync(path.join(root, directory), { recursive: true });
  writeReleaseState(root, ZERO);
  commit(root, "feat: introduce oliphaunt");

  assert.deepEqual(releasePleaseWorktreeTransitions(root, { prefix: "transition-test" }), []);
});

test("a missing parent manifest cannot conceal already-released versions", (t) => {
  const root = fixture(t);
  for (const directory of Object.values(PRODUCT_PATHS)) mkdirSync(path.join(root, directory), { recursive: true });
  writeReleaseState(root, V1);
  commit(root, "invalid introduction");

  assert.throws(
    () => releasePleaseWorktreeTransitions(root, { prefix: "transition-test" }),
    /missing parent release-please manifest is valid only for the unreleased 0[.]0[.]0 introduction state/u,
  );
});

test("the first release reports every product that advanced", (t) => {
  const root = fixture(t, ZERO);
  const released = Object.fromEntries(Object.keys(PRODUCT_PATHS).map((product) => [product, "0.1.0"]));
  writeReleaseState(root, released);
  commit(root, "chore(release): first release");

  const transitions = releasePleaseWorktreeTransitions(root, { prefix: "transition-test" });
  assert.deepEqual(transitions.map(({ product }) => product), Object.keys(PRODUCT_PATHS).sort());
});

test("a post-first runtime release leaves an independently versioned external sink untouched", (t) => {
  const root = fixture(t, V1);
  const released = {
    ...V1,
    "liboliphaunt-native": "1.1.0",
    "liboliphaunt-wasix": "1.1.0",
    "oliphaunt-extension-amcheck": "1.1.0",
  };
  writeReleaseState(root, released);
  commit(root, "chore(release): runtime release");

  const transitions = releasePleaseWorktreeTransitions(root, { prefix: "transition-test" });
  assert.deepEqual(
    transitions.map(({ product }) => product),
    ["liboliphaunt-native", "liboliphaunt-wasix", "oliphaunt-extension-amcheck"],
  );
  const entries = [
    { id: "contrib-native", product: "oliphaunt-extension-amcheck" },
    { id: "external-native", product: "oliphaunt-extension-vector" },
  ];
  assert.deepEqual(
    compatibilityEntriesForBumpedProducts(entries, transitions).map(({ id }) => id),
    ["contrib-native"],
  );
});

test("native can advance without WASIX or contrib", (t) => {
  const root = fixture(t, V1);
  writeReleaseState(root, { ...V1, "liboliphaunt-native": "1.1.0" });
  commit(root, "chore(release): incomplete runtime release");
  const transitions = releasePleaseWorktreeTransitions(root, { prefix: "transition-test" });

  assert.deepEqual(transitions.map(({ product }) => product), ["liboliphaunt-native"]);
});

test("independent products can advance to divergent versions", (t) => {
  const root = fixture(t, V1);
  writeReleaseState(root, {
    ...V1,
    "liboliphaunt-native": "1.1.0",
    "liboliphaunt-wasix": "1.2.0",
    "oliphaunt-extension-amcheck": "1.2.0",
  });
  commit(root, "chore(release): divergent runtime release");
  const transitions = releasePleaseWorktreeTransitions(root, { prefix: "transition-test" });

  assert.deepEqual(
    transitions.map(({ product, after }) => [product, after]),
    [
      ["liboliphaunt-native", "1.1.0"],
      ["liboliphaunt-wasix", "1.2.0"],
      ["oliphaunt-extension-amcheck", "1.2.0"],
    ],
  );
});

test("an external-only release remains independent", (t) => {
  const root = fixture(t, V1);
  writeReleaseState(root, { ...V1, "oliphaunt-extension-vector": "1.1.0" });
  commit(root, "chore(release): vector release");
  const transitions = releasePleaseWorktreeTransitions(root, { prefix: "transition-test" });

  assert.deepEqual(transitions.map(({ product }) => product), ["oliphaunt-extension-vector"]);
});

test("a manifest regression fails closed", (t) => {
  const root = fixture(t, V1);
  writeReleaseState(root, { ...V1, "oliphaunt-extension-vector": "0.9.0" });
  commit(root, "regress vector");

  assert.throws(
    () => releasePleaseWorktreeTransitions(root, { prefix: "transition-test" }),
    /oliphaunt-extension-vector manifest version regressed from 1[.]0[.]0 to 0[.]9[.]0/u,
  );
});

test("only the retired contrib release path may disappear without fabricating a transition", () => {
  const config = { packages: { "packages/native": { component: "liboliphaunt-native" } } };
  assert.deepEqual(
    releasePleaseManifestTransitions(
      config,
      { "packages/native": "1.0.0", "src/extensions/contrib": "1.0.0" },
      { "packages/native": "1.0.0" },
      { prefix: "transition-test" },
    ),
    [],
  );
  assert.throws(
    () => releasePleaseManifestTransitions(
      config,
      { "packages/native": "1.0.0", "packages/accidentally-removed": "1.0.0" },
      { "packages/native": "1.0.0" },
      { prefix: "transition-test" },
    ),
    /packages cannot disappear.*packages\/accidentally-removed/u,
  );
});

test("shared-only fixes with no Release Please transitions seed both runtime candidates", (t) => {
  const root = fixture(t, V1);
  writeCarrierDescriptor(root);
  commit(root, "refactor(release): define runtime-owned contrib carriers");
  git(root, "tag", "liboliphaunt-native-v1.0.0");
  git(root, "tag", "liboliphaunt-wasix-v1.0.0");
  writeFileSync(path.join(root, "src/postgres/versions/18/source.toml"), 'version = "18.5"\n');
  commit(root, "fix(contrib): update PostgreSQL source baseline");

  assert.deepEqual(
    sharedContribReleaseCandidates(root, runtimeGraph(V1), [], { prefix: "transition-test" })
      .map(({ product, before, after, changelogSection }) => ({ product, before, after, changelogSection })),
    [
      { product: "liboliphaunt-native", before: "1.0.0", after: "1.0.1", changelogSection: "Bug Fixes" },
      { product: "liboliphaunt-wasix", before: "1.0.0", after: "1.0.1", changelogSection: "Bug Fixes" },
    ],
  );
});

test("a pre-1.0 breaking contrib commit requires a minor runtime bump", (t) => {
  const versions = { ...V1, "liboliphaunt-native": "0.2.3", "liboliphaunt-wasix": "0.2.3" };
  const root = fixture(t, versions);
  writeCarrierDescriptor(root);
  commit(root, "refactor(release): define runtime-owned contrib carriers");
  git(root, "tag", "liboliphaunt-native-v0.2.3");
  git(root, "tag", "liboliphaunt-wasix-v0.2.3");
  writeFileSync(path.join(root, "src/extensions/contrib/postgres18.toml"), contribManifest("18.5"));
  commit(root, "feat(contrib)!: change bundled SQL surface");

  assert.deepEqual(
    sharedContribReleaseCandidates(root, runtimeGraph(versions), [], { prefix: "transition-test" })
      .map(({ product, after }) => [product, after]),
    [
      ["liboliphaunt-native", "0.3.0"],
      ["liboliphaunt-wasix", "0.3.0"],
    ],
  );
});

test("an existing sufficient runtime bump is preserved and receives the shared reasons", (t) => {
  const root = fixture(t, V1);
  writeCarrierDescriptor(root);
  commit(root, "refactor(release): define runtime-owned contrib carriers");
  git(root, "tag", "liboliphaunt-native-v1.0.0");
  git(root, "tag", "liboliphaunt-wasix-v1.0.0");
  writeFileSync(path.join(root, "src/extensions/contrib/postgres18.toml"), contribManifest("18.5"));
  commit(root, "feat(contrib): add a bundled SQL capability");
  const versions = { ...V1, "liboliphaunt-native": "1.1.0" };

  assert.deepEqual(
    sharedContribReleaseCandidates(
      root,
      runtimeGraph(versions),
      [{
        product: "liboliphaunt-native",
        packagePath: PRODUCT_PATHS["liboliphaunt-native"],
        before: "1.0.0",
        after: "1.1.0",
      }],
      { prefix: "transition-test" },
    ).map(({ product, before, after, changelogMode, reasons }) => ({
      product,
      before,
      after,
      changelogMode,
      reasonSummaries: reasons.map(({ summary }) => summary),
    })),
    [
      {
        product: "liboliphaunt-native",
        before: "1.1.0",
        after: "1.1.0",
        changelogMode: "merge-existing",
        reasonSummaries: ["add a bundled SQL capability"],
      },
      {
        product: "liboliphaunt-wasix",
        before: "1.0.0",
        after: "1.1.0",
        changelogMode: undefined,
        reasonSummaries: ["add a bundled SQL capability"],
      },
    ],
  );
});

test("an insufficient runtime candidate is promoted to the shared-source intent", (t) => {
  const root = fixture(t, V1);
  writeCarrierDescriptor(root);
  commit(root, "refactor(release): define runtime-owned contrib carriers");
  git(root, "tag", "liboliphaunt-native-v1.0.0");
  git(root, "tag", "liboliphaunt-wasix-v1.0.0");
  writeFileSync(path.join(root, "src/extensions/contrib/postgres18.toml"), contribManifest("18.5"));
  commit(root, "feat(contrib): add a bundled SQL capability");
  const versions = { ...V1, "liboliphaunt-native": "1.0.1" };

  assert.deepEqual(
    sharedContribReleaseCandidates(
      root,
      runtimeGraph(versions),
      [{
        product: "liboliphaunt-native",
        packagePath: PRODUCT_PATHS["liboliphaunt-native"],
        before: "1.0.0",
        after: "1.0.1",
      }],
      { prefix: "transition-test" },
    ).map(({ product, before, after, changelogMode }) => ({ product, before, after, changelogMode })),
    [
      {
        product: "liboliphaunt-native",
        before: "1.0.1",
        after: "1.1.0",
        changelogMode: "merge-existing",
      },
      {
        product: "liboliphaunt-wasix",
        before: "1.0.0",
        after: "1.1.0",
        changelogMode: undefined,
      },
    ],
  );
});

test("unsupported shared-source commit intent fails closed", (t) => {
  const root = fixture(t, V1);
  writeCarrierDescriptor(root);
  commit(root, "refactor(release): define runtime-owned contrib carriers");
  git(root, "tag", "liboliphaunt-native-v1.0.0");
  git(root, "tag", "liboliphaunt-wasix-v1.0.0");
  writeFileSync(path.join(root, "src/extensions/contrib/postgres18.toml"), contribManifest("18.5"));
  commit(root, "chore: ambiguous shared source update");

  assert.throws(
    () => sharedContribReleaseCandidates(root, runtimeGraph(V1), [], { prefix: "transition-test" }),
    /shared contrib source commit .* unsupported release intent/u,
  );
});
