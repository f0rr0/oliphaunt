#![cfg(feature = "extension-vector")]

use anyhow::Result;
use oliphaunt_wasix::{AsyncOliphauntServer, Extension, Oliphaunt};
use sqlx::{Connection, Row};

#[test]
fn vector_extension_works_in_direct_mode() -> Result<()> {
    let mut database = Oliphaunt::builder().extension(Extension::VECTOR).open()?;
    let selected_only = database
        .query("SELECT count(*)::int4 AS count FROM pg_extension WHERE extname = 'vector'")?;
    assert_eq!(selected_only.get_text(0, "count")?, Some("0"));
    database.execute("CREATE EXTENSION vector")?;
    let result = database.query("SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector AS distance")?;
    assert_eq!(result.get_text(0, "distance")?, Some("1"));
    database.close()?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
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
