import { describe, expect, test } from "bun:test";

import { detectLinuxLibc } from "./detect-linux-libc.mjs";

describe("WASIX Node-API Linux libc detection", () => {
  test("recognizes glibc from the runtime diagnostic header", () => {
    expect(detectLinuxLibc({
      report: { header: { glibcVersionRuntime: "2.38" }, sharedObjects: [] },
      versions: {},
    })).toBe("glibc");
  });

  test("recognizes musl from an explicit runtime version or loader", () => {
    expect(detectLinuxLibc({ report: {}, versions: { musl: "1.2.5" } })).toBe("musl");
    expect(detectLinuxLibc({
      report: { header: {}, sharedObjects: ["/lib/ld-musl-x86_64.so.1"] },
      versions: {},
    })).toBe("musl");
  });

  test("does not guess when diagnostics identify neither libc", () => {
    expect(detectLinuxLibc({ report: { header: {}, sharedObjects: [] }, versions: {} }))
      .toBe("unknown");
  });
});
