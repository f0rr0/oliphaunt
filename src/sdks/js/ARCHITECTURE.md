# Oliphaunt TypeScript Runtime Architecture

`@oliphaunt/ts` targets Node.js, Bun, and Deno outside React Native. Its runtime
architecture must preserve the Rust SDK mode semantics rather than mapping every
mode onto the current in-process FFI binding.

The shipped implementation exposes `nativeDirect`, `nativeBroker`, and
`nativeServer` with honest availability. Node.js, Bun, and Deno all default to
`nativeDirect` for predictable cross-runtime semantics. Node.js gets that
default through Oliphaunt's prebuilt Node-API direct adapter release asset; Bun
and Deno use their runtime-owned FFI surfaces.

## Research Baseline

Rust is the parity source:

- `NativeDirect` is in-process and serialized over one physical PostgreSQL
  backend session.
- `NativeBroker` supervises one `oliphaunt-broker` helper process per active
  root, uses the authenticated `PGOB` frame protocol, supports multiple roots
  up to `broker_max_roots`, and restarts a helper only after a failed or exited
  request boundary.
- `NativeServer` starts a real local PostgreSQL server process, exposes a
  PostgreSQL connection string, owns one SDK connection for SDK calls, and is
  the only mode that advertises independent sessions.

Runtime and platform facts:

- Node.js exposes asynchronous child process spawning and local IPC/TCP sockets
  through stable standard modules. Its docs also warn that unconsumed child
  stdout/stderr pipes can block the child, so long-running helpers must either
  inherit/drain stderr and reserve stdout for bounded readiness output.
- Bun exposes `Bun.spawn`, implements `node:net` fully in its Node compatibility
  table, and can kill/unref subprocesses. The broker/server implementation can
  use the same Node-compatible socket path for Bun, while native Bun adapters can
  be optimized later.
- Deno exposes `Deno.Command`, `Deno.connect`, and Unix socket listeners, but it
  requires explicit permissions for subprocess, network, filesystem, and FFI
  access. Deno support must report actionable permission failures instead of
  hiding them behind generic runtime-unavailable errors.
- PostgreSQL server mode must use real `postgres`/`pg_ctl` lifecycle semantics:
  local listen addresses, optional Unix socket directories, controlled stop, and
  native startup/cancel protocol behavior.

Primary external references used for this architecture:

- Node.js child processes: <https://nodejs.org/api/child_process.html>
- Node.js IPC sockets: <https://nodejs.org/api/net.html>
- Bun child processes: <https://bun.sh/docs/runtime/child-process>
- Bun Node compatibility: <https://bun.sh/docs/runtime/nodejs-apis>
- Deno subprocesses: <https://docs.deno.com/api/deno/~/Deno.Command>
- Deno networking: <https://docs.deno.com/api/deno/~/Deno.connect>
- PostgreSQL `postgres`: <https://www.postgresql.org/docs/current/app-postgres.html>
- PostgreSQL `pg_ctl`: <https://www.postgresql.org/docs/current/app-pg-ctl.html>

## Goals

- Reach Rust parity for mode semantics, capabilities, validation, and error
  honesty.
- Keep binary protocol bytes as `Uint8Array` end-to-end.
- Keep hot protocol paths free of JSON, text re-encoding, and avoidable copies.
- Make child process ownership explicit and recoverable.
- Keep runtime-specific code behind small process/socket adapters.
- Prefer one implementation shared by Node, Bun, and Deno when the runtime API is
  already compatible.

## Non-Goals

- Do not emulate broker/server by opening `nativeDirect` inside the JavaScript
  process.
- Do not depend on a general PostgreSQL client library for SDK-owned
  `execProtocolRaw`; the SDK owns raw protocol bytes and strict response parsing.
- Do not mark a mode available until native smoke and parity tests cover that
  mode on at least one supported runtime.
- Do not invent a second broker protocol for TypeScript.
- Do not make normal Node.js consumers approve a native FFI dependency just to
  open a database. Node `nativeDirect` is the default, but it must be served by
  Oliphaunt-owned prebuilt Node-API adapter artifacts rather than a
  consumer-installed third-party FFI package.

## Public API Target

`OpenConfig` should grow only the Rust-parity knobs that affect mode semantics:

```ts
type OpenConfig = {
  engine?: 'nativeDirect' | 'nativeBroker' | 'nativeServer';
  root?: string;
  temporary?: boolean;
  maxClientSessions?: number;
  brokerExecutable?: string;
  brokerMaxRoots?: number;
  brokerTransport?: 'auto' | 'unix' | 'tcp';
  serverExecutable?: string;
  serverPort?: number;
  serverToolDirectory?: string;
  durability?: 'safe' | 'balanced' | 'fastDev';
  runtimeFootprint?: 'throughput' | 'balancedMobile' | 'smallMobile';
  startupGUCs?: readonly PostgresStartupGUC[];
  username?: string;
  database?: string;
  extensions?: readonly string[];
  libraryPath?: string;
  runtimeDirectory?: string;
};
```

