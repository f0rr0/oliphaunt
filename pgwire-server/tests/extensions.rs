#![cfg(feature = "extensions")]
use anyhow::Result;
use oliphaunt_pgwire_server::AsyncOliphauntServer;
use oliphaunt_wasix::Extension;
use sqlx::Connection;
#[cfg(feature = "extension-vector")]
use sqlx::Row;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires prepared WASIX runtime and vector extension"]
#[cfg(feature = "extension-vector")]
async fn vector_extension_works_through_server() -> Result<()> {
    let server = AsyncOliphauntServer::builder()
        .extension(Extension::VECTOR)
        .start()
        .await?;
    let mut connection = sqlx::PgConnection::connect(server.connection_string()).await?;
    let installed: i64 =
        sqlx::query_scalar("SELECT count(*)::int8 FROM pg_extension WHERE extname = 'vector'")
            .fetch_one(&mut connection)
            .await?;
    assert_eq!(installed, 0);
    sqlx::query("CREATE EXTENSION vector")
        .execute(&mut connection)
        .await?;
    let row = sqlx::query("SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector AS distance")
        .fetch_one(&mut connection)
        .await?;
    assert_eq!(row.try_get::<f64, _>("distance")?, 1.0);
    connection.close().await?;
    server.close().await?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires prepared WASIX AOT runtime and uuid-ossp extension"]
#[cfg(feature = "extension-uuid-ossp")]
async fn uuid_ossp_aot_server_smoke() -> Result<()> {
    let server = AsyncOliphauntServer::builder()
        .extension(Extension::UUID_OSSP)
        .start()
        .await?;
    let mut connection = sqlx::PgConnection::connect(server.connection_string()).await?;
    let installed: i64 =
        sqlx::query_scalar("SELECT count(*)::int8 FROM pg_extension WHERE extname = 'uuid-ossp'")
            .fetch_one(&mut connection)
            .await?;
    assert_eq!(installed, 0);
    sqlx::query("CREATE EXTENSION \"uuid-ossp\"")
        .execute(&mut connection)
        .await?;
    let generated: String = sqlx::query_scalar("SELECT uuid_generate_v4()::text")
        .fetch_one(&mut connection)
        .await?;
    assert_eq!(generated.len(), 36);
    assert_eq!(&generated[14..15], "4");
    connection.close().await?;
    server.close().await?;
    Ok(())
}
