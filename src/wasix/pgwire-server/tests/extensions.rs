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
    let supported: std::collections::BTreeSet<_> = Extension::ALL
        .iter()
        .map(|extension| extension.sql_name())
        .collect();
    ensure!(
        supported.len() == Extension::ALL.len(),
        "server SDK supported metadata must contain unique SQL names"
    );
    let extensions = if let Some(expected) = option_env!("OLIPHAUNT_DECLARED_CONTRIB_SQL_NAMES") {
        let names: Vec<String> = serde_json::from_str(expected)?;
        let expected: std::collections::BTreeSet<_> = names.iter().map(String::as_str).collect();
        let contrib_rows: Vec<_> = rows
            .iter()
            .filter(|row| row["source-kind"] == "postgres-contrib")
            .map(|row| row["sql-name"].as_str().context("contrib catalog SQL name"))
            .collect::<Result<_>>()?;
        let contrib: std::collections::BTreeSet<_> = contrib_rows.iter().copied().collect();
        ensure!(!expected.is_empty() && names.len() == expected.len());
        ensure!(
            contrib == expected && contrib.len() == contrib_rows.len(),
            "held server test must select its exact canonical contrib inventory"
        );
        // ALL describes supported metadata independently of Cargo payload features.
        // Activating every selected member below requires its genuine held package.
        names
            .iter()
            .map(|name| Extension::by_sql_name(name).context("held SDK contrib metadata"))
            .collect::<Result<Vec<_>>>()?
    } else {
        let catalog_names: std::collections::BTreeSet<_> = rows
            .iter()
            .map(|row| {
                row["sql-name"]
                    .as_str()
                    .context("extension catalog SQL name")
            })
            .collect::<Result<_>>()?;
        ensure!(
            supported == catalog_names && catalog_names.len() == rows.len(),
            "enable every catalogued extension for server evidence"
        );
        Extension::ALL.to_vec()
    };
    run_server_smoke_set(&extensions, rows, root).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the declared final contrib packet"]
#[allow(unsafe_code)]
async fn declared_contrib_carriers_pass_server_smoke() -> Result<()> {
    use oliphaunt_wasix::ExtensionPackage;
    use std::collections::BTreeSet;
    fn fields<'a>(
        value: &'a serde_json::Value,
        names: &[&str],
    ) -> Result<&'a serde_json::Map<String, serde_json::Value>> {
        let object = value.as_object().context("declared server packet object")?;
        ensure!(object.len() == names.len() && names.iter().all(|name| object.contains_key(*name)));
        Ok(object)
    }
    fn string<'a>(value: &'a serde_json::Value, name: &str) -> Result<&'a str> {
        value[name]
            .as_str()
            .with_context(|| format!("declared server packet {name}"))
    }
    let packet: serde_json::Value = serde_json::from_slice(&std::fs::read(
        std::env::var_os("OLIPHAUNT_DECLARED_EXTENSION_PACKET")
            .context("declared contrib server requires its final packet")?,
    )?)?;
    fields(
        &packet,
        &[
            "product",
            "version",
            "runtimeVersion",
            "archives",
            "aotManifest",
            "aotArtifacts",
            "coreModuleSha256",
            "coreManifest",
        ],
    )?;
    let product = string(&packet, "product")?;
    let version = string(&packet, "version")?;
    let runtime_version = string(&packet, "runtimeVersion")?;
    ensure!(product == "oliphaunt-extension-contrib-pg18");
    ensure!(version == runtime_version);
    ensure!(Some(runtime_version) == option_env!("OLIPHAUNT_DECLARED_RUNTIME_VERSION"));
    let expected_names: Vec<String> = serde_json::from_str(
        option_env!("OLIPHAUNT_DECLARED_CONTRIB_SQL_NAMES")
            .context("declared server test requires its canonical compiled member names")?,
    )?;
    let expected: BTreeSet<_> = expected_names.iter().map(String::as_str).collect();
    let archive_rows = packet["archives"]
        .as_array()
        .context("declared server archives")?;
    let actual: BTreeSet<_> = archive_rows
        .iter()
        .map(|archive| {
            fields(archive, &["sqlName", "path", "sha256"])?;
            string(archive, "sqlName")
        })
        .collect::<Result<_>>()?;
    ensure!(!expected.is_empty() && expected_names.len() == expected.len());
    ensure!(actual == expected && archive_rows.len() == expected.len());
    let core: serde_json::Value =
        serde_json::from_slice(&std::fs::read(string(&packet, "coreManifest")?)?)?;
    ensure!(core["runtime"]["module-sha256"] == string(&packet, "coreModuleSha256")?);
    let aot_manifest = std::fs::read_to_string(string(&packet, "aotManifest")?)?;
    let aot: serde_json::Value = serde_json::from_str(&aot_manifest)?;
    let artifacts = aot["artifacts"]
        .as_array()
        .context("declared server AOT manifest has no artifacts")?;
    let aot_artifacts = packet["aotArtifacts"]
        .as_array()
        .context("declared server AOT artifacts")?
        .iter()
        .map(|artifact| {
            fields(artifact, &["path", "source"])?;
            let path = string(artifact, "path")?;
            let metadata = artifacts
                .iter()
                .find(|row| row["path"] == path)
                .context("declared server AOT has no manifest entry")?;
            Ok((
                &*Box::leak(
                    metadata["name"]
                        .as_str()
                        .context("declared server AOT has no module name")?
                        .to_owned()
                        .into_boxed_str(),
                ),
                &*Box::leak(std::fs::read(string(artifact, "source")?)?.into_boxed_slice()),
            ))
        })
        .collect::<Result<Vec<_>>>()?;
    let archives = archive_rows
        .iter()
        .map(|archive| {
            Ok((
                &*Box::leak(string(archive, "sqlName")?.to_owned().into_boxed_str()),
                &*Box::leak(std::fs::read(string(archive, "path")?)?.into_boxed_slice()),
                &*Box::leak(string(archive, "sha256")?.to_owned().into_boxed_str()),
            ))
        })
        .collect::<Result<Vec<_>>>()?;
    // SAFETY: the installed runner authenticates the shared final-carrier packet before both tests.
    let package = Box::leak(Box::new(unsafe {
        ExtensionPackage::from_trusted_release(
            Box::leak(product.to_owned().into_boxed_str()),
            Box::leak(version.to_owned().into_boxed_str()),
            Box::leak(runtime_version.to_owned().into_boxed_str()),
            Box::leak(archives.into_boxed_slice()),
            Box::leak(aot_manifest.into_boxed_str()),
            Box::leak(aot_artifacts.into_boxed_slice()),
        )
    }));
    let extensions = expected_names
        .iter()
        .map(|name| {
            Ok(Extension::by_sql_name(name)
                .context("canonical contrib has no SDK metadata")?
                .with_package(package))
        })
        .collect::<Result<Vec<_>>>()?;
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap();
    let catalog: serde_json::Value = serde_json::from_slice(&std::fs::read(
        root.join("src/extensions/catalog/extensions.source.json"),
    )?)?;
    let rows = catalog["extensions"]
        .as_array()
        .context("extension catalog rows")?;
    run_server_smoke_set(&extensions, rows, root).await
}

async fn run_server_smoke_set(
    extensions: &[Extension],
    rows: &[serde_json::Value],
    root: &Path,
) -> Result<()> {
    for extension in extensions {
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
