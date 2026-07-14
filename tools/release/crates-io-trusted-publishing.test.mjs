import { describe, expect, test } from "bun:test";

import {
  acquireCratesIoTrustedPublishingToken,
  revokeCratesIoTrustedPublishingToken,
  withCratesIoTrustedPublishingToken,
} from "./crates-io-trusted-publishing.mjs";

const ENV = {
  GITHUB_ACTIONS: "true",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://pipelines.actions.example/id-token?api-version=1",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "github-request-secret",
};

function response(value, init = {}) {
  return new Response(value === undefined ? "" : JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("crates.io trusted-publishing token broker", () => {
  test("requests a fresh crates.io-audience JWT, exchanges it, and masks the temporary token", async () => {
    const calls = [];
    const masks = [];
    const session = await acquireCratesIoTrustedPublishingToken({
      env: ENV,
      nowImpl: () => 123_000,
      maskImpl: (command) => masks.push(command),
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        if (calls.length === 1) return response({ value: "one-use-jwt" });
        return response({ token: "temporary%cargo-token" });
      },
    });
    expect(new URL(calls[0].url).searchParams.get("audience")).toBe("crates.io");
    expect(calls[0].url).toStartWith("https://pipelines.actions.example/");
    expect(calls[0].init).toMatchObject({ method: "GET", redirect: "error" });
    expect(new Headers(calls[0].init.headers).get("authorization")).toBe("Bearer github-request-secret");
    expect(calls[1].url).toBe("https://crates.io/api/v1/trusted_publishing/tokens");
    expect(calls[1].init).toMatchObject({ method: "POST", redirect: "error", body: JSON.stringify({ jwt: "one-use-jwt" }) });
    expect(session).toEqual({ token: "temporary%cargo-token", acquiredAt: 123_000, expiresAt: 1_923_000 });
    expect(masks).toEqual(["::add-mask::temporary%25cargo-token\n"]);
  });

  test("revokes the same in-memory token with a bounded non-redirecting request", async () => {
    let call;
    await revokeCratesIoTrustedPublishingToken("temporary-token", {
      fetchImpl: async (url, init) => {
        call = { url: String(url), init };
        return new Response("", { status: 200 });
      },
    });
    expect(call.url).toBe("https://crates.io/api/v1/trusted_publishing/tokens");
    expect(call.init).toMatchObject({ method: "DELETE", redirect: "error" });
    expect(new Headers(call.init.headers).get("authorization")).toBe("Bearer temporary-token");
  });

  test("revokes in finally when publication fails", async () => {
    const methods = [];
    await expect(withCratesIoTrustedPublishingToken(async () => {
      throw new Error("publish failed");
    }, {
      env: ENV,
      maskImpl: () => {},
      fetchImpl: async (_url, init) => {
        methods.push(init.method);
        if (init.method === "GET") return response({ value: "jwt" });
        if (init.method === "POST") return response({ token: "token" });
        return new Response("", { status: 200 });
      },
    })).rejects.toThrow("publish failed");
    expect(methods).toEqual(["GET", "POST", "DELETE"]);
  });

  test("makes revoke failure terminal even after a publish failure", async () => {
    let thrown;
    try {
      await withCratesIoTrustedPublishingToken(async () => {
        throw new Error("publish failed");
      }, {
        env: ENV,
        maskImpl: () => {},
        fetchImpl: async (_url, init) => {
          if (init.method === "GET") return response({ value: "jwt" });
          if (init.method === "POST") return response({ token: "token" });
          return response({ errors: [] }, { status: 503 });
        },
      });
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    expect(thrown.errors.map(({ message }) => message)).toEqual([
      "publish failed",
      "crates-io-trusted-publishing: crates.io trusted-publishing token revoke returned HTTP 503",
    ]);
  });

  test("rejects non-Actions use, insecure request URLs, timeouts, and malformed responses", async () => {
    await expect(acquireCratesIoTrustedPublishingToken({ env: {}, fetchImpl: () => { throw new Error("must not call"); } }))
      .rejects.toThrow("only inside GitHub Actions");
    await expect(acquireCratesIoTrustedPublishingToken({
      env: { ...ENV, ACTIONS_ID_TOKEN_REQUEST_URL: "http://actions.invalid/token" },
      fetchImpl: () => { throw new Error("must not call"); },
    })).rejects.toThrow("must use HTTPS");
    await expect(acquireCratesIoTrustedPublishingToken({ env: ENV, timeoutMs: 0 }))
      .rejects.toThrow("timeoutMs");
    await expect(acquireCratesIoTrustedPublishingToken({
      env: ENV,
      fetchImpl: async () => response({ nope: "jwt" }),
    })).rejects.toThrow("invalid secret");
  });

  test("bounds response bodies before parsing", async () => {
    await expect(acquireCratesIoTrustedPublishingToken({
      env: ENV,
      fetchImpl: async () => new Response("x", { headers: { "Content-Length": "70000" } }),
    })).rejects.toThrow("response exceeds 65536 bytes");
  });
});