Validation must match Rust:

- `root` is the Oliphaunt root directory; native PGDATA is always
  `<root>/pgdata`, including direct, broker, server, backup, and restore paths;
- direct and broker accept only `maxClientSessions === 1`;
- server accepts `maxClientSessions > 0` and defaults to `32`;
- broker requires `brokerMaxRoots > 0` and defaults to `1`;
- server rejects `serverPort === 0`; omitting it means allocate an ephemeral
  localhost port;
- executable, tool directory, root, identity, extension, and GUC validation
  remain pre-spawn checks.

When `engine` is omitted, the default is consistent:

- Node.js: `nativeDirect`;
- Bun: `nativeDirect`;
- Deno: `nativeDirect`.

`supportedModes()` reports availability per configured runtime:

- `nativeDirect`: available when `liboliphaunt` loads and the runtime has a
  direct adapter. Bun and Deno use built-in FFI. Node resolves the verified
  `@oliphaunt/node-direct-*` Node-API adapter optional package, built from the
  `oliphaunt-node-direct-*` release assets, and loads it without `postinstall`,
  node-gyp, Rust, Cargo, or third-party FFI packages;
- the split `@oliphaunt/tools-*` package is resolved for Node, Bun, and Deno
  package-managed native installs and merged with the root `liboliphaunt`
  runtime package before startup;
- native direct extension package materialization is shared by Node and Bun.
  Deno direct mode may use extensions only with an explicit prepared
  `runtimeDirectory`; package-managed Deno extension materialization must remain
  a clear unsupported-feature error until it has a real resolver/cache path.
  Deno server mode follows the same explicit prepared-runtime rule for
  extensions while still using the package-managed split tools resolver for the
  base server toolchain;
- `nativeBroker`: available when the broker helper resolves from an explicit
  override, package-adjacent executable, or verified Rust SDK release asset, the
  matching `liboliphaunt` install resolves, and the current runtime can spawn
  and connect to the selected local transport;
- `nativeServer`: available when the server toolchain resolves and the current
  runtime can spawn, connect, and stop the server process.

Broker/server availability remains conditional on executable/toolchain
discovery and smoke coverage. Missing helpers must stay explicit unavailable
entries rather than aliases to direct mode. Node.js physical-archive restore
uses the same Node direct adapter by default; broker restore is used only when
the caller explicitly selects `engine: 'nativeBroker'`.

## Runtime Adapter Boundary

Add one internal adapter layer:

```ts
type RuntimeProcessAdapter = {
  runtime: 'node' | 'bun' | 'deno';
  supportsUnixSockets: boolean;
  spawn(command: ProcessCommand): Promise<ManagedProcess>;
  connect(endpoint: LocalEndpoint): Promise<ByteStream>;
  createTempDir(prefix: string): Promise<string>;
  removeTree(path: string): Promise<void>;
  randomBytes(length: number): Uint8Array;
};
```

`ByteStream` is the only transport shape visible to broker/server code:

```ts
type ByteStream = {
  readExactly(length: number): Promise<Uint8Array>;
  writeAll(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
};
```

Node and Bun can share a Node-compatible adapter using `node:child_process` and
`node:net`; Bun-native spawn can replace the process half later without changing
broker/server code. Deno gets a native adapter using `Deno.Command` and
`Deno.connect`.

## Native Broker Design

TypeScript `nativeBroker` should reuse the Rust `oliphaunt-broker` helper and
the existing `PGOB` frame protocol.

### Open Flow

1. Normalize and validate config.
2. Materialize `temporary` roots in the host runtime temp directory.
3. Acquire an in-process broker root lease keyed by canonical or normalized
   absolute path. This mirrors Rust's duplicate-root and capacity guard.
4. Resolve the broker executable from `brokerExecutable`, `OLIPHAUNT_BROKER`,
   package-adjacent executable names, or the checksum-verified Rust SDK
   `oliphaunt-broker` release asset pinned by package metadata.
5. Resolve the compatible `liboliphaunt` install exactly as direct mode does.
   Broker launch must pass `LIBOLIPHAUNT_PATH` and `OLIPHAUNT_INSTALL_DIR` to the
   Rust helper so explicit config and auto-resolved release assets behave the
   same as direct mode.
