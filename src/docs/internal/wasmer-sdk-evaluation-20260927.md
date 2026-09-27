# Wasmer JavaScript SDK 0.18.0: bounded integration probe

Date: 2026-09-27. Decision: **worth a separate browser command/socket experiment;
not a drop-in replacement for our embedded browser host, and not a reason to
replace the Rust-backed Node N-API path.** No production dependencies changed.

## What actually ran

Installed published `@wasmer/sdk@0.18.0` in an isolated directory with install
scripts disabled. Used Node 24.18.0 and an already cached Chromium 148.0.7778.96;
no SDK, PostgreSQL, or browser rebuild was needed.

| Probe | Result |
| --- | --- |
| Node SDK, published `wasmer/pglite@=0.1.3`, native psql client | PASS: `42`, Unicode, division-by-zero followed by rollback and another successful query, 10,000 inserted rows/count, 1 MiB constructed value, clean server exit |
| Browser SDK, same server package and `wasmer/psql@=18.4.0`, explicit local peer | PASS: same SQL/error recovery, **1 MiB SQL request**, **8 MiB response**, successful following query, no truncation, clean server exit |
| Browser transport isolation | Cross-origin isolation enabled; **zero WebSocket connections** observed; SQL traffic stayed on SDK local TCP |
| Valid raw module exporting only `answer() -> 42` | Native WebAssembly invocation returned 42; SDK rejected loading it with `PACKAGE_LOAD_FAILED`: `WASI/WASIX commands require an exported _start function` |
| Browser PostgreSQL default-storage reopen | **Not persistent:** created/inserted/checkpointed table disappears even after clean process restart in the same live sandbox; a `/workspace` control file survives that restart |

Single-run whole-probe elapsed times were 3.91 seconds for the successful Node
run (package cache populated by an earlier attempt) and 9.87 seconds for the
fresh-browser run. These include acquisition/setup, execution and teardown;
**they are not query benchmarks, startup comparisons, or optimization claims.**
The browser emitted a harmless missing-resource 404 (favicon); all assertions
passed. The first Node attempt put recovery SQL in one `psql -c` string, which
correctly stops at its first error; separate commands fixed the probe itself.

## What the package is

`wasmer/pglite` here is **not ElectricSQL PGlite**. Upstream documents it as
PostgreSQL 18.4 rebuilt from an Oliphaunt runtime/source tree, with two extra
patches: a direct WASIX socket command and caller-local `sigsetjmp`/`setjmp`
handling. It was rebuilt using wasixcc 0.4.4 with standard Wasm exceptions.
The retained downloaded WEBC is 76,919,536 bytes.

