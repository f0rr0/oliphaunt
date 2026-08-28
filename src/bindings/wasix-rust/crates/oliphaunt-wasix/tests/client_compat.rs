#![cfg(feature = "extensions")]

use anyhow::{Context, Result};
use oliphaunt_wasix::{AsyncOliphauntServer, OliphauntServer as DirectOliphauntServer};
use sqlx::{Connection, Row};
use tokio_postgres::NoTls;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tokio_postgres_parameters_and_error_recovery_work() -> Result<()> {
    let server = AsyncOliphauntServer::builder().start().await?;
    let (client, connection) = tokio_postgres::connect(server.connection_string(), NoTls)
        .await
        .context("connect with tokio-postgres")?;
    let connection = tokio::spawn(connection);

    let row = client
        .query_one("SELECT $1::int4 + 1 AS answer", &[&41_i32])
        .await?;
    assert_eq!(row.get::<_, i32>("answer"), 42);
    let error = client
        .query_one("SELECT 1 / $1::int4", &[&0_i32])
        .await
        .expect_err("division by zero must fail");
    assert_eq!(error.code().map(|code| code.code()), Some("22012"));
    assert_eq!(
        client
            .query_one("SELECT 7::int4", &[])
            .await?
            .get::<_, i32>(0),
        7
    );

    drop(client);
    connection.await??;
    let server_clone = server.clone();
    let (first_close, second_close) = tokio::join!(server.close(), server_clone.close());
    first_close?;
    second_close?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlx_uses_the_standard_postgres_connection_string() -> Result<()> {
    // liboliphaunt-doc-example:wasix-rust-sqlx-server
    let mut server = DirectOliphauntServer::builder()
        .username("postgres")
        .database("postgres")
        .startup_guc("work_mem", "8MB")
        .start()?;
    let connection_string = server.connection_string();
    let mut connection = sqlx::PgConnection::connect(connection_string).await?;
    let row = sqlx::query("SELECT current_setting('work_mem') AS work_mem, $1::text AS value")
        .bind("ok")
        .fetch_one(&mut connection)
        .await?;
    assert_eq!(row.try_get::<&str, _>("work_mem")?, "8MB");
    assert_eq!(row.try_get::<&str, _>("value")?, "ok");
    connection.close().await?;
    server.close()?;
    Ok(())
}
