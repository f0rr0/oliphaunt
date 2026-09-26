# Oliphaunt PostgreSQL wire server

This library and CLI expose the embedded WASIX database through a PostgreSQL socket. Connect with an ordinary PostgreSQL driver. The adapter serves one client at a time; configure connection pools with one connection.

The default `wasix` feature includes the WASIX adapter. Build without default features to use the runtime-independent PostgreSQL connection framing without Wasmer.

From this directory, `cargo build` builds the library and CLI plus its Rust
dependencies. `cargo test` runs source tests; runtime tests are explicitly ignored
until their assets are prepared. `cargo fmt --check` checks formatting and
`cargo clippy --all-targets -- -D warnings` lints the owner.

From the checkout root, `moon run oliphaunt-pgwire-server:test-integration`
prepares the runtime and runs the socket, driver, CLI and release-of-ownership
tests. `test-aot` exercises the host's AOT runtime with a real extension.
`package` creates the publishable Cargo archive, while `test-consumer` compiles
the extracted archive with the actual packaged SDK and query dependencies.

Install the CLI locally with `cargo install --path . --locked`, then run
`oliphaunt-pgwire-server --memory --print-uri`. It prints a PostgreSQL connection
URL and runs until the process is stopped. Use `--help` for persistent storage and
listener options.

The endpoint uses loopback TCP on every supported host; Unix hosts may instead
select a Unix-domain socket. It uses PostgreSQL trust authentication, refuses
TLS and GSS negotiation, and owns one connected client at a time. Its current
`CancelRequest` path does not authenticate or interrupt the guest backend, so
client cancellation is unsupported. Treat the example below as the covered
SQLx connection shape, not proof of pool, COPY, cancellation, or
arbitrary-driver conformance.

```rust,no_run
use oliphaunt_pgwire_server::OliphauntServer;
use sqlx::{Connection, Row};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut server = OliphauntServer::builder().start()?;
    let mut connection = sqlx::PgConnection::connect(&server.connection_string()).await?;
    let row = sqlx::query("SELECT 42::int AS answer")
        .fetch_one(&mut connection)
        .await?;
    assert_eq!(row.try_get::<i32, _>("answer")?, 42);
    connection.close().await?;
    server.close()?;
    Ok(())
}
```
