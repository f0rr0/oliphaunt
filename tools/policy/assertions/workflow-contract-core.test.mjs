#!/usr/bin/env bun
import assert from "node:assert/strict";
import test from "node:test";

import {
  assertConditionBranches,
  assertConditionRequires,
  assertGraph,
  assertMutationBoundary,
  assertPhaseChain,
  assertPinnedActions,
  assertStepOrder,
  executableShell,
} from "./workflow-contract-core.mjs";

function workflow(steps, extra = {}) {
  return {
    on: { workflow_dispatch: {} },
    jobs: {
      publish: {
        "runs-on": "ubuntu-24.04",
        steps,
      },
    },
    ...extra,
  };
}

test("dead comments and heredoc bodies are not executable workflow evidence", () => {
  const shell = executableShell([
    "# npm publish",
    "echo safe # cargo publish",
    "cat <<'EVIDENCE'",
    "tools/dev/bun.sh tools/release/release-publish.mjs publish --registry-plan plan.json",
    "EVIDENCE",
    "printf '%s\\n' done",
  ].join("\n"));
  assert.doesNotMatch(shell, /npm publish|cargo publish|release-publish[.]mjs/u);
  assert.match(shell, /echo safe/u);
  assert.match(shell, /printf/u);
});

test("continued shell invocations are normalized as one active command", () => {
  assert.match(
    executableShell([
      "bun tool.mjs \\",
      "  publish \\",
      "  --locked",
    ].join("\n")),
    /bun tool[.]mjs\s+publish\s+--locked/u,
  );
});

test("a dead mutation comment cannot satisfy a required mutation phase", () => {
  const candidate = workflow([{
    id: "exact_registry_publish",
    run: "# tools/dev/bun.sh tools/release/release-publish.mjs publish --registry-plan plan.json\necho dry",
  }]);
  assert.throws(
    () => assertMutationBoundary(candidate, {
      release_publish: ["publish.exact_registry_publish"],
    }),
    /must contain exactly one active release_publish mutation/u,
  );
});

test("direct or renamed registry mutations are rejected outside approved stable IDs", () => {
  for (const run of [
    "npm publish candidate.tgz",
    "NPM_CONFIG_PROVENANCE=true npm --workspace sdk publish candidate.tgz",
    "cargo publish --package unexpected",
    "command cargo --locked publish --package unexpected",
    "gh release upload v1.0.0 artifact.tgz",
    "git push origin HEAD:main",
  ]) {
    const candidate = workflow([{ id: "innocent_name", run }]);
    assert.throws(
      () => assertMutationBoundary(candidate, {}),
      /performs unapproved/u,
      run,
    );
  }
});

test("the exact active mutation is accepted only at its declared stable phase", () => {
  const candidate = workflow([{
    id: "exact_registry_publish",
    run: "tools/dev/bun.sh tools/release/release-publish.mjs publish \\\n+      --registry-plan target/release/normal-publication-plan.json",
  }]);
  assert.doesNotThrow(() => assertMutationBoundary(candidate, {
    release_publish: ["publish.exact_registry_publish"],
  }));

  candidate.jobs.publish.steps[0].id = "renamed_publish";
  assert.throws(
    () => assertMutationBoundary(candidate, {
      release_publish: ["publish.exact_registry_publish"],
    }),
    /renamed_publish performs unapproved release_publish mutation/u,
  );
});

test("condition contracts reject OR bypasses instead of searching for tokens", () => {
  assert.doesNotThrow(() => assertConditionRequires(
    "${{ always() && inputs.operation == 'publish' && guard == 'true' }}",
    ["always()", "inputs.operation == 'publish'", "guard == 'true'"],
    "publish",
  ));
  assert.throws(
    () => assertConditionRequires(
      "${{ always() && (inputs.operation == 'publish' || github.actor == 'attacker') }}",
      ["always()", "inputs.operation == 'publish'"],
      "publish",
    ),
    /condition does not guarantee/u,
  );
});

test("condition branch contracts accept reordered safe alternatives and reject extra bypasses", () => {
  const expected = [
    ["always()", "event == 'push'", "ref == 'main'"],
    ["always()", "event == 'dispatch'", "ref == 'main'"],
  ];
  assert.doesNotThrow(() => assertConditionBranches(
    "${{ ref == 'main' && always() && (event == 'dispatch' || event == 'push') }}",
    expected,
    "qualified",
  ));
  assert.throws(
    () => assertConditionBranches(
      "${{ ref == 'main' && always() && (event == 'dispatch' || event == 'push' || actor == 'admin') }}",
      expected,
      "qualified",
    ),
    /condition branches must be/u,
  );
});

test("workflow graph and phase contracts reject missing, cyclic, or reordered structure", () => {
  const missing = workflow([]);
  missing.jobs.publish.needs = ["not-a-job"];
  assert.throws(() => assertGraph(missing, "fixture"), /references missing job/u);

  const cyclic = workflow([]);
  cyclic.jobs.other = { needs: ["publish"], "runs-on": "ubuntu-24.04", steps: [] };
  cyclic.jobs.publish.needs = ["other"];
  assert.throws(() => assertGraph(cyclic, "fixture"), /dependency graph contains a cycle/u);

  const reordered = workflow([
    { id: "promote", run: "echo promote" },
    { id: "verify", run: "echo verify" },
  ]);
  assert.throws(
    () => assertStepOrder(reordered, "publish", ["verify", "promote"], { final: "promote" }),
    /verify must precede promote/u,
  );
});

test("cross-job phase chains require a real dependency path", () => {
  const candidate = workflow([{ id: "freeze", run: "echo freeze" }]);
  candidate.jobs.mutate = {
    needs: ["publish"],
    "runs-on": "ubuntu-24.04",
    steps: [{ id: "mutate", run: "echo mutate" }],
  };
  candidate.jobs.promote = {
    needs: ["mutate"],
    "runs-on": "ubuntu-24.04",
    steps: [{ id: "promote", run: "echo promote" }],
  };
  assert.doesNotThrow(() => assertPhaseChain(candidate, [
    "publish.freeze",
    "mutate.mutate",
    "promote.promote",
  ]));

  candidate.jobs.promote.needs = ["publish"];
  assert.throws(
    () => assertPhaseChain(candidate, ["mutate.mutate", "promote.promote"]),
    /through step order or the job DAG/u,
  );
});

test("remote actions must use immutable revisions", () => {
  for (const uses of ["actions/checkout@v4", `actions/checkout@${"z".repeat(64)}`]) {
    const mutable = workflow([{ id: "checkout", uses }]);
    assert.throws(
      () => assertPinnedActions(mutable, "fixture"),
      /immutable commit\/digest/u,
    );
  }
  const pinned = workflow([{
    id: "checkout",
    uses: "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd",
  }]);
  assert.doesNotThrow(() => assertPinnedActions(pinned, "fixture"));
});
