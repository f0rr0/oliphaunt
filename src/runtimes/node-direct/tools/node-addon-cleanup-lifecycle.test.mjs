import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} from "node:worker_threads";

const scriptPath = fileURLToPath(import.meta.url);
const require = createRequire(import.meta.url);

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

function openFake(addon, libraryPath, root) {
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
    const handle = openFake(addon, libraryPath, root);
    addon.detach(handle);
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
    globalThis.__oliphauntCleanupLifecycleWorkerHandle = openFake(
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
  throw new Error(`unknown cleanup lifecycle worker role: ${role}`);
}

async function collectGarbageUntilFinalized(logPath) {
  assert.equal(typeof globalThis.gc, "function", "GC lifecycle child must run with --expose-gc");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    globalThis.gc();
    await new Promise((resolve) => setImmediate(resolve));
    if (eventsFrom(logPath).includes("detach")) {
      return;
    }
  }
  throw new Error("Node did not finalize the unreachable native handle after 200 forced GC cycles");
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
      const handle = openFake(addon, options.library, options.root);
      addon.detach(handle);
      return;
    }
    case "active-exit": {
      globalThis.__oliphauntCleanupLifecycleHandle = openFake(
        addon,
        options.library,
        options.root,
      );
      return;
    }
    case "forced-process-exit-active": {
      globalThis.__oliphauntCleanupLifecycleHandle = openFake(
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
      let handle = openFake(addon, options.library, options.root);
      handle = undefined;
      assert.equal(handle, undefined);
      await collectGarbageUntilFinalized(options.log);
      return;
    }
    case "generation-acquisition-race": {
      assert.throws(
        () => openFake(addon, options.library, options.root),
        /native liboliphaunt init returned an invalid logical generation/u,
        "open must fail closed when the resident handle closes before generation acquisition",
      );
      return;
    }
    case "alias-path": {
      const first = openFake(addon, options.library, options.root);
      addon.detach(first);
      const aliasPath = `${path.dirname(options.library)}${path.sep}.${path.sep}${path.basename(options.library)}`;
      assert.notEqual(aliasPath, options.library);
      const second = openFake(addon, aliasPath, options.root);
      addon.detach(second);
      return;
    }
    case "load-only-worker": {
      const handle = openFake(addon, options.library, options.root);
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
      addon.detach(handle);
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
      const handle = openFake(addon, options.library, options.root);
      worker.postMessage("finish");
      await requireWorkerExit(workerExit, 0);
      assert.deepEqual(
        eventsFrom(options.log),
        ["init", "detach", "init"],
        "the previous owner environment must not close a runtime after ownership transfers",
      );
      addon.detach(handle);
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
    case "copied-image-same-env-active":
    case "copied-image-same-env-detached": {
      const firstAddon = loadAddon(options.addonCopyA);
      const secondAddon = loadAddon(options.addonCopyB);
      const firstHandle = openFake(
        firstAddon,
        options.library,
        path.join(options.root, "first"),
      );
      firstAddon.detach(firstHandle);
      const secondHandle = openFake(
        secondAddon,
        options.library,
        path.join(options.root, "second"),
      );
      if (options.scenario.endsWith("-detached")) {
        secondAddon.detach(secondHandle);
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
      const mainHandle = openFake(
        mainAddon,
        options.library,
        path.join(options.root, "main"),
      );
      const currentOwnerDetached = options.scenario.endsWith("-detached");
      if (currentOwnerDetached) {
        mainAddon.detach(mainHandle);
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
      globalThis.__oliphauntCopiedImageCurrentHandle = openFake(
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
  for (const candidate of [options.addon, options.library]) {
    assert.ok(path.isAbsolute(candidate), `cleanup lifecycle input must be absolute: ${candidate}`);
    assert.ok(existsSync(candidate), `cleanup lifecycle input does not exist: ${candidate}`);
  }

  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "oliphaunt-node-cleanup-"));
  try {
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
        expectedBeforeClose: ["init", "detach"],
        exposeGc: true,
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
        const executionName = iterations === 1
          ? scenario.name
          : `${scenario.name}-${iteration}-of-${iterations}`;
        const scenarioRoot = path.join(temporaryRoot, executionName);
        const logPath = path.join(temporaryRoot, `${executionName}.log`);
        const childArgs = [
          ...(scenario.exposeGc ? ["--expose-gc"] : []),
          scriptPath,
          "--scenario",
          scenario.name,
          "--addon",
          options.addon,
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
        ];
        const child = spawnSync(process.execPath, childArgs, {
          encoding: "utf8",
          env: {
            ...process.env,
            OLIPHAUNT_NODE_CLEANUP_TEST_LOG: logPath,
            ...(scenario.generationAcquisitionRace
              ? { OLIPHAUNT_NODE_CLEANUP_TEST_CLOSE_BEFORE_GENERATION: "1" }
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
    "Node direct environment cleanup lifecycle passed (32 single-image + 5 copied-image + 1 stale-acquisition cases)",
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
