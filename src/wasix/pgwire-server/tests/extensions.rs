#![cfg(feature = "extensions")]
use anyhow::{Context, Result, ensure};
use oliphaunt_pgwire_server::AsyncOliphauntServer;
use oliphaunt_wasix::Extension;
use sqlx::Connection;
#[cfg(feature = "extension-vector")]
use sqlx::Row;
use std::path::Path;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires prepared WASIX runtime and every catalogued extension"]
async fn public_extensions_pass_server_smoke() -> Result<()> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap();
    let catalog: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(
        root.join("src/extensions/catalog/extensions.source.json"),
    )?)?;
    let rows = catalog["extensions"]
        .as_array()
        .context("extension catalog rows")?;
    ensure!(
        Extension::ALL.len() == rows.len(),
        "enable every catalogued extension for server evidence"
    );
    for extension in Extension::ALL {
        let name = extension.sql_name();
        eprintln!("server extension smoke: {name}");
        let server = AsyncOliphauntServer::builder()
            .extension(*extension)
            .start()
            .await
            .with_context(|| format!("start server with extension {name}"))?;
        let mut connection = sqlx::PgConnection::connect(server.connection_string()).await?;
        let installed: i64 =
            sqlx::query_scalar("SELECT count(*)::int8 FROM pg_extension WHERE extname = $1")
                .bind(name)
                .fetch_one(&mut connection)
                .await?;
        ensure!(
            installed == 0,
            "selecting server extension {name} must not install it"
        );
        let mut activation = Vec::new();
        extension_activation(rows, name, &mut activation)?;
        for statement in activation {
            sqlx::raw_sql(&statement)
                .execute(&mut connection)
                .await
                .with_context(|| format!("activate server extension {name}: {statement}"))?;
        }
        let recipe =
            std::fs::read_to_string(root.join(format!("src/test-fixtures/extensions/{name}.sql")))?;
        for statement in recipe
            .split("-- oliphaunt-statement")
            .map(str::trim)
            .filter(|sql| !sql.is_empty())
        {
            sqlx::raw_sql(statement)
                .fetch_all(&mut connection)
                .await
                .with_context(|| format!("server extension {name}: {statement}"))?;
        }
        connection.close().await?;
        server.close().await?;
        if let Some(evidence) = std::env::var_os("OLIPHAUNT_EXTENSION_EVIDENCE_DIR") {
            std::fs::write(
                Path::new(&evidence).join(format!("{name}.server")),
                "passed\n",
            )?;
        }
    }
    Ok(())
}

fn extension_activation(
    rows: &[serde_json::Value],
    name: &str,
    sql: &mut Vec<String>,
) -> Result<()> {
    let row = rows
        .iter()
        .find(|row| row["sql-name"] == name)
        .context("catalogued extension")?;
    for dependency in row["dependencies"]
        .as_array()
        .context("extension dependencies")?
    {
        let dependency = dependency.as_str().context("extension dependency name")?;
        if dependency != "plpgsql" {
            extension_activation(rows, dependency, sql)?;
        }
    }
    let lifecycle = &row["lifecycle"];
    let quote = |name: &str| format!("\"{}\"", name.replace('"', "\"\""));
    if lifecycle["create-extension"] == true {
        let schema = lifecycle["create-schema"]
            .as_str()
            .filter(|schema| !schema.is_empty());
        if let Some(schema) = schema.filter(|schema| *schema != "pg_catalog") {
            sql.push(format!("CREATE SCHEMA IF NOT EXISTS {}", quote(schema)));
        }
        sql.push(format!(
            "CREATE EXTENSION IF NOT EXISTS {}{}",
            quote(name),
            schema
                .map(|schema| format!(" WITH SCHEMA {}", quote(schema)))
                .unwrap_or_default()
        ));
    }
    for key in ["load-sql", "post-create-sql"] {
        for statement in lifecycle[key]
            .as_array()
            .context("extension activation SQL")?
        {
            sql.push(
                statement
                    .as_str()
                    .context("activation SQL string")?
                    .to_owned(),
            );
        }
    }
    Ok(())
}

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
