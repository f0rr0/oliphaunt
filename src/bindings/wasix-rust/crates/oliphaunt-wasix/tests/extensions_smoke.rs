#![cfg(feature = "extensions")]

use anyhow::Result;
use oliphaunt_wasix::{Oliphaunt, OliphauntServer, extensions};
use sqlx::{Connection, Row};

#[test]
fn vector_extension_works_in_direct_mode() -> Result<()> {
    let mut database = Oliphaunt::builder().extension(extensions::VECTOR).open()?;
    let result = database.query("SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector AS distance")?;
    assert_eq!(result.get_text(0, "distance")?, Some("1"));
    database.close()?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn vector_extension_works_through_server() -> Result<()> {
    let server = OliphauntServer::builder()
        .extension(extensions::VECTOR)
        .start()?;
    let mut connection = sqlx::PgConnection::connect(&server.connection_string()).await?;
    let row = sqlx::query("SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector AS distance")
        .fetch_one(&mut connection)
        .await?;
    assert_eq!(row.try_get::<f64, _>("distance")?, 1.0);
    connection.close().await?;
    server.close()?;
    Ok(())
}
