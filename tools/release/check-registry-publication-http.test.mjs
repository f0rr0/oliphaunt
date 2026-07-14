import { describe, expect, test } from "bun:test";

import { readBoundedRegistryJson } from "./check_registry_publication.mjs";

describe("registry publication HTTP response boundary", () => {
  test("parses a response only within the configured byte limit", async () => {
    await expect(readBoundedRegistryJson(Response.json({ present: true }), "registry", 64))
      .resolves.toEqual({ present: true });
    await expect(readBoundedRegistryJson(new Response("{}", {
      headers: { "content-length": "65" },
    }), "registry", 64)).rejects.toThrow("registry response exceeds 64 bytes");
  });

  test("rejects streamed overflow and malformed JSON deterministically", async () => {
    await expect(readBoundedRegistryJson(new Response("12345"), "registry", 4))
      .rejects.toThrow("registry response exceeds 4 bytes");
    await expect(readBoundedRegistryJson(new Response("not-json"), "registry", 64))
      .rejects.toThrow("registry returned invalid JSON");
  });
});