6. Allocate IPC endpoints:
   - Unix sockets on Unix runtimes that support them;
   - TCP loopback fallback when Unix sockets are unavailable or
     `brokerTransport: 'tcp'` is selected.
7. Generate a 32-byte random auth token and pass it only through the child
   environment.
8. Spawn `oliphaunt-broker` with the same argument set Rust uses:
   `--root`, `--bootstrap`, `--durability`, `--runtime-footprint`, optional
   `--initdb`, `--username`, `--database`, endpoint flags, repeated
   `--extension`, and repeated `--startup-guc`.
9. Read exactly one bounded stdout readiness line:
   `OLIPHAUNT_BROKER_READY <primary> cancel=<cancel>`.
10. Connect to the primary endpoint and authenticate with the token before any
   protocol frame.
11. Create a `BrokerSession` with the child, primary stream, cancel endpoint,
    root lease, IPC cleanup path, and temporary root cleanup ownership.

### Frame Protocol

The broker client must port Rust's frame codec exactly:

- magic: `PGOB`;
- header length: 13 bytes;
- payload length: unsigned big-endian `u64`;
- maximum payload length: 128 MiB;
- request kinds: authenticate, raw protocol, simple query, stream protocol,
  checkpoint, backup, cancel, close;
- response kinds: ok, error, stream chunk.

Errors stay textual at the broker IPC boundary because that is the Rust helper
contract. PostgreSQL ErrorResponse bytes still flow through successful protocol
responses and are parsed by the existing query parser.

### Execution Semantics

- Raw, simple, stream, checkpoint, backup, and close serialize through the same
  `OliphauntDatabase` operation gate used by direct mode.
- Cancellation uses the separate cancel endpoint so it is not queued behind a
  long result stream.
- If the helper exits between operations, relaunch before the next operation.
- If a request fails mid-flight, return an error and mark the helper failed. Do
  not replay the request because commit state is unknown.
- Subsequent operations may relaunch the helper against the same root and rely
  on PostgreSQL WAL recovery.
- Close sends a best-effort close frame, waits for bounded exit, kills on
  timeout, and then releases root/temp/socket resources.

### Capabilities

Broker capabilities must match Rust:

- process isolated;
- serialized single session;
- `multiRoot` true only when `brokerMaxRoots > 1`;
- crash restartable at request boundaries;
- root switchable;
- no connection string;
- physical archive backup/restore only.

## Native Server Design

TypeScript `nativeServer` must start a real local PostgreSQL-compatible server
process. It should not route through broker mode and must not pretend to expose
independent sessions unless external PostgreSQL clients can connect to the
server.

### Open Flow

1. Normalize and validate config.
2. Prepare or validate `<root>/pgdata`. Empty roots are initialized with
   matching `initdb`; initialized roots are reused after `PG_VERSION`
   validation by PostgreSQL startup.
3. Resolve `postgres`, `pg_ctl`, and `initdb` from `serverToolDirectory`,
   `serverExecutable`, or the prepared root runtime. Package-managed installs
   materialize the root runtime together with the `@oliphaunt/tools-*`
   `pg_dump`/`psql` payload into one runtime directory before server startup.
4. Allocate a fixed or ephemeral loopback port. Retry ephemeral bind conflicts a
   bounded number of times, matching Rust's behavior.
5. On Unix, allocate a private mode `0700` socket directory and prefer it for
   the SDK-owned connection. Expose TCP in the public connection string.
6. Spawn `postgres` with:
   - `-D <pgdata>`;
   - `-h 127.0.0.1`;
   - `-p <port>`;
   - `-c logging_collector=off`;
   - `-c listen_addresses=127.0.0.1`;
   - `-c unix_socket_directories=<private-dir>` on Unix;
   - durability, footprint, startup GUCs, extension preload libraries, and
     `max_connections=<maxClientSessions>`.
7. Poll startup by connecting with the SDK PostgreSQL wire client until ready,
   the child exits, or the startup deadline expires.
8. Capture `BackendKeyData` for SDK query cancellation.
9. Return an `OliphauntDatabase` with server capabilities and a
   percent-encoded `postgres://user@127.0.0.1:port/database` connection string.

### PostgreSQL Wire Client

Server mode needs a small internal PostgreSQL v3 client, not a dependency on a
general client package:

- startup message with username/database;
- authentication ok, cleartext password failure as an explicit unsupported auth
  error, parameter status, backend key data, notice, error, ready-for-query;
- raw frontend protocol write and backend response collection until
  `ReadyForQuery`;
- streaming callback on backend frames;
- `Terminate` on close;
- CancelRequest over a fresh connection using captured cancel key data;
- strict backend UTF-8 handling shared with the existing query parser.

The server SDK connection is one physical PostgreSQL client connection used for
SDK methods. The mode still advertises independent sessions because external
clients can use the connection string concurrently.

