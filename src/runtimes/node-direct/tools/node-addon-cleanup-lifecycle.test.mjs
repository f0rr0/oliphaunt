import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} from "node:worker_threads";

const scriptPath = fileURLToPath(import.meta.url);
const workspaceRoot = path.resolve(path.dirname(scriptPath), "../../../..");
const require = createRequire(import.meta.url);
const streamFixtureRequest = Object.freeze({
  normal: 0x01,
  failRecovery: 0xf1,
  unknownAfterCallback: 0xf2,
  successAfterCallback: 0xf3,
  abortWithoutCallback: 0xf4,
  failureWithoutCallback: 0xf5,
  unknownWithoutCallback: 0xf6,
});

async function bundleSdkCleanupRuntime(outputDirectory) {
  const clientSource = path.join(workspaceRoot, "src/sdks/js/src/client.ts");
  const nodeBindingSource = path.join(workspaceRoot, "src/sdks/js/src/native/node.ts");
  const sdkPackageJson = path.join(workspaceRoot, "src/sdks/js/package.json");
  const result = spawnSync(
    "bun",
    [
      "build",
      clientSource,
      nodeBindingSource,
      "--target=node",
      "--format=esm",
      "--entry-naming=[dir]/[name].mjs",
      `--outdir=${outputDirectory}`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(
    result.error,
    undefined,
    `could not bundle the SDK cleanup fixture: ${result.error?.message ?? "unknown error"}`,
  );
  assert.equal(
    result.signal,
    null,
    `SDK cleanup fixture bundler terminated by ${result.signal}\n${result.stderr}`,
  );
  assert.equal(
    result.status,
    0,
    `SDK cleanup fixture bundling failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );

  const clientBundle = path.join(outputDirectory, "client.mjs");
  const nodeBindingBundle = path.join(outputDirectory, "native", "node.mjs");
  assert.ok(existsSync(clientBundle), `SDK cleanup client bundle is missing: ${clientBundle}`);
  assert.ok(
    existsSync(nodeBindingBundle),
    `SDK cleanup Node binding bundle is missing: ${nodeBindingBundle}`,
  );
  const bundledPackageRoot = path.join(
    outputDirectory,
    "node_modules",
    "@oliphaunt",
    "ts",
  );
  await mkdir(bundledPackageRoot, { recursive: true });
  await copyFile(sdkPackageJson, path.join(bundledPackageRoot, "package.json"));
  return { clientBundle, nodeBindingBundle };
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`invalid cleanup lifecycle argument: ${key ?? "<missing>"}`);
    }
    const name = key
      .slice(2)
      .replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
    parsed[name] = value;
  }
  return parsed;
}

function loadAddon(addonPath) {
  return require(addonPath);
}

async function openFake(addon, libraryPath, root) {
  return addon.open({
    libraryPath,
    pgdata: path.join(root, "pgdata"),
    runtimeDirectory: path.join(root, "runtime"),
    username: "postgres",
    database: "postgres",
    startupArgs: [],
  });
}

function eventsFrom(logPath) {
  if (!existsSync(logPath)) {
    return [];
  }
  return readFileSync(logPath, "utf8")
    .split(/\r?\n/u)
    .filter((entry) => entry.length > 0);
}

function waitForWorkerMessage(worker, expectedMessage) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("messageerror", onMessageError);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };
    const fail = (error, terminate = true) => {
      cleanup();
      reject(error);
      if (terminate) {
        void worker.terminate();
      }
    };
    const onMessage = (received) => {
      try {
        assert.equal(received, expectedMessage);
        cleanup();
        resolve(received);
      } catch (error) {
        fail(error);
      }
    };
    const onMessageError = (error) => {
      fail(error instanceof Error ? error : new Error("cleanup lifecycle worker message failed"));
    };
    const onError = (error) => {
      fail(error);
    };
    const onExit = (code) => {
      fail(
        new Error(
          `cleanup lifecycle worker exited with status ${code} before ${expectedMessage}`,
        ),
        false,
      );
    };
    worker.once("message", onMessage);
    worker.once("messageerror", onMessageError);
    worker.once("error", onError);
    worker.once("exit", onExit);
  });
}

function observeWorkerExit(worker) {
  return new Promise((resolve) => {
    let workerError;
    worker.once("error", (error) => {
      workerError = error;
    });
    worker.once("exit", (code) => {
      resolve({ code, error: workerError });
    });
  });
}

async function requireWorkerExit(exitObservation, expectedCode) {
  const { code, error } = await exitObservation;
  if (error !== undefined) {
    throw error;
  }
  assert.equal(code, expectedCode, "cleanup lifecycle worker exit status");
}

async function runWorker() {
  const { role, addonPath, libraryPath, root } = workerData;
  const addon = loadAddon(addonPath);
  if (role === "load-only") {
    parentPort.postMessage("loaded");
    parentPort.close();
    return;
  }
  if (role === "open-and-detach") {
    const handle = await openFake(addon, libraryPath, root);
    await addon.detach(handle);
    parentPort.postMessage("detached");
    await new Promise((resolve) => {
      parentPort.once("message", (message) => {
        assert.equal(message, "finish");
        resolve();
      });
    });
    parentPort.close();
    return;
  }
  if (role === "open-and-wait") {
    globalThis.__oliphauntCleanupLifecycleWorkerHandle = await openFake(
      addon,
      libraryPath,
      root,
    );
    parentPort.postMessage("opened");
    await new Promise((resolve) => {
      parentPort.once("message", resolve);
    });
    return;
  }
  if (role === "open-with-active-query") {
    const handle = await openFake(addon, libraryPath, root);
    globalThis.__oliphauntCleanupRaceHandle = handle;
    globalThis.__oliphauntCleanupRaceOperation = addon
      .execProtocolRaw(handle, new Uint8Array([1]))
      .catch(() => undefined);
    parentPort.postMessage("queued");
    return;
  }
  if (role === "open-with-queued-query") {
    const handle = await openFake(addon, libraryPath, root);
    globalThis.__oliphauntCleanupRaceHandle = handle;
    globalThis.__oliphauntCleanupRaceOperation = addon
      .execProtocolRaw(handle, new Uint8Array([1]))
      .catch(() => undefined);
    parentPort.postMessage("queued");
    return;
  }
  if (role === "open-with-active-stream") {
    const handle = await openFake(addon, libraryPath, root);
    globalThis.__oliphauntCleanupRaceHandle = handle;
    globalThis.__oliphauntCleanupRaceOperation = addon
      .execProtocolRawStream(handle, new Uint8Array([1]), () => undefined)
      .catch(() => undefined);
    parentPort.postMessage("queued");
    return;
  }
  if (role === "open-with-stream-call-blocked") {
    const handle = await openFake(addon, libraryPath, root);
    globalThis.__oliphauntCleanupRaceHandle = handle;
    globalThis.__oliphauntCleanupRaceOperation = addon
      .execProtocolRawStream(handle, new Uint8Array([1]), () => {
        assert.fail("the prefilled callback queue must not drain before Worker teardown");
      })
      .catch(() => undefined);
    parentPort.postMessage("queued");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
    return;
  }
  if (role === "open-with-stream-delivery-wait") {
    const handle = await openFake(addon, libraryPath, root);
    globalThis.__oliphauntCleanupRaceHandle = handle;
    globalThis.__oliphauntCleanupRaceOperation = addon
      .execProtocolRawStream(handle, new Uint8Array([1]), () => {
        assert.fail("the admitted callback must remain queued until Worker teardown");
      })
      .catch(() => undefined);
    parentPort.postMessage("queued");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
    return;
  }
  if (role === "open-with-active-backup") {
    const handle = await openFake(addon, libraryPath, root);
    globalThis.__oliphauntCleanupRaceHandle = handle;
    globalThis.__oliphauntCleanupRaceOperation = addon.backup(handle).catch(() => undefined);
    parentPort.postMessage("queued");
    return;
  }
  throw new Error(`unknown cleanup lifecycle worker role: ${role}`);
}

async function collectGarbageUntilCollected(signal) {
  assert.equal(typeof globalThis.gc, "function", "GC lifecycle child must run with --expose-gc");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    globalThis.gc();
    await new Promise((resolve) => setImmediate(resolve));
    if (signal.collected) {
      return;
    }
  }
  throw new Error("Node did not collect the unreachable native handle after 200 forced GC cycles");
}

async function openAfterForgottenOwnerRecovery(client, config) {
  assert.equal(typeof globalThis.gc, "function", "GC lifecycle child must run with --expose-gc");
  let lastAdmissionError;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    globalThis.gc();
    await new Promise((resolve) => setImmediate(resolve));
    try {
      return await client.open(config);
    } catch (error) {
      if (!/native direct already has an active process-wide instance/u.test(String(error))) {
        throw error;
      }
      lastAdmissionError = error;
    }
  }
  throw new Error("forgotten native owner did not release its exact JavaScript admission lease", {
    cause: lastAdmissionError,
  });
}

async function prepareManagedDatabaseRoot(root) {
  await mkdir(path.join(root, "pgdata", "global"), { recursive: true });
  await mkdir(path.join(root, "pgdata", "pg_wal"), { recursive: true });
  await writeFile(path.join(root, "pgdata", "PG_VERSION"), "18\n");
  await writeFile(path.join(root, "pgdata", "global", "pg_control"), "control");
  await writeFile(
    path.join(root, ".oliphaunt.json"),
    `${JSON.stringify({
      schema: "oliphaunt-database-root-v1",
      engineFamily: "native",
      pgdata: "pgdata",
      postgresMajor: 18,
      physicalFormat: "native-pg18-v1",
    })}\n`,
  );
}

function observeCollection(value) {
  const signal = { collected: false, registry: undefined };
  signal.registry = new FinalizationRegistry(() => {
    signal.collected = true;
  });
  signal.registry.register(value, undefined);
  return signal;
}

async function waitForEvent(logPath, expectedEvent) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (eventsFrom(logPath).includes(expectedEvent)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`native lifecycle event did not arrive: ${expectedEvent}`);
}

async function runChild(options) {
  const copiedImageScenario = options.scenario.startsWith("copied-image-");
  const addon = copiedImageScenario ? undefined : loadAddon(options.addon);
  switch (options.scenario) {
    case "invalid-library-path": {
      assert.throws(
        () => addon.version(""),
        /liboliphaunt path must not be empty/u,
      );
      assert.throws(
        () => addon.version(`${options.library}\0ignored-suffix`),
        /liboliphaunt path must not contain a null byte/u,
      );
      return;
    }
    case "explicit-detach":
    case "unicode-library-path": {
      const handle = await openFake(addon, options.library, options.root);
      await addon.detach(handle);
      return;
    }
    case "active-exit": {
      globalThis.__oliphauntCleanupLifecycleHandle = await openFake(
        addon,
        options.library,
        options.root,
      );
      return;
    }
    case "forced-process-exit-active": {
      globalThis.__oliphauntCleanupLifecycleHandle = await openFake(
        addon,
        options.library,
        options.root,
      );
      // Node intentionally bypasses N-API environment cleanup hooks here.
      // The real liboliphaunt process-level atexit handler owns this abrupt
      // process teardown; this addon fixture must not claim otherwise.
      process.exit(0);
    }
    case "gc-finalizer": {
      let handle = await openFake(addon, options.library, options.root);
      const collection = observeCollection(handle);
      handle = undefined;
      assert.equal(handle, undefined);
      await collectGarbageUntilCollected(collection);
      const reopened = await openFake(addon, options.library, options.root);
      await addon.detach(reopened);
      return;
    }
    case "gc-detach-recovery": {
      let handle = await openFake(addon, options.library, options.root);
      const collection = observeCollection(handle);
      handle = undefined;
      assert.equal(handle, undefined);
      await collectGarbageUntilCollected(collection);
      await assert.rejects(
        openFake(addon, options.library, options.root),
        /could not recover the previous logical handle/u,
      );
      const recovered = await openFake(addon, options.library, options.root);
      await addon.detach(recovered);
      assert.equal(
        eventsFrom(options.log).includes("init-while-active"),
        false,
        "reopen must recover the retained failed-detach owner before init",
      );
      return;
    }
    case "sdk-gc-owner-recovery": {
      const [{ createOliphauntClient }, { createNodeNativeBinding }] = await Promise.all([
        import(pathToFileURL(options.sdkClientBundle)),
        import(pathToFileURL(options.sdkNodeBindingBundle)),
      ]);
      const databaseRoot = path.join(options.root, "database");
      const runtimeDirectory = path.join(options.root, "runtime");
      await Promise.all([
        prepareManagedDatabaseRoot(databaseRoot),
        mkdir(runtimeDirectory, { recursive: true }),
      ]);
      const client = createOliphauntClient((bindingOptions) =>
        createNodeNativeBinding({
          ...bindingOptions,
          nodeAddonPath: options.addon,
        }),
      );
      const config = {
        storage: { kind: "directory", path: databaseRoot },
        libraryPath: options.library,
        runtimeDirectory,
      };

      let forgotten = await client.open(config);
      const forgottenCollection = observeCollection(forgotten);
      forgotten = undefined;
      let reopened = await openAfterForgottenOwnerRecovery(client, config);
      assert.equal(
        forgottenCollection.collected,
        true,
        "the next open must follow collection of the forgotten public database",
      );

      let retired = reopened;
      reopened = undefined;
      await retired.close();
      const current = await client.open(config);
      const retiredCollection = observeCollection(retired);
      retired = undefined;
      await collectGarbageUntilCollected(retiredCollection);
      await assert.rejects(
        client.open(config),
        /native direct already has an active process-wide instance/u,
        "collection of an older explicitly closed owner must not release the current lease",
      );
      await current.close();
      return;
    }
    case "forgotten-token-generation-guard": {
      const staleHandle = await openFake(addon, options.library, options.root);
      const staleToken = addon.createForgottenHandleRecoveryToken(staleHandle);
      await addon.detach(staleHandle);

      let currentHandle = await openFake(addon, options.library, options.root);
      const currentToken = addon.createForgottenHandleRecoveryToken(currentHandle);
      assert.equal(
        addon.queueForgottenHandleRecovery(staleToken),
        false,
        "a recovery token from an older logical generation must not mark the current owner",
      );
      assert.equal(
        addon.queueForgottenHandleRecovery(currentToken),
        true,
        "the current logical generation must be marked for next-open recovery",
      );
      currentHandle = undefined;
      const recovered = await openFake(addon, options.library, options.root);
      await addon.detach(recovered);
      return;
    }
    case "async-query-cancel": {
      const handle = await openFake(addon, options.library, options.root);
      const query = addon.execProtocolRaw(handle, new Uint8Array([1]));
      assert.equal(query instanceof Promise, true, "native query must return a Promise");
      await waitForEvent(options.log, "query-started");
      addon.cancel(handle);
      await assert.rejects(query, /fake query was cancelled/u);
      await addon.detach(handle);
      return;
    }
    case "async-archive-timers": {
      const handle = await openFake(addon, options.library, options.root);
      let backupSettled = false;
      const backup = addon.backup(handle).finally(() => {
        backupSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(backupSettled, false, "backup must not block the Node.js event loop");
      assert.deepEqual([...await backup], [1, 2, 3]);

      let restoreSettled = false;
      const restore = addon.restore({
        libraryPath: options.library,
        destination: path.join(options.root, "restored"),
        bytes: new Uint8Array([1, 2, 3]),
      }).finally(() => {
        restoreSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(restoreSettled, false, "restore must not block the Node.js event loop");
      await restore;
      await addon.detach(handle);
      return;
    }
    case "async-open-stream-detach-timers": {
      let openSettled = false;
      const opening = openFake(addon, options.library, options.root).finally(() => {
        openSettled = true;
      });
      assert.equal(opening instanceof Promise, true, "native open must return a Promise");
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(openSettled, false, "open must not block the Node.js event loop");
      const handle = await opening;

      const chunks = [];
      let streamSettled = false;
      const streaming = addon
        .execProtocolRawStream(handle, new Uint8Array([1]), (chunk) => {
          chunks.push([...chunk]);
        })
        .finally(() => {
          streamSettled = true;
        });
      assert.equal(streaming instanceof Promise, true, "native stream must return a Promise");
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(streamSettled, false, "streaming must not block the Node.js event loop");
      await streaming;
      assert.deepEqual(chunks, [[1, 2], [3, 4], [5, 6]]);

      let detachSettled = false;
      const detaching = addon.detach(handle).finally(() => {
        detachSettled = true;
      });
      assert.equal(detaching instanceof Promise, true, "native detach must return a Promise");
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(detachSettled, false, "detach must not block the Node.js event loop");
      await detaching;
      return;
    }
    case "async-stream-callback-contract": {
      const handle = await openFake(addon, options.library, options.root);
      await assert.rejects(
        addon.execProtocolRawStream(
          handle,
          new Uint8Array([streamFixtureRequest.normal]),
          () => Promise.resolve(),
        ),
        /must complete synchronously.*Promise or thenable/u,
      );
      await assert.rejects(
        addon.execProtocolRawStream(handle, new Uint8Array([streamFixtureRequest.normal]), () => {
          throw new Error("stream consumer failed");
        }),
        /stream consumer failed/u,
      );
      const callbackObject = { kind: "stream callback object identity" };
      for (const callbackFailure of [
        "stream callback string",
        73,
        Number.NaN,
        undefined,
        callbackObject,
      ]) {
        const outcome = await addon
          .execProtocolRawStream(handle, new Uint8Array([streamFixtureRequest.normal]), () => {
            throw callbackFailure;
          })
          .then(
            () => ({ rejected: false, error: undefined }),
            (error) => ({ rejected: true, error }),
          );
        assert.equal(outcome.rejected, true, "a failed stream callback must reject");
        assert.equal(
          Object.is(outcome.error, callbackFailure),
          true,
          "a recovered callback abort must preserve the exact JavaScript throw value",
        );
      }
      await assert.rejects(
        addon.execProtocolRawStream(
          handle,
          new Uint8Array([streamFixtureRequest.failRecovery]),
          () => {
            throw new Error("secondary stream consumer failure");
          },
        ),
        /native liboliphaunt protocol streaming failed: fake stream recovery failed/u,
        "an unconfirmed native recovery must take precedence over the callback exception",
      );
      await assert.rejects(
        addon.execProtocolRawStream(
          handle,
          new Uint8Array([streamFixtureRequest.unknownAfterCallback]),
          () => {
            throw new Error("tertiary stream consumer failure");
          },
        ),
        /native liboliphaunt protocol streaming failed: fake stream returned an unknown positive status/u,
        "an unknown positive native status must take precedence over the callback exception",
      );
      const successMismatchCallback = new Error(
        "a success mismatch must not escape as a recovered callback failure",
      );
      await assert.rejects(
        addon.execProtocolRawStream(
          handle,
          new Uint8Array([streamFixtureRequest.successAfterCallback]),
          () => {
            throw successMismatchCallback;
          },
        ),
        (error) => {
          assert.notStrictEqual(
            error,
            successMismatchCallback,
            "native success after callback failure is authoritative adapter failure",
          );
          assert.match(String(error), /reported success after the callback failed/u);
          return true;
        },
      );
      let callbackCalled = false;
      await assert.rejects(
        addon.execProtocolRawStream(
          handle,
          new Uint8Array([streamFixtureRequest.abortWithoutCallback]),
          () => {
            callbackCalled = true;
          },
        ),
        /native liboliphaunt protocol streaming failed: fake stream reported callback abort without callback failure/u,
        "CALLBACK_ABORTED without a recorded callback failure is native/ABI failure",
      );
      assert.equal(callbackCalled, false);
      await assert.rejects(
        addon.execProtocolRawStream(
          handle,
          new Uint8Array([streamFixtureRequest.failureWithoutCallback]),
          () => {
            assert.fail("native failure before delivery must not call the stream callback");
          },
        ),
        /native liboliphaunt protocol streaming failed: fake stream failed before callback delivery/u,
      );
      await assert.rejects(
        addon.execProtocolRawStream(
          handle,
          new Uint8Array([streamFixtureRequest.unknownWithoutCallback]),
          () => {
            assert.fail("unknown native status before delivery must not call the stream callback");
          },
        ),
        /native liboliphaunt protocol streaming failed: fake stream returned an unknown status before callback delivery/u,
      );
      await addon.detach(handle);
      return;
    }
    case "generation-acquisition-race": {
      await assert.rejects(
        () => openFake(addon, options.library, options.root),
        /native liboliphaunt init returned an invalid logical generation/u,
        "open must fail closed when the resident handle closes before generation acquisition",
      );
      return;
    }
    case "alias-path": {
      const first = await openFake(addon, options.library, options.root);
      await addon.detach(first);
      const aliasPath = `${path.dirname(options.library)}${path.sep}.${path.sep}${path.basename(options.library)}`;
      assert.notEqual(aliasPath, options.library);
      const second = await openFake(addon, aliasPath, options.root);
      await addon.detach(second);
      return;
    }
    case "load-only-worker": {
      const handle = await openFake(addon, options.library, options.root);
      const worker = new Worker(scriptPath, {
        workerData: {
          role: "load-only",
          addonPath: options.addon,
          libraryPath: options.library,
          root: path.join(options.root, "worker"),
        },
      });
      const workerExit = observeWorkerExit(worker);
      await waitForWorkerMessage(worker, "loaded");
      await requireWorkerExit(workerExit, 0);
      assert.deepEqual(
        eventsFrom(options.log),
        ["init"],
        "an environment that only loads the addon must not close another environment's runtime",
      );
      await addon.detach(handle);
      return;
    }
    case "ownership-transfer": {
      const worker = new Worker(scriptPath, {
        workerData: {
          role: "open-and-detach",
          addonPath: options.addon,
          libraryPath: options.library,
          root: path.join(options.root, "worker"),
        },
      });
      const workerExit = observeWorkerExit(worker);
      await waitForWorkerMessage(worker, "detached");
      const handle = await openFake(addon, options.library, options.root);
      worker.postMessage("finish");
      await requireWorkerExit(workerExit, 0);
      assert.deepEqual(
        eventsFrom(options.log),
        ["init", "detach", "init"],
        "the previous owner environment must not close a runtime after ownership transfers",
      );
      await addon.detach(handle);
      return;
    }
    case "worker-terminate-active": {
      const worker = new Worker(scriptPath, {
        workerData: {
          role: "open-and-wait",
          addonPath: options.addon,
          libraryPath: options.library,
          root: path.join(options.root, "worker"),
        },
      });
      const workerExit = observeWorkerExit(worker);
      await waitForWorkerMessage(worker, "opened");
      assert.equal(await worker.terminate(), 1);
      await requireWorkerExit(workerExit, 1);
      assert.deepEqual(
        eventsFrom(options.log),
        ["init", "close"],
        "worker.terminate() must run the owning Node environment cleanup hook",
      );
      return;
    }
    case "worker-terminate-query":
    case "worker-terminate-query-entry-race":
    case "worker-terminate-backup": {
      const entryRace = options.scenario === "worker-terminate-query-entry-race";
      const operation = entryRace
        ? "query"
        : options.scenario.slice("worker-terminate-".length);
      const worker = new Worker(scriptPath, {
        workerData: {
          role: `open-with-active-${operation}`,
          addonPath: options.addon,
          libraryPath: options.library,
          root: path.join(options.root, "worker"),
        },
      });
      const workerExit = observeWorkerExit(worker);
      await waitForWorkerMessage(worker, "queued");
      if (!entryRace) {
        await waitForEvent(options.log, `${operation}-started`);
      }
      assert.equal(await worker.terminate(), 1);
      await requireWorkerExit(workerExit, 1);
      return;
    }
    case "worker-terminate-query-alias": {
      const aliasPath = `${path.dirname(options.library)}${path.sep}.${path.sep}${path.basename(options.library)}`;
      addon.version(aliasPath);
      const worker = new Worker(scriptPath, {
        workerData: {
          role: "open-with-active-query",
          addonPath: options.addon,
          libraryPath: options.library,
          root: path.join(options.root, "worker"),
        },
      });
      const workerExit = observeWorkerExit(worker);
      await waitForWorkerMessage(worker, "queued");
      await waitForEvent(options.log, "query-started");
      assert.equal(await worker.terminate(), 1);
      await requireWorkerExit(workerExit, 1);
      return;
    }
    case "worker-terminate-stream-call-blocked":
    case "worker-terminate-stream-delivery-wait": {
      const deliveryWait = options.scenario.endsWith("delivery-wait");
      const worker = new Worker(scriptPath, {
        workerData: {
          role: deliveryWait
            ? "open-with-stream-delivery-wait"
            : "open-with-stream-call-blocked",
          addonPath: options.addon,
          libraryPath: options.library,
          root: path.join(options.root, "worker"),
        },
      });
      const workerExit = observeWorkerExit(worker);
      await waitForWorkerMessage(worker, "queued");
      // The fake runtime emits this only when its call into StreamChunk remains
      // blocked for 50ms. The call-blocked case prefills the max-one queue, so
      // the producer is inside blocking Push. The delivery-wait case leaves the
      // queue empty but blocks the Worker event loop, so Push admits the chunk
      // and StreamChunk can wake only from the teardown abort.
      await waitForEvent(options.log, "stream-callback-blocked");
      assert.equal(await worker.terminate(), 1);
      await requireWorkerExit(workerExit, 1);
      return;
    }
    case "worker-terminate-queued-query": {
      const worker = new Worker(scriptPath, {
        workerData: {
          role: "open-with-queued-query",
          addonPath: options.addon,
          libraryPath: options.library,
          root: path.join(options.root, "worker"),
        },
      });
      const workerExit = observeWorkerExit(worker);
      await waitForWorkerMessage(worker, "queued");
      // The addon fixture delays the dedicated native thread before Execute,
      // so cleanup must retire the registered pending count without relying on
      // a JS Complete callback that can no longer run.
      assert.equal(await worker.terminate(), 1);
      await requireWorkerExit(workerExit, 1);
      return;
    }
    case "copied-image-same-env-active":
    case "copied-image-same-env-detached": {
      const firstAddon = loadAddon(options.addonCopyA);
      const secondAddon = loadAddon(options.addonCopyB);
      const firstHandle = await openFake(
        firstAddon,
        options.library,
        path.join(options.root, "first"),
      );
      await firstAddon.detach(firstHandle);
      const secondHandle = await openFake(
        secondAddon,
        options.library,
        path.join(options.root, "second"),
      );
      if (options.scenario.endsWith("-detached")) {
        await secondAddon.detach(secondHandle);
      } else {
        globalThis.__oliphauntCopiedImageCurrentHandle = secondHandle;
      }
      return;
    }
    case "copied-image-worker-main-active":
    case "copied-image-worker-main-detached": {
      const worker = new Worker(scriptPath, {
        workerData: {
          role: "open-and-detach",
          addonPath: options.addonCopyA,
          libraryPath: options.library,
          root: path.join(options.root, "worker"),
        },
      });
      const workerExit = observeWorkerExit(worker);
      await waitForWorkerMessage(worker, "detached");
      const mainAddon = loadAddon(options.addonCopyB);
      const mainHandle = await openFake(
        mainAddon,
        options.library,
        path.join(options.root, "main"),
      );
      const currentOwnerDetached = options.scenario.endsWith("-detached");
      if (currentOwnerDetached) {
        await mainAddon.detach(mainHandle);
      } else {
        globalThis.__oliphauntCopiedImageCurrentHandle = mainHandle;
      }
      worker.postMessage("finish");
      await requireWorkerExit(workerExit, 0);
      assert.deepEqual(
        eventsFrom(options.log),
        [
          "init",
          "detach",
          "init",
          ...(currentOwnerDetached ? ["detach"] : []),
          "close-stale",
        ],
        "cleanup from the copied worker image must not close the main image's current generation",
      );
      return;
    }
    case "copied-image-worker-terminate-stale": {
      const worker = new Worker(scriptPath, {
        workerData: {
          role: "open-and-detach",
          addonPath: options.addonCopyA,
          libraryPath: options.library,
          root: path.join(options.root, "worker"),
        },
      });
      const workerExit = observeWorkerExit(worker);
      await waitForWorkerMessage(worker, "detached");
      const mainAddon = loadAddon(options.addonCopyB);
      globalThis.__oliphauntCopiedImageCurrentHandle = await openFake(
        mainAddon,
        options.library,
        path.join(options.root, "main"),
      );
      assert.equal(await worker.terminate(), 1);
      await requireWorkerExit(workerExit, 1);
      assert.deepEqual(
        eventsFrom(options.log),
        ["init", "detach", "init", "close-stale"],
        "terminated stale addon cleanup must not close the current copied-image generation",
      );
      return;
    }
    default:
      throw new Error(`unknown cleanup lifecycle scenario: ${options.scenario}`);
  }
}

function assertTerminalLifecycle(scenario, events, expectedBeforeClose) {
  assert.deepEqual(
    events,
    [...expectedBeforeClose, "close"],
    `${scenario} must terminally close exactly once during Node environment cleanup`,
  );
  assert.equal(events.includes("close-after-close"), false);
  assert.equal(events.includes("detach-after-close"), false);
  assert.equal(events.includes("close-unguarded"), false);
  assert.equal(events.includes("close-guard-invalid"), false);
}

function assertCopiedImageLifecycle(
  scenario,
  events,
  expectedBeforeCleanup,
  expectStaleCleanup,
) {
  assert.deepEqual(
    events.slice(0, expectedBeforeCleanup.length),
    expectedBeforeCleanup,
    `${scenario} must complete its logical ownership transfer before cleanup`,
  );
  const cleanupEvents = events.slice(expectedBeforeCleanup.length).toSorted();
  if (expectStaleCleanup) {
    assert.deepEqual(
      cleanupEvents,
      ["close", "close-stale"],
      `${scenario} must close the current generation once and reject one stale cleanup`,
    );
  } else {
    assert.deepEqual(
      cleanupEvents,
      cleanupEvents.includes("close-stale")
        ? ["close", "close-stale"]
        : ["close"],
      `${scenario} must close exactly once; an older token may observe the already-spent process`,
    );
  }
  assert.equal(events.includes("close-unguarded"), false);
  assert.equal(events.includes("close-guard-invalid"), false);
  assert.equal(events.includes("close-after-close"), false);
  assert.equal(events.includes("detach-after-close"), false);
}

function assertGenerationAcquisitionRace(scenario, events) {
  assert.deepEqual(
    events,
    ["init", "close-before-generation"],
    `${scenario} must not dereference a handle after generation acquisition reports it stale`,
  );
  assert.equal(events.includes("close-unguarded"), false);
  assert.equal(events.includes("close-guard-invalid"), false);
  assert.equal(events.includes("close-after-close"), false);
  assert.equal(events.includes("detach-after-close"), false);
}

async function runParent(options) {
  for (const candidate of [options.addon, options.instrumentedAddon, options.library]) {
    assert.ok(path.isAbsolute(candidate), `cleanup lifecycle input must be absolute: ${candidate}`);
    assert.ok(existsSync(candidate), `cleanup lifecycle input does not exist: ${candidate}`);
  }

  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "oliphaunt-node-cleanup-"));
  let singleImageCases = 0;
  let copiedImageCases = 0;
  let staleAcquisitionCases = 0;
  try {
    const sdkBundleDirectory = path.join(temporaryRoot, "sdk-bundle");
    const { clientBundle, nodeBindingBundle } = await bundleSdkCleanupRuntime(
      sdkBundleDirectory,
    );
    const copiedAddonA = path.join(temporaryRoot, "oliphaunt-node-copy-a.node");
    const copiedAddonB = path.join(temporaryRoot, "oliphaunt-node-copy-b.node");
    const unicodeLibraryDirectory = path.join(temporaryRoot, "unicode-λ-路径");
    const unicodeLibrary = path.join(
      unicodeLibraryDirectory,
      path.basename(options.library),
    );
    await mkdir(unicodeLibraryDirectory, { recursive: true });
    await Promise.all([
      copyFile(options.addon, copiedAddonA),
      copyFile(options.addon, copiedAddonB),
      copyFile(options.library, unicodeLibrary),
    ]);
    const scenarios = [
      {
        name: "explicit-detach",
        expectedBeforeClose: ["init", "detach"],
        iterations: 12,
      },
      {
        name: "active-exit",
        expectedBeforeClose: ["init"],
        iterations: 12,
      },
      {
        name: "forced-process-exit-active",
        expectedAbruptExit: ["init"],
      },
      {
        name: "unicode-library-path",
        expectedBeforeClose: ["init", "detach"],
        library: unicodeLibrary,
      },
      {
        name: "invalid-library-path",
        expectedNoEvents: true,
      },
      {
        name: "gc-finalizer",
        expectedBeforeClose: ["init", "detach", "init", "detach"],
        exposeGc: true,
      },
      {
        name: "gc-detach-recovery",
        expectedBeforeClose: ["init", "detach-failed", "detach", "init", "detach"],
        exposeGc: true,
        failDetachOnce: true,
      },
      {
        name: "sdk-gc-owner-recovery",
        expectedBeforeClose: ["init", "detach", "init", "detach", "init", "detach"],
        exposeGc: true,
      },
      {
        name: "forgotten-token-generation-guard",
        expectedBeforeClose: ["init", "detach", "init", "detach", "init", "detach"],
      },
      {
        name: "async-query-cancel",
        expectedBeforeClose: ["init", "query-started", "cancel", "query-cancelled", "detach"],
        blockQuery: true,
      },
      {
        name: "async-archive-timers",
        expectedBeforeClose: [
          "init",
          "backup-started",
          "backup-finished",
          "restore-started",
          "restore-finished",
          "detach",
        ],
        blockArchive: true,
      },
      {
        name: "async-open-stream-detach-timers",
        expectedBeforeClose: [
          "open-started",
          "open-finished",
          "init",
          "stream-started",
          "stream-finished",
          "detach-started",
          "detach-finished",
          "detach",
        ],
        blockOpen: true,
        blockStream: true,
        blockDetach: true,
      },
      {
        name: "async-stream-callback-contract",
        expectedBeforeClose: [
          "init",
          ...Array.from(
            { length: 7 },
            () => ["stream-started", "stream-aborted"],
          ).flat(),
          "stream-started",
          "stream-aborted",
          "stream-recovery-failed",
          "stream-started",
          "stream-aborted",
          "stream-unknown-status",
          "stream-started",
          "stream-aborted",
          "stream-success-after-callback-abort",
          "stream-started",
          "stream-abort-without-callback",
          "stream-started",
          "stream-failure-without-callback",
          "stream-started",
          "stream-unknown-without-callback",
          "detach",
        ],
        blockStream: true,
      },
      {
        name: "generation-acquisition-race",
        generationAcquisitionRace: true,
      },
      {
        name: "alias-path",
        expectedBeforeClose: ["init", "detach", "init", "detach"],
      },
      {
        name: "load-only-worker",
        expectedBeforeClose: ["init", "detach"],
      },
      {
        name: "ownership-transfer",
        expectedBeforeClose: ["init", "detach", "init", "detach"],
      },
      {
        name: "worker-terminate-active",
        expectedBeforeClose: ["init"],
      },
      {
        name: "worker-terminate-query",
        expectedBeforeClose: ["init", "query-started", "cancel", "query-cancelled"],
        blockQuery: true,
        iterations: 3,
      },
      {
        name: "worker-terminate-query-entry-race",
        expectedBeforeClose: [
          "init",
          "cancel-early-ignored",
          "query-started",
          "cancel",
          "query-cancelled",
        ],
        blockQuery: true,
        ignoreEarlyCancel: true,
        pauseNativeCallEntry: true,
        usesAddonTestHooks: true,
        iterations: 3,
      },
      {
        name: "worker-terminate-query-alias",
        expectedBeforeClose: ["init", "query-started", "cancel", "query-cancelled"],
        blockQuery: true,
        recordRepeatCancel: true,
      },
      {
        name: "worker-terminate-queued-query",
        expectedBeforeClose: ["init"],
        delayOperationStart: true,
        usesAddonTestHooks: true,
        iterations: 3,
      },
      {
        name: "worker-terminate-stream-call-blocked",
        expectedBeforeClose: [
          "init",
          "stream-started",
          "stream-callback-blocked",
          "stream-aborted",
        ],
        blockStream: true,
        prefillStreamQueue: true,
        observeBlockedStreamCallback: true,
        usesAddonTestHooks: true,
        iterations: 3,
      },
      {
        name: "worker-terminate-stream-delivery-wait",
        expectedBeforeClose: [
          "init",
          "stream-started",
          "stream-callback-blocked",
          "stream-aborted",
        ],
        blockStream: true,
        observeBlockedStreamCallback: true,
        iterations: 3,
      },
      {
        name: "worker-terminate-backup",
        expectedBeforeClose: ["init", "backup-started", "backup-finished"],
        blockArchive: true,
        iterations: 3,
      },
      {
        name: "copied-image-same-env-active",
        expectedBeforeCleanup: ["init", "detach", "init"],
      },
      {
        name: "copied-image-same-env-detached",
        expectedBeforeCleanup: ["init", "detach", "init", "detach"],
      },
      {
        name: "copied-image-worker-main-active",
        expectedBeforeCleanup: ["init", "detach", "init"],
        expectStaleCleanup: true,
      },
      {
        name: "copied-image-worker-main-detached",
        expectedBeforeCleanup: ["init", "detach", "init", "detach"],
        expectStaleCleanup: true,
      },
      {
        name: "copied-image-worker-terminate-stale",
        expectedBeforeClose: ["init", "detach", "init", "close-stale"],
      },
    ];

    for (const scenario of scenarios) {
      const iterations = scenario.iterations ?? 1;
      for (let iteration = 1; iteration <= iterations; iteration += 1) {
        if (scenario.generationAcquisitionRace) {
          staleAcquisitionCases += 1;
        } else if (scenario.name.startsWith("copied-image-")) {
          copiedImageCases += 1;
        } else {
          singleImageCases += 1;
        }
        const executionName = iterations === 1
          ? scenario.name
          : `${scenario.name}-${iteration}-of-${iterations}`;
        const scenarioAddon = scenario.usesAddonTestHooks
          ? options.instrumentedAddon
          : options.addon;
        const scenarioRoot = path.join(temporaryRoot, executionName);
        const logPath = path.join(temporaryRoot, `${executionName}.log`);
        const childArgs = [
          ...(scenario.exposeGc ? ["--expose-gc"] : []),
          scriptPath,
          "--scenario",
          scenario.name,
          "--addon",
          scenarioAddon,
          "--addon-copy-a",
          copiedAddonA,
          "--addon-copy-b",
          copiedAddonB,
          "--library",
          scenario.library ?? options.library,
          "--root",
          scenarioRoot,
          "--log",
          logPath,
          "--sdk-client-bundle",
          clientBundle,
          "--sdk-node-binding-bundle",
          nodeBindingBundle,
        ];
        const child = spawnSync(process.execPath, childArgs, {
          encoding: "utf8",
          env: {
            ...process.env,
            OLIPHAUNT_NODE_CLEANUP_TEST_LOG: logPath,
            ...(scenario.generationAcquisitionRace
              ? { OLIPHAUNT_NODE_CLEANUP_TEST_CLOSE_BEFORE_GENERATION: "1" }
              : {}),
            ...(scenario.failDetachOnce
              ? { OLIPHAUNT_NODE_CLEANUP_TEST_FAIL_DETACH_ONCE: "1" }
              : {}),
            ...(scenario.blockQuery
              ? { OLIPHAUNT_NODE_CLEANUP_TEST_BLOCK_QUERY: "1" }
              : {}),
            ...(scenario.blockArchive
              ? { OLIPHAUNT_NODE_CLEANUP_TEST_BLOCK_ARCHIVE: "1" }
              : {}),
            ...(scenario.blockOpen
              ? { OLIPHAUNT_NODE_CLEANUP_TEST_BLOCK_OPEN: "1" }
              : {}),
            ...(scenario.blockStream
              ? { OLIPHAUNT_NODE_CLEANUP_TEST_BLOCK_STREAM: "1" }
              : {}),
            ...(scenario.blockDetach
              ? { OLIPHAUNT_NODE_CLEANUP_TEST_BLOCK_DETACH: "1" }
              : {}),
            ...(scenario.delayOperationStart
              ? { OLIPHAUNT_NODE_CLEANUP_TEST_DELAY_OPERATION_START: "1" }
              : {}),
            ...(scenario.pauseNativeCallEntry
              ? { OLIPHAUNT_NODE_CLEANUP_TEST_PAUSE_NATIVE_CALL_ENTRY: "1" }
              : {}),
            ...(scenario.ignoreEarlyCancel
              ? { OLIPHAUNT_NODE_CLEANUP_TEST_IGNORE_EARLY_CANCEL: "1" }
              : {}),
            ...(scenario.prefillStreamQueue
              ? { OLIPHAUNT_NODE_CLEANUP_TEST_PREFILL_STREAM_QUEUE: "1" }
              : {}),
            ...(scenario.observeBlockedStreamCallback
              ? { OLIPHAUNT_NODE_CLEANUP_TEST_OBSERVE_BLOCKED_STREAM_CALLBACK: "1" }
              : {}),
            ...(scenario.recordRepeatCancel
              ? { OLIPHAUNT_NODE_CLEANUP_TEST_RECORD_REPEAT_CANCEL: "1" }
              : {}),
          },
          timeout: 30_000,
        });
        assert.equal(
          child.error,
          undefined,
          `${executionName} child could not run: ${child.error?.message ?? "unknown error"}`,
        );
        assert.equal(
          child.signal,
          null,
          `${executionName} child terminated by ${child.signal}\n${child.stderr}`,
        );
        assert.equal(
          child.status,
          0,
          `${executionName} child failed\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`,
        );
        const events = eventsFrom(logPath);
        if (scenario.expectedNoEvents) {
          assert.deepEqual(events, [], `${executionName} must not load a library image`);
        } else if (scenario.expectedAbruptExit !== undefined) {
          assert.deepEqual(
            events,
            scenario.expectedAbruptExit,
            `${executionName} must defer cleanup to process teardown`,
          );
        } else if (scenario.generationAcquisitionRace) {
          assertGenerationAcquisitionRace(executionName, events);
        } else if (scenario.expectedBeforeCleanup !== undefined) {
          assertCopiedImageLifecycle(
            executionName,
            events,
            scenario.expectedBeforeCleanup,
            scenario.expectStaleCleanup ?? false,
          );
        } else {
          assertTerminalLifecycle(executionName, events, scenario.expectedBeforeClose);
        }
      }
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  console.log(
    `Node direct environment cleanup lifecycle passed (${singleImageCases} single-image + ${copiedImageCases} copied-image + ${staleAcquisitionCases} stale-acquisition cases)`,
  );
}

if (!isMainThread) {
  await runWorker();
} else {
  const options = parseArgs(process.argv.slice(2));
  if (options.scenario !== undefined) {
    await runChild(options);
  } else {
    await runParent(options);
  }
}
