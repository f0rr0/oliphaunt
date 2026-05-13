# libpglite-oxide

This crate is the native-first Rust SDK path for PGlite. It is intentionally
separate from the existing WASIX-oriented `pglite-oxide` API so the final shape
can be designed around native PostgreSQL instead of compatibility constraints.

The public model is:

- `NativeDirect`: in-process, one physical PostgreSQL session, serialized by an
  owner executor.
- `NativeBroker`: helper-process mode for robust multi-root desktop operation.
- `NativeServer`: PostgreSQL-compatible local server mode for true independent
  client sessions.

The crate defines the SDK contract, configuration model, extension-pack model,
capabilities, and owner-thread execution boundary. Concrete PostgreSQL 18
bindings plug in through `NativeRuntime`.

`LibPgliteRuntime` is the first concrete runtime. It loads the native C ABI from
`LIBPGLITE_OXIDE_LIBPGLITE` or an explicit path and currently serves
`NativeDirect`.

```rust
use libpglite_oxide::{LibPgliteRuntime, Pglite};

# async fn demo() -> libpglite_oxide::Result<()> {
let db = Pglite::builder()
    .path(".libpglite-oxide")
    .runtime(LibPgliteRuntime::from_env())
    .open()
    .await?;

db.execute("SELECT 1").await?;
db.close().await?;
# Ok(())
# }
```
