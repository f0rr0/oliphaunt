import { describe, expect, test } from "bun:test";

import { executeNormalPublicationPlan } from "./normal-publication-executor.mjs";

function operation(ecosystem, index, carrierId = `${ecosystem}:package-${index}`) {
  return {
    id: `carrier:${carrierId}`,
    kind: "carrier",
    ecosystem,
    carrierId,
    operationOrder: index,
  };
}

function tokenFetch(methods, tokens = ["cargo-token"]) {
  let tokenIndex = 0;
  return async (_url, init) => {
    methods.push(init.method);
    if (init.method === "GET") return Response.json({ value: `jwt-${tokenIndex}` });
    if (init.method === "POST") return Response.json({ token: tokens[tokenIndex++] ?? `token-${tokenIndex}` });
    return new Response("", { status: 200 });
  };
}

const tokenEnvironment = {
  GITHUB_ACTIONS: "true",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://pipelines.actions.example/token",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
};

describe("normal publication executor", () => {
  test("executes lock-derived operations and gives Maven one atomic callback", async () => {
    const calls = [];
    const plan = {
      operations: [
        operation("npm", 0),
        {
          id: "maven:atomic-deployment",
          kind: "maven-atomic-deployment",
          ecosystem: "maven",
          carrierIds: ["maven:a", "maven:b"],
          operationOrder: 1,
        },
        operation("jsr", 2),
      ],
    };
    await executeNormalPublicationPlan({
      plan,
      cargoVersionPublished: () => { throw new Error("must not inspect Cargo"); },
      publishCarrier: async ({ carrierId }) => calls.push(carrierId),
      publishMaven: async ({ carrierIds }) => calls.push(carrierIds.join("+")),
    });
    expect(calls).toEqual(["npm:package-0", "maven:a+maven:b", "jsr:package-2"]);
  });

  test("does not acquire a token for lock-matching published Cargo carriers", async () => {
    const calls = [];
    await executeNormalPublicationPlan({
      plan: { operations: [operation("cargo", 0), operation("cargo", 1)] },
      cargoVersionPublished: async () => true,
      publishCarrier: async ({ carrierId }, context) => calls.push({ carrierId, context }),
      publishMaven: () => { throw new Error("must not publish Maven"); },
      tokenOptions: { fetchImpl: () => { throw new Error("must not acquire token"); } },
    });
    expect(calls).toEqual([
      { carrierId: "cargo:package-0", context: { alreadyPublished: true } },
      { carrierId: "cargo:package-1", context: { alreadyPublished: true } },
    ]);
  });

  test("uses fresh masked and revoked tokens for bounded contiguous Cargo batches", async () => {
    const methods = [];
    const masks = [];
    const calls = [];
    await executeNormalPublicationPlan({
      plan: { operations: [0, 1, 2, 3, 4].map((index) => operation("cargo", index)) },
      cargoVersionPublished: async () => false,
      publishCarrier: async ({ carrierId }, context) => calls.push({ carrierId, ...context }),
      publishMaven: () => { throw new Error("must not publish Maven"); },
      batchSize: 2,
      nowImpl: () => 1000,
      tokenOptions: {
        env: tokenEnvironment,
        fetchImpl: tokenFetch(methods, ["token-a", "token-b", "token-c"]),
        maskImpl: (value) => masks.push(value),
      },
    });
    expect(methods).toEqual(["GET", "POST", "DELETE", "GET", "POST", "DELETE", "GET", "POST", "DELETE"]);
    expect(masks).toEqual(["::add-mask::token-a\n", "::add-mask::token-b\n", "::add-mask::token-c\n"]);
    expect(calls.map(({ cargoToken }) => cargoToken)).toEqual(["token-a", "token-a", "token-b", "token-b", "token-c"]);
    expect(new Set(calls.map(({ tokenDeadlineEpochMs }) => tokenDeadlineEpochMs))).toEqual(new Set([1_201_000]));
  });

  test("releases the temporary token after a carrier failure", async () => {
    const methods = [];
    await expect(executeNormalPublicationPlan({
      plan: { operations: [operation("cargo", 0)] },
      cargoVersionPublished: async () => false,
      publishCarrier: async () => { throw new Error("upload failed"); },
      publishMaven: () => { throw new Error("must not publish Maven"); },
      tokenOptions: {
        env: tokenEnvironment,
        fetchImpl: tokenFetch(methods),
        maskImpl: () => {},
      },
    })).rejects.toThrow("upload failed");
    expect(methods).toEqual(["GET", "POST", "DELETE"]);
  });

  test("rejects malformed plans and oversized batches before mutation", async () => {
    const callbacks = {
      cargoVersionPublished: () => { throw new Error("must not inspect"); },
      publishCarrier: () => { throw new Error("must not publish"); },
      publishMaven: () => { throw new Error("must not publish"); },
    };
    await expect(executeNormalPublicationPlan({
      plan: { operations: [{ ...operation("cargo", 0), operationOrder: 2 }] },
      ...callbacks,
    })).rejects.toThrow("contiguous canonical order");
    await expect(executeNormalPublicationPlan({
      plan: { operations: [] },
      batchSize: 21,
      ...callbacks,
    })).rejects.toThrow("from 1 through 20");
  });
});
