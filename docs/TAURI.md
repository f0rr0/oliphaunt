# Tauri Usage

Use `pglite-oxide` from Rust state, not from the webview. The crate's main value
in Tauri is a sidecar-free local Postgres runtime that commands, background
tasks, and Rust libraries can share.

See the
[Tauri SQLx example](https://github.com/f0rr0/pglite-oxide/blob/main/examples/tauri-sqlx-vanilla/README.md)
for a Tauri v2 app that keeps the database in Rust state and exposes a small
SQLx-backed profile command to the frontend.

## Direct Rust State

Use `Pglite` when your Tauri commands own the database calls:

```rust,no_run
use pglite_oxide::Pglite;
use serde_json::json;
use std::sync::Mutex;
use tauri::State;

struct Db(Mutex<Pglite>);

#[tauri::command]
fn add_item(db: State<'_, Db>, value: String) -> Result<(), String> {
    let mut db = db.0.lock().map_err(|err| err.to_string())?;
    db.query(
        "INSERT INTO items(value) VALUES ($1)",
        &[json!(value)],
        None,
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}
```

Open the database under your app data directory during setup:

```rust,no_run
use pglite_oxide::Pglite;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut db = Pglite::builder()
        .app("com", "example", "desktop-app")
        .open()?;
    db.close()?;
    Ok(())
}
```

## Existing Postgres Clients

Use `PgliteServer` when another Rust library expects a PostgreSQL URL:

```rust,no_run
use pglite_oxide::PgliteServer;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let server = PgliteServer::builder()
        .path("./.pglite")
        .start()?;

    let database_url = server.database_url();
    println!("{database_url}");

    server.shutdown()?;
    Ok(())
}
```

This is the right fit for SQLx or other client libraries that already speak the
Postgres wire protocol.

## Operational Guidance

- Keep database access serialized around one backend.
- Configure SQLx and other pools with one connection.
- Prefer `Pglite` over `PgliteServer` when you do not need a PostgreSQL URI.
- Use `temporary()` or `temporary_tcp()` for tests.
- Use `fresh_temporary()` only when you need fresh-cluster semantics.
