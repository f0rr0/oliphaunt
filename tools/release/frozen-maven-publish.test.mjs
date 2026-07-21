import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  assertMavenCentralBundleSize,
  prepareFrozenMavenBundle,
  publishFrozenMavenBundle,
  verifyGpgSigningCredentials,
} from "./frozen-maven-publish.mjs";

const temporaryDirectories = [];
const root = path.join(import.meta.dir, "../..");
const testDeadlineEpochSeconds = 2_000;
const testNow = () => 1_000_000;

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function fixtureLock() {
  const directory = mkdtempSync(path.join(root, "target/frozen-maven-test-"));
  temporaryDirectories.push(directory);
  const jar = path.join(directory, "fixture-1.2.3.jar");
  const pom = path.join(directory, "fixture-1.2.3.pom");
  const sources = path.join(directory, "fixture-1.2.3-sources.jar");
  const javadocs = path.join(directory, "fixture-1.2.3-javadoc.jar");
  writeFileSync(jar, "exact frozen jar bytes\n");
  writeFileSync(sources, "exact frozen sources placeholder\n");
  writeFileSync(javadocs, "exact frozen javadocs placeholder\n");
  writeFileSync(pom, "<project><modelVersion>4.0.0</modelVersion><groupId>dev.oliphaunt</groupId><artifactId>fixture</artifactId><version>1.2.3</version><name>Fixture</name><description>Fixture publication</description><url>https://github.com/f0rr0/oliphaunt</url><licenses><license><name>MIT</name><url>https://opensource.org/license/mit</url></license></licenses><developers><developer><name>Fixture Maintainer</name><url>https://github.com/f0rr0</url></developer></developers><scm><connection>scm:git:https://github.com/f0rr0/oliphaunt.git</connection><developerConnection>scm:git:ssh://git@github.com:f0rr0/oliphaunt.git</developerConnection><url>https://github.com/f0rr0/oliphaunt</url></scm></project>\n");
  const envelope = (file) => ({
    path: path.relative(root, file).split(path.sep).join("/"),
    sha256: sha256(file),
    size: statSync(file).size,
  });
  return {
    directory,
    jar,
    lock: {
      lockDigest: "a".repeat(64),
      carriers: [{
        id: "maven:dev.oliphaunt:fixture",
        product: "fixture-product",
        ecosystem: "maven",
        name: "dev.oliphaunt:fixture",
        version: "1.2.3",
        publishOrder: 0,
        artifacts: [envelope(jar), envelope(pom), envelope(sources), envelope(javadocs)],
      }],
    },
  };
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

describe("frozen Maven Central publication", () => {
  test("preflights the configured signing key, passphrase, signature, and fingerprint", () => {
    const home = mkdtempSync(path.join(root, "target/frozen-maven-gpg-preflight-test-"));
    temporaryDirectories.push(home);
    const signingFingerprint = "A".repeat(40);
    const primaryFingerprint = signingFingerprint;
    const calls = [];
    const result = verifyGpgSigningCredentials({
      privateKey: "armored private key",
      keyId: `0x${primaryFingerprint.slice(-16)}`,
      passphrase: "correct passphrase",
      home,
      runImpl(args, options) {
        calls.push({ args, options });
        if (args.includes("--verify")) {
          return `[GNUPG:] VALIDSIG ${signingFingerprint} 2026-07-20 0 4 0 1 10 00 ${primaryFingerprint}\n`;
        }
        return "";
      },
    });
    expect(result).toEqual({ signerFingerprint: signingFingerprint, primaryFingerprint });
    expect(calls.map(({ args }) => args.includes("--import")
      ? "import"
      : args.includes("--detach-sign")
        ? "sign"
        : args.includes("--verify")
          ? "verify"
          : "unexpected")).toEqual(["import", "sign", "verify"]);
    expect(calls[0].options.input).toBe("armored private key");
    expect(calls[1].options.input).toBe("correct passphrase\n");
  });

  test("rejects a verified signature from a different configured key ID", () => {
    const home = mkdtempSync(path.join(root, "target/frozen-maven-gpg-mismatch-test-"));
    temporaryDirectories.push(home);
    expect(() => verifyGpgSigningCredentials({
      privateKey: "armored private key",
      keyId: "C".repeat(16),
      passphrase: "correct passphrase",
      home,
      runImpl(args) {
        if (args.includes("--verify")) {
          return `[GNUPG:] VALIDSIG ${"A".repeat(40)} 2026-07-20 0 4 0 1 10 00 ${"A".repeat(40)}\n`;
        }
        return "";
      },
    })).toThrow("configured Maven signing key ID does not match");
  });

  test("rejects a valid signature made by a signing subkey", () => {
    const home = mkdtempSync(path.join(root, "target/frozen-maven-gpg-subkey-test-"));
    temporaryDirectories.push(home);
    expect(() => verifyGpgSigningCredentials({
      privateKey: "armored private key",
      keyId: "B".repeat(16),
      passphrase: "correct passphrase",
      home,
      runImpl(args) {
        if (args.includes("--verify")) {
          return `[GNUPG:] VALIDSIG ${"A".repeat(40)} 2026-07-20 0 4 0 1 10 00 ${"B".repeat(40)}\n`;
        }
        return "";
      },
    })).toThrow("requires artifacts to be signed by the primary OpenPGP key");
  });

  test("rejects malformed key selectors before importing signing material", () => {
    const home = mkdtempSync(path.join(root, "target/frozen-maven-gpg-key-id-test-"));
    temporaryDirectories.push(home);
    let calls = 0;
    expect(() => verifyGpgSigningCredentials({
      privateKey: "armored private key",
      keyId: "release@example.invalid",
      passphrase: "correct passphrase",
      home,
      runImpl() {
        calls += 1;
        return "";
      },
    })).toThrow("8-64 hexadecimal characters");
    expect(calls).toBe(0);
  });

  test("bundles exact locked payloads and generates only signatures and checksums", () => {
    const { directory, jar, lock } = fixtureLock();
    const outputRoot = path.join(directory, "output");
    mkdirSync(outputRoot, { recursive: true });
    const result = prepareFrozenMavenBundle({
      lock,
      products: ["fixture-product"],
      outputRoot,
      signFile(file, signature) {
        writeFileSync(signature, `signature:${sha256(file)}\n`);
      },
    });
    const staged = path.join(result.layout, "dev/oliphaunt/fixture/1.2.3/fixture-1.2.3.jar");
    expect(readFileSync(staged)).toEqual(readFileSync(jar));
    expect(readFileSync(`${staged}.md5`, "utf8")).toMatch(/^[0-9a-f]{32}$/u);
    expect(readFileSync(`${staged}.sha1`, "utf8")).toMatch(/^[0-9a-f]{40}$/u);
    expect(readFileSync(`${staged}.asc`, "utf8")).toContain(`signature:${sha256(jar)}`);
    expect(statSync(result.bundle).size).toBeGreaterThan(0);
    expect(result.bundleSize).toBe(statSync(result.bundle).size);
  });

  test("rejects a deployment bundle larger than the Central portal limit", () => {
    expect(() => assertMavenCentralBundleSize(1_000_000_001)).toThrow("smaller than 1000000000 bytes");
    expect(() => assertMavenCentralBundleSize(1_000_000_000)).toThrow("smaller than 1000000000 bytes");
    expect(() => assertMavenCentralBundleSize(100, 99)).toThrow("smaller than 99 bytes");
    expect(() => assertMavenCentralBundleSize(100, 100)).toThrow("smaller than 100 bytes");
    expect(() => assertMavenCentralBundleSize(99, 100)).not.toThrow();
  });

  test("uses a user-managed, lock-named deployment before explicit promotion", async () => {
    const directory = mkdtempSync(path.join(root, "target/frozen-maven-api-test-"));
    temporaryDirectories.push(directory);
    const bundle = path.join(directory, "bundle.zip");
    writeFileSync(bundle, "bundle bytes");
    const calls = [];
    let statusCalls = 0;
    const fetchImpl = async (rawUrl, init) => {
      const url = new URL(rawUrl);
      calls.push({ url, init });
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer dXNlcjpwYXNz");
      if (url.pathname.endsWith("/deployments")) {
        return Response.json({ deployments: [], page: 0, pageSize: 100, pageCount: 0, totalResultCount: 0 });
      }
      if (url.pathname.endsWith("/upload")) {
        expect(url.searchParams.get("publishingType")).toBe("USER_MANAGED");
        expect(url.searchParams.get("name")).toMatch(/^oliphaunt-b{16}-[0-9a-f]{12}$/u);
        expect(init.body.get("bundle")).toBeInstanceOf(Blob);
        return new Response("28570f16-da32-4c14-bd2e-c1acc0782365", { status: 201 });
      }
      if (url.pathname.endsWith("/status")) {
        statusCalls += 1;
        return Response.json({
          deploymentId: "28570f16-da32-4c14-bd2e-c1acc0782365",
          deploymentState: statusCalls === 1 ? "VALIDATED" : "PUBLISHED",
        });
      }
      if (url.pathname.includes("/deployment/")) {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected URL ${url}`);
    };
    const result = await publishFrozenMavenBundle({
      bundle,
      lockDigest: "b".repeat(64),
      deploymentScope: "fixture-product",
      namespace: "dev.oliphaunt",
      username: "user",
      password: "pass",
      deadlineEpochSeconds: testDeadlineEpochSeconds,
      apiBase: "https://central.invalid/api/v1/publisher",
      fetchImpl,
      nowImpl: testNow,
      sleep: async () => {},
    });
    expect(result.deploymentId).toBe("28570f16-da32-4c14-bd2e-c1acc0782365");
    expect(result.status.deploymentState).toBe("PUBLISHED");
    expect(calls.map(({ url, init }) => `${init.method}:${url.pathname.split("/").at(-1)}`)).toEqual([
      "GET:deployments",
      "POST:upload",
      "POST:status",
      "POST:28570f16-da32-4c14-bd2e-c1acc0782365",
      "POST:status",
    ]);
  });

  test("drops an existing failed deployment, verifies removal, and re-uploads the frozen bundle", async () => {
    const directory = mkdtempSync(path.join(root, "target/frozen-maven-failed-retry-test-"));
    temporaryDirectories.push(directory);
    const bundle = path.join(directory, "bundle.zip");
    writeFileSync(bundle, "exact frozen bundle bytes");
    const failedId = "11111111-1111-4111-8111-111111111111";
    const retriedId = "22222222-2222-4222-8222-222222222222";
    const calls = [];
    let deploymentListCalls = 0;
    let retriedStatusCalls = 0;
    let deploymentName;
    const fetchImpl = async (rawUrl, init) => {
      const url = new URL(rawUrl);
      calls.push({ url, init });
      if (url.pathname.endsWith("/deployments")) {
        deploymentListCalls += 1;
        return Response.json({
          deployments: deploymentListCalls === 1
            ? [{
              deploymentId: failedId,
              deploymentName: url.searchParams.get("name") ?? deploymentName,
              deploymentState: "FAILED",
            }]
            : [],
        });
      }
      if (url.pathname.endsWith("/status")) {
        const id = url.searchParams.get("id");
        if (id === failedId) {
          return Response.json({
            deploymentId: failedId,
            deploymentName,
            deploymentState: "FAILED",
            errors: { bundle: ["validation failed"] },
          });
        }
        expect(id).toBe(retriedId);
        retriedStatusCalls += 1;
        return Response.json({
          deploymentId: retriedId,
          deploymentName,
          deploymentState: retriedStatusCalls === 1 ? "VALIDATED" : "PUBLISHED",
        });
      }
      if (url.pathname.endsWith(`/deployment/${failedId}`)) {
        expect(init.method).toBe("DELETE");
        return new Response(null, { status: 204 });
      }
      if (url.pathname.endsWith("/upload")) {
        expect(init.method).toBe("POST");
        deploymentName = url.searchParams.get("name");
        expect(deploymentName).toMatch(/^oliphaunt-c{16}-[0-9a-f]{12}$/u);
        expect(await init.body.get("bundle").text()).toBe("exact frozen bundle bytes");
        return new Response(retriedId, { status: 201 });
      }
      if (url.pathname.endsWith(`/deployment/${retriedId}`)) {
        expect(init.method).toBe("POST");
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected URL ${url}`);
    };
    deploymentName = `oliphaunt-${"c".repeat(16)}-${createHash("sha256").update("fixture-product").digest("hex").slice(0, 12)}`;
    const result = await publishFrozenMavenBundle({
      bundle,
      lockDigest: "c".repeat(64),
      deploymentScope: "fixture-product",
      namespace: "dev.oliphaunt",
      username: "user",
      password: "pass",
      deadlineEpochSeconds: testDeadlineEpochSeconds,
      apiBase: "https://central.invalid/api/v1/publisher",
      fetchImpl,
      nowImpl: testNow,
      sleep: async () => {},
    });
    expect(result.deploymentId).toBe(retriedId);
    expect(result.status.deploymentState).toBe("PUBLISHED");
    expect(calls.map(({ url, init }) => `${init.method}:${url.pathname}`)).toEqual([
      "GET:/api/v1/publisher/deployments",
      "POST:/api/v1/publisher/status",
      `DELETE:/api/v1/publisher/deployment/${failedId}`,
      "GET:/api/v1/publisher/deployments",
      "POST:/api/v1/publisher/upload",
      "POST:/api/v1/publisher/status",
      `POST:/api/v1/publisher/deployment/${retriedId}`,
      "POST:/api/v1/publisher/status",
    ]);
  });

  test("refuses to drop a failed deployment when the status identity does not match", async () => {
    const directory = mkdtempSync(path.join(root, "target/frozen-maven-failed-identity-test-"));
    temporaryDirectories.push(directory);
    const bundle = path.join(directory, "bundle.zip");
    writeFileSync(bundle, "exact frozen bundle bytes");
    const id = "44444444-4444-4444-8444-444444444444";
    const calls = [];
    const expectedDeploymentName = `oliphaunt-${"e".repeat(16)}-${createHash("sha256").update("fixture-product").digest("hex").slice(0, 12)}`;
    const fetchImpl = async (rawUrl, init) => {
      const url = new URL(rawUrl);
      calls.push({ url, init });
      if (url.pathname.endsWith("/deployments")) {
        return Response.json({
          deployments: [{
            deploymentId: id,
            deploymentName: expectedDeploymentName,
            deploymentState: "FAILED",
          }],
        });
      }
      if (url.pathname.endsWith("/status")) {
        return Response.json({
          deploymentId: "55555555-5555-4555-8555-555555555555",
          deploymentName: expectedDeploymentName,
          deploymentState: "FAILED",
        });
      }
      throw new Error(`unsafe mutation attempted: ${init.method} ${url}`);
    };
    await expect(publishFrozenMavenBundle({
      bundle,
      lockDigest: "e".repeat(64),
      deploymentScope: "fixture-product",
      namespace: "dev.oliphaunt",
      username: "user",
      password: "pass",
      deadlineEpochSeconds: testDeadlineEpochSeconds,
      apiBase: "https://central.invalid/api/v1/publisher",
      fetchImpl,
      nowImpl: testNow,
      sleep: async () => {},
    })).rejects.toThrow("refusing to drop failed Maven Central deployment");
    expect(calls.every(({ url }) => url.pathname.endsWith("/deployments") || url.pathname.endsWith("/status"))).toBe(true);
  });

  for (const existingState of ["PUBLISHING", "PUBLISHED"]) {
    test(`reuses an existing ${existingState} deployment without deleting or re-uploading`, async () => {
      const directory = mkdtempSync(path.join(root, `target/frozen-maven-${existingState.toLowerCase()}-test-`));
      temporaryDirectories.push(directory);
      const bundle = path.join(directory, "bundle.zip");
      writeFileSync(bundle, "exact frozen bundle bytes");
      const id = "33333333-3333-4333-8333-333333333333";
      const expectedDeploymentName = `oliphaunt-${"d".repeat(16)}-${createHash("sha256").update("fixture-product").digest("hex").slice(0, 12)}`;
      const calls = [];
      let statusCalls = 0;
      const fetchImpl = async (rawUrl, init) => {
        const url = new URL(rawUrl);
        calls.push({ url, init });
        if (url.pathname.endsWith("/deployments")) {
          return Response.json({
            deployments: [{
              deploymentId: id,
              deploymentName: expectedDeploymentName,
              deploymentState: existingState,
            }],
          });
        }
        if (url.pathname.endsWith("/status")) {
          statusCalls += 1;
          return Response.json({
            deploymentId: id,
            deploymentState: statusCalls === 1 ? existingState : "PUBLISHED",
          });
        }
        throw new Error(`unsafe mutation attempted for ${existingState}: ${init.method} ${url}`);
      };
      const result = await publishFrozenMavenBundle({
        bundle,
        lockDigest: "d".repeat(64),
        deploymentScope: "fixture-product",
        namespace: "dev.oliphaunt",
        username: "user",
        password: "pass",
        deadlineEpochSeconds: testDeadlineEpochSeconds,
        apiBase: "https://central.invalid/api/v1/publisher",
        fetchImpl,
        nowImpl: testNow,
        sleep: async () => {},
      });
      expect(result.deploymentId).toBe(id);
      expect(result.status.deploymentState).toBe("PUBLISHED");
      expect(calls.every(({ url }) => url.pathname.endsWith("/deployments") || url.pathname.endsWith("/status"))).toBe(true);
      expect(calls.some(({ url, init }) => init.method === "DELETE" || url.pathname.endsWith("/upload"))).toBe(false);
    });
  }

  test("rejects mutation before bundle creation", () => {
    const { directory, jar, lock } = fixtureLock();
    writeFileSync(jar, "regenerated jar bytes\n");
    expect(() => prepareFrozenMavenBundle({
      lock,
      products: ["fixture-product"],
      outputRoot: path.join(directory, "output"),
      signFile() {},
    })).toThrow("bytes do not match");
  });

  test("rejects an oversized Central response before upload", async () => {
    const directory = mkdtempSync(path.join(root, "target/frozen-maven-oversized-response-test-"));
    temporaryDirectories.push(directory);
    const bundle = path.join(directory, "bundle.zip");
    writeFileSync(bundle, "exact frozen bundle bytes");
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response("x", {
        status: 200,
        headers: { "content-length": String(1024 * 1024 + 1) },
      });
    };
    await expect(publishFrozenMavenBundle({
      bundle,
      lockDigest: "f".repeat(64),
      deploymentScope: "fixture-product",
      namespace: "dev.oliphaunt",
      username: "user",
      password: "pass",
      deadlineEpochSeconds: testDeadlineEpochSeconds,
      apiBase: "https://central.invalid/api/v1/publisher",
      fetchImpl,
      nowImpl: testNow,
      sleep: async () => {},
    })).rejects.toThrow("Maven Central response exceeds");
    expect(calls).toBe(1);
  });

  test("refuses requests and visibility waits that cannot fit the shared deadline", async () => {
    const directory = mkdtempSync(path.join(root, "target/frozen-maven-deadline-test-"));
    temporaryDirectories.push(directory);
    const bundle = path.join(directory, "bundle.zip");
    writeFileSync(bundle, "exact frozen bundle bytes");
    let calls = 0;

    await expect(publishFrozenMavenBundle({
      bundle,
      lockDigest: "1".repeat(64),
      deploymentScope: "fixture-product",
      namespace: "dev.oliphaunt",
      username: "user",
      password: "pass",
      deadlineEpochSeconds: 1_005,
      apiBase: "https://central.invalid/api/v1/publisher",
      fetchImpl: async () => {
        calls += 1;
        return Response.json({ deployments: [] });
      },
      nowImpl: () => 1_000_000,
      sleep: async () => {},
    })).rejects.toThrow(/shared registry mutation deadline has been reached/u);
    expect(calls).toBe(0);

    let now = 1_000_000;
    await expect(publishFrozenMavenBundle({
      bundle,
      lockDigest: "2".repeat(64),
      deploymentScope: "fixture-product",
      namespace: "dev.oliphaunt",
      username: "user",
      password: "pass",
      deadlineEpochSeconds: 1_020,
      apiBase: "https://central.invalid/api/v1/publisher",
      fetchImpl: async (rawUrl) => {
        const url = new URL(rawUrl);
        if (url.pathname.endsWith("/deployments")) {
          return Response.json({
            deployments: [{
              deploymentId: "33333333-3333-4333-8333-333333333333",
              deploymentName: `oliphaunt-${"2".repeat(16)}-${createHash("sha256").update("fixture-product").digest("hex").slice(0, 12)}`,
              deploymentState: "PUBLISHING",
            }],
          });
        }
        return Response.json({
          deploymentId: "33333333-3333-4333-8333-333333333333",
          deploymentState: "PUBLISHING",
        });
      },
      nowImpl: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
    })).rejects.toThrow(/cannot wait 10s before the shared registry mutation deadline/u);
  });
});