### Backup And Restore

- `physicalArchive`: use PostgreSQL online backup boundaries
  (`pg_backup_start`/`pg_backup_stop`), archive a stable `pgdata/` tree, append
  required WAL, and inject the generated `backup_label`/`tablespace_map` files.
  It must not copy a live data directory blindly.
- `sql`: run packaged `pg_dump` against the connection string and return SQL
  bytes.
- restore remains physical archive only until a stable logical restore flow is
  designed.

### Close Semantics

Close must:

1. mark the JS handle closed so new work is rejected;
2. terminate the SDK connection;
3. run `pg_ctl -D <pgdata> -m fast -w stop` when available;
4. wait for bounded process exit;
5. kill only as a fallback after graceful stop fails;
6. clean private socket directories.

## Robustness Requirements

- Every subprocess spawn must have a startup timeout and child-exit detection.
- Readiness parsing must be bounded; a helper cannot stream unbounded stdout.
- Stderr must be inherited or drained to avoid pipe backpressure deadlocks.
- Auth tokens are per session and never logged.
- Unix socket directories are private and removed on close/failure.
- TCP fallback binds only to loopback and uses `TCP_NODELAY`.
- Root leases are released on every failure path.
- Deno permission errors are surfaced with the exact missing capability.
- Close and cancel are lifecycle operations, not ordinary queued SQL.
- Broker request replay is forbidden after an in-flight transport failure.

## Performance Requirements

- Direct remains the lowest-latency mode.
- Broker hot path is one binary frame write plus one response read per request;
  no JSON and no base64.
- Server hot path writes PostgreSQL protocol bytes directly to the socket.
- Stream paths apply backpressure: do not accumulate full large responses before
  invoking the callback.
- Keep one SDK connection open for server-mode SDK calls.
- Prefer Unix sockets for SDK-owned local traffic on Unix; use TCP fallback for
  portability.
- Benchmarks must cover direct/broker/server protocol RTT, large streaming,
  typed query parsing, cancellation latency, cold/warm open, backup/restore, and
  child-process RSS.

## Implementation Plan

1. Add runtime adapters, `ByteStream`, endpoint parsing, process lifecycle
   helpers, and timeout utilities.
2. Port the `PGOB` frame codec and broker ready-line parser with unit tests.
3. Implement broker session open/execute/stream/cancel/backup/close against a
   fake helper fixture, then the Rust `oliphaunt-broker` binary.
4. Add config fields and validation for `maxClientSessions`, broker executable,
   broker max roots, broker transport, server executable, server port, and
   server tool directory.
5. Implement a minimal PostgreSQL wire client for server startup, raw protocol,
   streaming, terminate, and cancel.
6. Implement server process lifecycle and connection string exposure.
7. Keep physical archive and SQL backup behavior covered by unit tests and
   native smoke.
8. Add native smoke gates per mode and runtime. Only after those pass should
   `supportedModes()` report broker/server as available.

## Test Matrix

Unit tests:

- config validation parity with Rust;
- broker spawn args;
- ready-line parser;
- endpoint parser;
- `PGOB` frame codec, max frame rejection, and UTF-8 error frames;
- root lease duplicate/capacity behavior;
- server connection string percent encoding;
- server startup args and port conflict retry classification.

Fixture integration:

- fake broker helper that authenticates, echoes protocol bytes, streams chunks,
  rejects bad tokens, and simulates mid-flight exit;
- fake server process that exercises startup timeout and close fallback paths.

Native smoke:

- Node broker smoke without app-provided native FFI;
- optional Node direct smoke only when a test fixture intentionally provides an
  FFI dependency;
- Bun and Deno direct smoke;
- broker open/query/stream/cancel/backup/close with `oliphaunt-broker`;
- server open/query/connection-string external client/cancel/SQL backup/physical
  backup/close with packaged PostgreSQL tools.

The package must keep broker/server conditional until the relevant native smoke
for that mode is green in release CI or explicitly documented as platform-gated.

## Rejected Designs

- JavaScript `child_process` IPC: the broker helper is Rust, Bun cannot pass
  socket handles in its Node compatibility layer, and Deno uses different IPC
  primitives.
- General PostgreSQL client dependency for SDK calls: it hides protocol bytes,
  cancellation, streaming boundaries, and error parsing that the SDK owns.
- Broker implemented as a JS worker running `nativeDirect`: it is not process
  isolation and cannot survive native backend death.
- Server implemented as broker plus a connection string facade: it would not
  provide independent PostgreSQL client sessions.
- Marking server available without SQL backup and connection string tests: that
  would violate the Rust server-mode contract.