It is a **single-backend, single-client process**, not a concurrent PostgreSQL
postmaster. It accepts one connection and exits after disconnect. The browser
example uses a sandbox in-memory filesystem; the successful probe says nothing
about crash durability, OPFS reopen, concurrent clients or our extension catalog.
[Upstream package provenance and patches](https://github.com/wasmerio/wasmer-sdk/blob/wasmer-sdk-js-v0.18.0/docs/phase-3/postgres-wasix.md)

## Dependency and API boundary

The release-tag workspace patches Wasmer crates to commit
`cc07dc0b35b55a48d1995b9df2ded8d3aa82b06f`. The JS bindgen manifest names
Wasmer 7.4.0/WASIX 0.704.0, overridden by that Git revision; **do not call this
a test of the stable 7.4.2 Rust engine**.
[Workspace pin](https://github.com/wasmerio/wasmer-sdk/blob/wasmer-sdk-js-v0.18.0/Cargo.toml),
[JS engine manifest](https://github.com/wasmerio/wasmer-sdk/blob/wasmer-sdk-js-v0.18.0/js/bindgen/Cargo.toml)

Both Node and browser SDK entrypoints run the Wasmer/WASIX facade compiled to
WebAssembly, with JS-engine guest execution. Node does not use a native addon.
The public abstraction is a package, sandbox and `_start` command; it does not
offer arbitrary guest-export invocation. This conflicts with our direct guest
phase calls, host callback registration and direct-memory pgwire bridge.
Having `_start` in an Oliphaunt artifact would not by itself supply those APIs.
[Released SDK contract](https://github.com/wasmerio/wasmer-sdk/blob/wasmer-sdk-js-v0.18.0/js/README.md)

## Bounded persistence follow-up

The published JS `SandboxOptions` exposes `files`, `env`, `network`, packages
and shell settings, **not an OPFS provider, directory mount or storage option**.
Its `WasmerOptions.cache` persists registry/package acquisition, not database
writes. A browser with OPFS available is not enough to select it for PGDATA.

An actual browser test created a table, inserted one row, ran `CHECKPOINT`,
selected count `1`, and disconnected cleanly. Restarting `pglite` in the **same
live sandbox** then returned `to_regclass('public.persisted_probe') IS NULL = t`.
A separately written `sandbox.fs` marker remained readable, distinguishing the
shared `/workspace` from the package's private `/base` database overlay. Closing
and recreating the sandbox likewise produced no table. These results match the
documented private writable package overlays; they are not a claim that an
explicitly mounted database would lose data.

Upstream does have an **experimental lower-level** `SandboxBuilderCore.mountHost`
and `storageHost`, requiring synchronous worker bridge installation, plus an
OPFS implementation in its Swift/WKWebView integration. Therefore it would be
incorrect to claim Wasmer cannot support OPFS. The missing part for this probe
is a supported public JS storage/mount contract wired to the PostgreSQL seed and
PGDATA, not the existence of an OPFS implementation. Importing private core APIs
and building a custom adapter was deliberately outside this bounded probe.
No OPFS-backed PostgreSQL recovery/durability claim has been established.
[Experimental host filesystem bridge](https://github.com/wasmerio/wasmer-sdk/blob/wasmer-sdk-js-v0.18.0/js/src/host-filesystem.ts),
[existing WKWebView OPFS implementation](https://github.com/wasmerio/wasmer-sdk/blob/wasmer-sdk-js-v0.18.0/swift/WasmerWKSDK/Sources/WasmerWKSDK/Web/opfs-filesystem.js)

## Next useful experiment, and stopping criteria

1. Keep this SDK out of the PR #202 correctness port. It is a separate execution
   model, not a version-only upgrade.
2. If pursuing a supported command/socket browser route, first test our actual
   guest, using one persistent connection. Require recovery, close/reopen,
   streaming/backpressure, extension loading and the intended storage contract
   before spending time on performance qualification.
3. Measure RTT, batched queries and large transfers against our browser direct
   path with the same SQL/data/durability settings. Do not compare these setup
   times with earlier Rust AOT or ElectricSQL numbers.
4. If preserving direct exports is required, ask upstream for an embedding API
   before reproducing the old fork inside the new SDK. Stop the migration if it
   needs the same private bridge without a concrete maintenance or measured
   performance benefit.

The promising result is **working upstream-maintained SQL error recovery and
large local browser transfers on an Oliphaunt-derived guest**. It does not
prove stack-exhaustion recovery or eliminate our remaining runtime fixes.

## Retained reproduction

Local evidence and runnable assertion scripts are retained outside the source
tree at `/home/sid/dev/wasmer-sdk-probe-20260927-dck2uf` (about 96 MiB, including
the package cache). `package-lock.json` pins the npm probe dependencies. No
producer tree was built. From that directory:

```sh
timeout 120 node node-probe.mjs
timeout 180 node browser-probe.mjs
timeout 30 node export-probe.mjs
timeout 120 node browser-probe.mjs --storage
```

The Node script uses the retained native psql binary at
`/home/sid/dev/oliphaunt-patch-consolidation-artifacts/native-linux-standard-20260907/install/bin/psql`
and port 5432. The browser script reuses
`/home/sid/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome` and serves
COOP/COEP headers on an ephemeral localhost port. Those machine-local paths
must be changed elsewhere. The probe is not a portable CI gate; upstream's
[browser PostgreSQL test](https://github.com/wasmerio/wasmer-sdk/blob/wasmer-sdk-js-v0.18.0/js/tests/browser-postgres.test.mjs)
is the maintained fuller starting point.
