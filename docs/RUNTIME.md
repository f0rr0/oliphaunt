# Runtime

`pglite-oxide` embeds PGlite/Postgres in the current process. The direct Rust API
talks to the embedded backend directly, and `PgliteServer` exposes the same
backend through a local Postgres wire-protocol server.

## Runtime Layout

Each database root contains:

- `pglite/`: immutable runtime files from the asset cache;
- `base/`: the Postgres data directory;
- `tmp/`: runtime scratch space;
- `home/`: runtime home directory.

Extensions are installed into the database root only when requested. The runtime
uses canonical Postgres paths for extension files and timezone data.

## Opening Databases

Persistent database:

```rust,no_run
use pglite_oxide::Pglite;

let db = Pglite::builder().path("./.pglite").open()?;
# Ok::<_, Box<dyn std::error::Error>>(())
```

Temporary database:

```rust,no_run
use pglite_oxide::Pglite;

let db = Pglite::builder().temporary().open()?;
# Ok::<_, Box<dyn std::error::Error>>(())
```

Temporary databases use a template cache by default. The stable PGlite source
uses a split `initdb` artifact; pglite-oxide does not expose fresh runtime
`initdb` until that WASIX runner is implemented.

Persistent roots are locked while open. A second direct or server open against
the same root returns an error instead of corrupting the data directory.

## Local Server Mode

Use `PgliteServer` when a library expects a Postgres connection string:

```rust,no_run
use pglite_oxide::PgliteServer;

let server = PgliteServer::temporary_tcp()?;
let url = server.database_url();
# server.shutdown()?;
# Ok::<_, Box<dyn std::error::Error>>(())
```

Server mode currently exposes one embedded backend. Configure SQLx,
`tokio-postgres`, Diesel, SeaORM, or framework pools with one connection.
Generated URLs include `sslmode=disable`.

## Protocol Behavior

Server mode supports normal startup packets for the advertised URL identity:
`user=postgres` and `database=template1`. Unsupported users or databases are
rejected during startup with PostgreSQL-style errors.

The server handles:

- SQLx and `tokio-postgres` extended queries;
- prepared statements;
- transactions and rollback after errors;
- SSLRequest with a no-SSL response;
- CancelRequest as a safe connection close;
- recovery after Parse, Bind, and Execute errors.

Streaming `COPY FROM STDIN` through server mode is not supported yet. It fails
closed with SQLSTATE `0A000` and leaves the connection usable. Direct Rust API
blob COPY through `/dev/blob` is supported.

## Preloading

Applications can warm runtime and extension artifacts before the first visible
query:

```rust,no_run
use pglite_oxide::{extensions, Pglite};

Pglite::preload()?;
Pglite::preload_extensions([extensions::VECTOR])?;
# Ok::<_, Box<dyn std::error::Error>>(())
```

Unsupported host targets fail with a clear missing-artifact error rather than
attempting local compilation.

The runtime requires Wasmer/WebAssembly exception handling. This is part of the
Postgres error and longjmp recovery contract across the main WASIX module and
extension side modules. `pglite-oxide` does not support a non-EH production
fallback. Asyncify is excluded from production artifacts unless a future
isolated snapshot/journaling experiment proves a specific need. Build scripts
reject Asyncify flags by default; the experiment-only override is not a runtime
compatibility mode.

WASIX dynamic linking is part of the runtime contract: the packaged main module
is built as a dynamic-main module, extension and tool modules are PIC side
modules, and all of them are generated from one configured source tree.

Startup avoids content-hashing bundled assets by default. Set
`PGLITE_OXIDE_AOT_VERIFY=full` to force full SHA-256 verification of cached AOT
files, bundled runtime archives, bundled extension archives, PGDATA template
archives, and runtime/template module matches before use.

Wasmer AOT artifacts are deserialized with the native mmapped-file path by
default. Set `PGLITE_OXIDE_AOT_DESERIALIZE=file` only when comparing startup
behavior with the older file deserializer.

Database roots use filesystem composition by default. This avoids cloning the
full immutable runtime tree by serving immutable runtime files from the shared
cached lower runtime and keeping only mutable state, device/tmp files, and
requested extension assets in the per-root upper layer. The prepared layout is
carried into direct opens and `PgliteServer` instead of being rediscovered by
path. Set `PGLITE_OXIDE_MOUNTFS=0` to force the older full local runtime
layout.

Template-backed roots also use the eager PGDATA overlay by default. Set
`PGLITE_OXIDE_PGDATA_OVERLAY=0` to force full template install/clone. The
runtime/cache details and current perf numbers are covered in
[PERFORMANCE.md](PERFORMANCE.md).

## More Detail

- [USAGE.md](USAGE.md) covers the public API.
- [EXTENSIONS.md](EXTENSIONS.md) covers bundled SQL extensions.
- [ASSETS.md](ASSETS.md) covers packaged runtime assets.
- [PERFORMANCE.md](PERFORMANCE.md) covers cache and startup guidance.
