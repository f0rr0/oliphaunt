# Oliphaunt Node-API addon

`oliphaunt-node-direct` owns the Node-API adapter that lets the TypeScript SDK
call the native `liboliphaunt` runtime without compiling native code during a
normal application install.

Published consumer packages are platform-specific optional npm packages:

- `@oliphaunt/node-direct-darwin-arm64`
- `@oliphaunt/node-direct-linux-x64-gnu`
- `@oliphaunt/node-direct-linux-arm64-gnu`
- `@oliphaunt/node-direct-win32-x64-msvc`

The TypeScript SDK selects the matching optional package. Missing packages fail
with an install-time action instead of downloading runtime assets.

Native database calls run on addon-owned background threads and return to
JavaScript through bounded Node-API thread-safe-function bridges. Environment
cleanup first aborts those JavaScript delivery bridges and waits only for a
producer already inside Node-API to observe that abort. Cleanup then cancels the resident backend, drains registered native worker threads, and terminally closes only the generation owned by that environment. It does not wait for JavaScript promise completion or an asynchronous cleanup acknowledgement.

The addon uses napi-rs and `liboliphaunt-native-bindings`, shared with the Rust SDK
and broker. The native runtime
remains a separately installed asset. Node and Bun use this addon; Deno retains
its nonblocking FFI adapter because Deno worker cleanup is not compatible with
the Node-API cleanup lifecycle. On Deno 2.8.1 the current addon passes normal SQL
and backup/restore but fails Worker termination with queued stream delivery:
the native producer is not drained and closed. Do not remove FFI based only on
ordinary query success.

From this directory, use `bun run typecheck`, `bun run lint`, `bun run test`,
`bun run build`, and `bun run test-built`. Building uses Cargo and the platform
Rust toolchain; application installs need no compiler or downloaded Node headers.

The adapter source is MIT licensed. Shipped binaries also include Rust dependencies; each binary archive and npm carrier includes their exact license texts and target-specific inventory under `THIRD_PARTY_LICENSES/rust`. The package license expression covers MIT, ISC, Unicode-3.0, and BSD-3-Clause obligations. The dependency contract pins the locked Cargo graph and actual source license bytes; four napi-rs crates omit legal files from their registry archives, so their full upstream LICENSE is pinned to each crate’s recorded source commit.
