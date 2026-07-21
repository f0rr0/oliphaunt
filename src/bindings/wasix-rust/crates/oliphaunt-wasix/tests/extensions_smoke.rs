#![cfg(feature = "extensions")]

use anyhow::Result;
use oliphaunt_wasix::{Oliphaunt, OliphauntError, OliphauntServer, extensions};
use serde_json::json;
use sqlx::{Connection, Row};
use std::path::{Path, PathBuf};

struct TestTrace {
    name: &'static str,
}

impl TestTrace {
    fn new(name: &'static str) -> Self {
        eprintln!("extensions_smoke::{name} start");
        Self { name }
    }
}

impl Drop for TestTrace {
    fn drop(&mut self) {
        eprintln!("extensions_smoke::{} end", self.name);
    }
}

fn trace_expected(label: &str) {
    eprintln!("extensions_smoke::expected_sql_error exercising {label}");
}

fn first_f64(result: &oliphaunt_wasix::Results, column: &str) -> f64 {
    result.rows[0][column].as_f64().expect("floating result")
}

fn assert_oliphaunt_code(err: &anyhow::Error, expected_code: &str, message_contains: &str) {
    let pg_err = err
        .downcast_ref::<OliphauntError>()
        .expect("error should preserve Postgres fields");
    assert_eq!(pg_err.database_error().code.as_deref(), Some(expected_code));
    assert!(
        pg_err.database_error().message.contains(message_contains),
        "expected error message to contain {message_contains:?}, got {:?}",
        pg_err.database_error().message
    );
}

const PGCRYPTO_FUNCTIONAL_SMOKE_SQL: &str = "\
DO $$ \
DECLARE \
  hashed text; \
  encrypted bytea; \
  armored text; \
  header_count int; \
  crypto_key bytea := decode('000102030405060708090a0b0c0d0e0f', 'hex'); \
  crypto_iv bytea := decode('101112131415161718191a1b1c1d1e1f', 'hex'); \
BEGIN \
  IF encode(digest('abc', 'sha256'), 'hex') <> 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' THEN \
    RAISE EXCEPTION 'sha256 digest failed'; \
  END IF; \
  IF encode(hmac('test', 'key', 'sha1'), 'hex') <> '671f54ce0c540f78ffe1e26dcf9c2a047aea4fda' THEN \
    RAISE EXCEPTION 'hmac failed'; \
  END IF; \
  IF length(gen_random_bytes(16)) <> 16 THEN \
    RAISE EXCEPTION 'random bytes length failed'; \
  END IF; \
  IF gen_random_uuid()::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN \
    RAISE EXCEPTION 'random uuid format failed'; \
  END IF; \
  SELECT crypt('secret', gen_salt('bf', 4)) INTO hashed; \
  IF crypt('secret', hashed) <> hashed THEN \
    RAISE EXCEPTION 'password hash verify failed'; \
  END IF; \
  SELECT armor(digest('test', 'sha1'), ARRAY['Version'], ARRAY['oliphaunt']) INTO armored; \
  IF position('Version: oliphaunt' in armored) = 0 THEN \
    RAISE EXCEPTION 'armor header failed'; \
  END IF; \
  SELECT count(*) INTO header_count FROM pgp_armor_headers(armored); \
  IF header_count <> 1 THEN \
    RAISE EXCEPTION 'armor header count failed: %', header_count; \
  END IF; \
  SELECT pgp_sym_encrypt('oliphaunt secret', 'passphrase') INTO encrypted; \
  IF pgp_sym_decrypt(encrypted, 'passphrase') <> 'oliphaunt secret' THEN \
    RAISE EXCEPTION 'PGP symmetric decrypt failed'; \
  END IF; \
  IF pgp_key_id(encrypted) <> 'SYMKEY' THEN \
    RAISE EXCEPTION 'PGP symmetric key id failed'; \
  END IF; \
  SELECT encrypt(convert_to('oliphaunt raw cipher', 'UTF8'), crypto_key, 'aes') INTO encrypted; \
  IF convert_from(decrypt(encrypted, crypto_key, 'aes'), 'UTF8') <> 'oliphaunt raw cipher' THEN \
    RAISE EXCEPTION 'raw decrypt failed'; \
  END IF; \
  SELECT encrypt_iv(convert_to('oliphaunt iv cipher', 'UTF8'), crypto_key, crypto_iv, 'aes-cbc') INTO encrypted; \
  IF convert_from(decrypt_iv(encrypted, crypto_key, crypto_iv, 'aes-cbc'), 'UTF8') <> 'oliphaunt iv cipher' THEN \
    RAISE EXCEPTION 'raw iv decrypt failed'; \
  END IF; \
END $$";

fn assert_sqlx_code(err: &sqlx::Error, expected_code: &str) {
    assert_eq!(
        err.as_database_error().and_then(|db| db.code()).as_deref(),
        Some(expected_code)
    );
}

fn assert_only_requested_extension_assets_are_materialized(
    root: &Path,
    requested: &str,
    unrequested: &str,
) {
    let runtime = root.join("tmp/oliphaunt");
    assert!(
        runtime
            .join(format!("lib/postgresql/{requested}.so"))
            .is_file(),
        "requested extension side module should be materialized in the upper runtime layer"
    );
    assert!(
        runtime
            .join(format!("share/postgresql/extension/{requested}.control"))
            .is_file(),
        "requested extension control file should be materialized in the upper runtime layer"
    );
    assert!(
        !runtime
            .join(format!("lib/postgresql/{unrequested}.so"))
            .exists(),
        "unrequested extension side module should not be materialized"
    );
    let lib_files = relative_files(&runtime.join("lib/postgresql"));
    assert_eq!(
        lib_files,
        vec![PathBuf::from(format!("{requested}.so"))],
        "upper runtime library layer should contain only the requested extension side module"
    );
    let share_files = relative_files(&runtime.join("share/postgresql"));
    assert!(
        share_files.iter().all(|path| {
            path.parent() == Some(Path::new("extension"))
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| {
                        name == format!("{requested}.control")
                            || name == format!("{requested}.sql")
                            || name.starts_with(&format!("{requested}--"))
                    })
        }),
        "upper runtime share layer should contain only requested extension metadata, got {share_files:?}"
    );
    assert!(
        !runtime.join("bin").exists(),
        "core binaries should stay in the lower cached runtime"
    );
    assert!(
        !runtime.join("lib/postgresql/plpgsql.so").exists(),
        "core runtime side modules should stay in the lower cached runtime"
    );
    assert!(
        !runtime.join("share/postgresql/postgres.bki").exists(),
        "core catalog files should stay in the lower cached runtime"
    );
}

fn relative_files(root: &Path) -> Vec<PathBuf> {
    fn walk(base: &Path, current: &Path, files: &mut Vec<PathBuf>) {
        if !current.exists() {
            return;
        }
        for entry in std::fs::read_dir(current).expect("read runtime test directory") {
            let entry = entry.expect("read runtime test directory entry");
            let path = entry.path();
            if path.is_dir() {
                walk(base, &path, files);
            } else if path.is_file() {
                files.push(
                    path.strip_prefix(base)
                        .expect("relative file")
                        .to_path_buf(),
                );
            }
        }
    }

    let mut files = Vec::new();
    walk(root, root, &mut files);
    files.sort();
    files
}

#[test]
fn vector_extension_direct_smoke() -> Result<()> {
    let _trace = TestTrace::new("vector_extension_direct_smoke");
    let mut db = Oliphaunt::builder()
        .temporary()
        .extension(extensions::VECTOR)
        .open()?;

    db.exec("CREATE TEMP TABLE oxide_vec (embedding vector(3))", None)?;
    db.exec("INSERT INTO oxide_vec VALUES ('[1,2,3]')", None)?;
    let result = db.query(
        "SELECT embedding <-> '[1,2,4]'::vector AS distance FROM oxide_vec",
        &[],
        None,
    )?;
    assert_eq!(first_f64(&result, "distance"), 1.0);

    let version = db.query(
        "SELECT extversion, n.nspname AS schema_name \
         FROM pg_extension e \
         JOIN pg_namespace n ON n.oid = e.extnamespace \
         WHERE e.extname = 'vector'",
        &[],
        None,
    )?;
    let extversion = version.rows[0]["extversion"]
        .as_str()
        .expect("vector extversion");
    assert!(!extversion.is_empty());
    assert_eq!(version.rows[0]["schema_name"], json!("pg_catalog"));

    trace_expected("vector_direct division-by-zero");
    let err = db
        .query(
            "SELECT 10 / $1::int4 AS impossible_after_vector",
            &[serde_json::json!(0)],
            None,
        )
        .expect_err("division by zero after vector load should fail");
    assert_oliphaunt_code(&err, "22012", "division by zero");
    let recovered = db.query("SELECT 13::int AS recovered_after_vector_error", &[], None)?;
    assert_eq!(recovered.rows[0]["recovered_after_vector_error"], json!(13));

    trace_expected("vector_direct invalid-vector-literal");
    let invalid_vector = db
        .query(
            "SELECT $1::vector AS embedding",
            &[json!("[hello,1]")],
            None,
        )
        .expect_err("invalid vector literal should fail inside the vector extension");
    assert_oliphaunt_code(
        &invalid_vector,
        "22P02",
        "invalid input syntax for type vector",
    );
    let recovered = db.query(
        "SELECT 15::int AS recovered_after_invalid_vector",
        &[],
        None,
    )?;
    assert_eq!(
        recovered.rows[0]["recovered_after_invalid_vector"],
        json!(15)
    );

    trace_expected("vector_direct dimension-mismatch");
    let dimension_mismatch = db
        .query(
            "SELECT $1::vector <-> $2::vector AS distance",
            &[json!("[1,2]"), json!("[3]")],
            None,
        )
        .expect_err("vector distance should reject mismatched dimensions");
    assert_oliphaunt_code(&dimension_mismatch, "22000", "different vector dimensions");
    let recovered = db.query(
        "SELECT 16::int AS recovered_after_dimension_mismatch",
        &[],
        None,
    )?;
    assert_eq!(
        recovered.rows[0]["recovered_after_dimension_mismatch"],
        json!(16)
    );

    db.close()?;
    Ok(())
}

#[test]
fn pure_mountfs_materializes_only_requested_extension_assets() -> Result<()> {
    let _trace = TestTrace::new("pure_mountfs_materializes_only_requested_extension_assets");
    let root = tempfile::TempDir::new()?;
    {
        let mut db = Oliphaunt::builder()
            .path(root.path())
            .extension(extensions::VECTOR)
            .open()?;
        let result = db.query(
            "SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector AS distance",
            &[],
            None,
        )?;
        assert_eq!(first_f64(&result, "distance"), 1.0);
        db.close()?;
    }

    assert_only_requested_extension_assets_are_materialized(root.path(), "vector", "pg_trgm");
    Ok(())
}

#[test]
fn vector_extension_ports_pgvector_core_type_cases() -> Result<()> {
    let _trace = TestTrace::new("vector_extension_ports_pgvector_core_type_cases");
    let mut db = Oliphaunt::builder()
        .temporary()
        .extension(extensions::VECTOR)
        .open()?;

    let valid = db.query(
        "SELECT \
            '[1,2,3]'::vector::text AS vector_text, \
            vector_dims('[1,2,3]'::vector)::int AS dims, \
            l2_distance('[0,0]'::vector, '[3,4]'::vector)::float8 AS distance",
        &[],
        None,
    )?;
    assert_eq!(valid.rows[0]["vector_text"], json!("[1,2,3]"));
    assert_eq!(valid.rows[0]["dims"], json!(3));
    assert_eq!(first_f64(&valid, "distance"), 5.0);

    for (sql, code, message) in [
        (
            "SELECT '[hello,1]'::vector",
            "22P02",
            "invalid input syntax for type vector",
        ),
        ("SELECT '[NaN,1]'::vector", "22000", "NaN not allowed"),
        (
            "SELECT '[1,2,3]'::vector(2)",
            "22000",
            "expected 2 dimensions, not 3",
        ),
        (
            "SELECT '[1,2]'::vector <-> '[3]'::vector",
            "22000",
            "different vector dimensions",
        ),
    ] {
        trace_expected(&format!("vector_core_type_cases {sql}"));
        let err = match db.query(sql, &[], None) {
            Ok(_) => panic!("{sql} should fail"),
            Err(err) => err,
        };
        assert_oliphaunt_code(&err, code, message);
        let recovered = db.query("SELECT 17::int AS recovered", &[], None)?;
        assert_eq!(recovered.rows[0]["recovered"], json!(17));
    }

    db.close()?;
    Ok(())
}

#[test]
fn vector_extension_direct_transaction_commit_rollback_and_error_recovery() -> Result<()> {
    let _trace =
        TestTrace::new("vector_extension_direct_transaction_commit_rollback_and_error_recovery");
    let mut db = Oliphaunt::builder()
        .temporary()
        .extension(extensions::VECTOR)
        .open()?;
    db.exec(
        "CREATE TABLE vector_tx_items(id int PRIMARY KEY, embedding vector(3))",
        None,
    )?;

    db.transaction(|tx| {
        tx.query(
            "INSERT INTO vector_tx_items(id, embedding) VALUES ($1, $2::vector) \
             RETURNING embedding <-> '[1,2,4]'::vector AS distance",
            &[json!(1), json!("[1,2,3]")],
            None,
        )?;
        Ok::<_, anyhow::Error>(())
    })?;

    let rollback: anyhow::Result<()> = db.transaction(|tx| {
        tx.query(
            "INSERT INTO vector_tx_items(id, embedding) VALUES ($1, $2::vector)",
            &[json!(2), json!("[9,9,9]")],
            None,
        )?;
        Err(anyhow::anyhow!("force vector rollback"))
    });
    assert!(rollback.is_err());

    trace_expected("vector_direct_transaction invalid-vector-literal");
    let failed: anyhow::Result<()> = db.transaction(|tx| {
        tx.query(
            "INSERT INTO vector_tx_items(id, embedding) VALUES ($1, $2::vector)",
            &[json!(3), json!("[3,3,3]")],
            None,
        )?;
        tx.query(
            "SELECT $1::vector AS embedding",
            &[json!("[hello,1]")],
            None,
        )?;
        Ok(())
    });
    let failed = failed.expect_err("invalid vector should fail inside transaction");
    assert_oliphaunt_code(&failed, "22P02", "invalid input syntax for type vector");

    let result = db.query(
        "SELECT count(*)::int AS count, \
                min(embedding <-> '[1,2,4]'::vector)::float8 AS distance \
         FROM vector_tx_items",
        &[],
        None,
    )?;
    assert_eq!(result.rows[0]["count"], json!(1));
    assert_eq!(first_f64(&result, "distance"), 1.0);

    let recovered = db.query("SELECT 44::int AS recovered_after_vector_tx", &[], None)?;
    assert_eq!(recovered.rows[0]["recovered_after_vector_tx"], json!(44));

    db.close()?;
    Ok(())
}

#[test]
fn vector_extension_install_is_demand_driven_idempotent_and_persistent() -> Result<()> {
    let _trace =
        TestTrace::new("vector_extension_install_is_demand_driven_idempotent_and_persistent");
    let root = tempfile::TempDir::new()?;
    {
        let mut db = Oliphaunt::builder().path(root.path()).open()?;
        assert!(
            !db.paths()
                .pgroot
                .join("oliphaunt")
                .join("lib/postgresql/vector.so")
                .exists(),
            "vector side module should not be installed before it is requested"
        );

        db.enable_extension(extensions::VECTOR)?;
        db.enable_extension(extensions::VECTOR)?;
        assert!(
            db.paths()
                .pgroot
                .join("oliphaunt")
                .join("lib/postgresql/vector.so")
                .exists(),
            "vector side module should be installed after enable_extension"
        );

        let installed = db.query(
            "SELECT count(*)::int AS count FROM pg_extension WHERE extname = 'vector'",
            &[],
            None,
        )?;
        assert_eq!(installed.rows[0]["count"], json!(1));
        db.close()?;
    }

    {
        let mut reopened = Oliphaunt::builder().path(root.path()).open()?;
        let result = reopened.query("SELECT '[1,2,3]'::vector::text AS value", &[], None)?;
        assert_eq!(result.rows[0]["value"], json!("[1,2,3]"));
        reopened.close()?;
    }

    Ok(())
}

#[test]
fn pg_trgm_extension_direct_smoke() -> Result<()> {
    let _trace = TestTrace::new("pg_trgm_extension_direct_smoke");
    let mut db = Oliphaunt::builder()
        .temporary()
        .extension(extensions::PG_TRGM)
        .open()?;

    let result = db.query(
        "SELECT similarity('postgres', 'postgrex') AS score",
        &[],
        None,
    )?;
    assert!(first_f64(&result, "score") > 0.5);

    let installed = db.query(
        "SELECT count(*)::int AS count, max(n.nspname) AS schema_name \
         FROM pg_extension e \
         JOIN pg_namespace n ON n.oid = e.extnamespace \
         WHERE e.extname = 'pg_trgm'",
        &[],
        None,
    )?;
    assert_eq!(installed.rows[0]["count"], json!(1));
    assert_eq!(installed.rows[0]["schema_name"], json!("pg_catalog"));

    db.close()?;
    Ok(())
}

#[test]
fn hstore_extension_direct_smoke() -> Result<()> {
    let _trace = TestTrace::new("hstore_extension_direct_smoke");
    let mut db = Oliphaunt::builder()
        .temporary()
        .extension(extensions::HSTORE)
        .open()?;

    db.exec(
        "CREATE TEMP TABLE oxide_hstore (id serial PRIMARY KEY, data hstore)",
        None,
    )?;
    db.exec(
        "INSERT INTO oxide_hstore (data) VALUES ('\"name\"=>\"test1\"'), ('\"name\"=>\"test2\"')",
        None,
    )?;
    let result = db.query(
        "SELECT data::jsonb AS data FROM oxide_hstore WHERE data -> 'name' = 'test1'",
        &[],
        None,
    )?;
    assert_eq!(result.rows[0]["data"], json!({"name": "test1"}));

    let installed = db.query(
        "SELECT count(*)::int AS count, max(n.nspname) AS schema_name \
         FROM pg_extension e \
         JOIN pg_namespace n ON n.oid = e.extnamespace \
         WHERE e.extname = 'hstore'",
        &[],
        None,
    )?;
    assert_eq!(installed.rows[0]["count"], json!(1));
    assert_eq!(installed.rows[0]["schema_name"], json!("pg_catalog"));

    db.close()?;
    Ok(())
}

#[test]
fn hstore_extension_reopens_cleanly() -> Result<()> {
    let _trace = TestTrace::new("hstore_extension_reopens_cleanly");
    let root = tempfile::TempDir::new()?;
    {
        let mut db = Oliphaunt::builder()
            .path(root.path())
            .extension(extensions::HSTORE)
            .open()?;
        db.exec("CREATE TABLE oxide_hstore_restart (data hstore)", None)?;
        db.exec(
            "INSERT INTO oxide_hstore_restart VALUES ('\"name\"=>\"persisted\"')",
            None,
        )?;
        db.close()?;
    }

    {
        let mut reopened = Oliphaunt::builder().path(root.path()).open()?;
        let result = reopened.query(
            "SELECT data -> 'name' AS name FROM oxide_hstore_restart",
            &[],
            None,
        )?;
        assert_eq!(result.rows[0]["name"], json!("persisted"));
        reopened.close()?;
    }

    Ok(())
}

#[test]
fn pgcrypto_extension_direct_smoke() -> Result<()> {
    let _trace = TestTrace::new("pgcrypto_extension_direct_smoke");
    let mut db = Oliphaunt::builder()
        .temporary()
        .extension(extensions::PGCRYPTO)
        .open()?;

    db.exec(PGCRYPTO_FUNCTIONAL_SMOKE_SQL, None)?;

    let installed = db.query(
        "SELECT count(*)::int AS count, max(n.nspname) AS schema_name \
         FROM pg_extension e \
         JOIN pg_namespace n ON n.oid = e.extnamespace \
         WHERE e.extname = 'pgcrypto'",
        &[],
        None,
    )?;
    assert_eq!(installed.rows[0]["count"], json!(1));
    assert_eq!(installed.rows[0]["schema_name"], json!("public"));

    trace_expected("pgcrypto_direct invalid digest algorithm");
    let invalid_algorithm = db
        .query("SELECT digest('abc', 'not-a-digest')", &[], None)
        .expect_err("invalid pgcrypto digest algorithm should fail");
    assert_oliphaunt_code(
        &invalid_algorithm,
        "22023",
        "Cannot use \"not-a-digest\": No such hash algorithm",
    );
    let recovered = db.query(
        "SELECT 23::int AS recovered_after_pgcrypto_error",
        &[],
        None,
    )?;
    assert_eq!(
        recovered.rows[0]["recovered_after_pgcrypto_error"],
        json!(23)
    );

    db.close()?;
    Ok(())
}

#[test]
fn pgcrypto_extension_reopens_cleanly() -> Result<()> {
    let _trace = TestTrace::new("pgcrypto_extension_reopens_cleanly");
    let root = tempfile::TempDir::new()?;
    {
        let mut db = Oliphaunt::builder()
            .path(root.path())
            .extension(extensions::PGCRYPTO)
            .open()?;
        db.exec(PGCRYPTO_FUNCTIONAL_SMOKE_SQL, None)?;
        db.exec(
            "CREATE TABLE oxide_pgcrypto_restart AS \
             SELECT encode(digest('persisted', 'sha256'), 'hex') AS digest_hex",
            None,
        )?;
        db.close()?;
    }

    {
        let mut reopened = Oliphaunt::builder().path(root.path()).open()?;
        let result = reopened.query(
            "SELECT digest_hex = encode(digest('persisted', 'sha256'), 'hex') AS ok \
             FROM oxide_pgcrypto_restart",
            &[],
            None,
        )?;
        assert_eq!(result.rows[0]["ok"], json!(true));
        reopened.close()?;
    }

    Ok(())
}

#[test]
fn pgcrypto_extension_materializes_only_requested_assets() -> Result<()> {
    let _trace = TestTrace::new("pgcrypto_extension_materializes_only_requested_assets");
    let root = tempfile::TempDir::new()?;
    {
        let mut db = Oliphaunt::builder()
            .path(root.path())
            .extension(extensions::PGCRYPTO)
            .open()?;
        db.exec(PGCRYPTO_FUNCTIONAL_SMOKE_SQL, None)?;
        db.close()?;
    }

    assert_only_requested_extension_assets_are_materialized(root.path(), "pgcrypto", "vector");
    Ok(())
}

#[test]
fn multiple_extension_set_direct_smoke() -> Result<()> {
    let _trace = TestTrace::new("multiple_extension_set_direct_smoke");
    let mut db = Oliphaunt::builder()
        .temporary()
        .extensions([extensions::VECTOR, extensions::PG_TRGM])
        .open()?;

    let result = db.query(
        "SELECT \
            '[1,2,3]'::vector <-> '[1,2,4]'::vector AS distance, \
            similarity('postgres', 'postgrex') AS score",
        &[],
        None,
    )?;
    assert_eq!(first_f64(&result, "distance"), 1.0);
    assert!(first_f64(&result, "score") > 0.5);

    let installed = db.query(
        "SELECT count(*)::int AS count \
         FROM pg_extension \
         WHERE extname IN ('vector', 'pg_trgm')",
        &[],
        None,
    )?;
    assert_eq!(installed.rows[0]["count"], json!(2));

    db.close()?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn pg_trgm_extension_server_sqlx_smoke() -> Result<()> {
    let _trace = TestTrace::new("pg_trgm_extension_server_sqlx_smoke");
    let server = OliphauntServer::builder()
        .temporary()
        .extension(extensions::PG_TRGM)
        .start()?;
    let mut conn = sqlx::PgConnection::connect(&server.connection_uri()).await?;

    let row = sqlx::query("SELECT similarity('postgres', 'postgrex')::float8 AS score")
        .fetch_one(&mut conn)
        .await?;
    assert!(row.try_get::<f64, _>("score")? > 0.5);

    let row =
        sqlx::query("SELECT count(*)::int4 AS count FROM pg_extension WHERE extname = 'pg_trgm'")
            .fetch_one(&mut conn)
            .await?;
    assert_eq!(row.try_get::<i32, _>("count")?, 1);

    conn.close().await?;
    server.shutdown()?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn hstore_extension_server_sqlx_smoke() -> Result<()> {
    let _trace = TestTrace::new("hstore_extension_server_sqlx_smoke");
    let server = OliphauntServer::builder()
        .temporary()
        .extension(extensions::HSTORE)
        .start()?;
    let mut conn = sqlx::PgConnection::connect(&server.connection_uri()).await?;

    sqlx::query("CREATE TEMP TABLE oxide_hstore_sqlx (data hstore)")
        .execute(&mut conn)
        .await?;
    sqlx::query("INSERT INTO oxide_hstore_sqlx VALUES ('\"name\"=>\"test1\"')")
        .execute(&mut conn)
        .await?;
    let row = sqlx::query(
        "SELECT data -> 'name' AS name, \
         (SELECT count(*)::int4 FROM pg_extension WHERE extname = 'hstore') AS count \
         FROM oxide_hstore_sqlx",
    )
    .fetch_one(&mut conn)
    .await?;
    assert_eq!(row.try_get::<String, _>("name")?, "test1");
    assert_eq!(row.try_get::<i32, _>("count")?, 1);

    conn.close().await?;
    server.shutdown()?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn pgcrypto_extension_server_sqlx_smoke() -> Result<()> {
    let _trace = TestTrace::new("pgcrypto_extension_server_sqlx_smoke");
    let server = OliphauntServer::builder()
        .temporary()
        .extension(extensions::PGCRYPTO)
        .start()?;
    let mut conn = sqlx::PgConnection::connect(&server.connection_uri()).await?;

    sqlx::query(PGCRYPTO_FUNCTIONAL_SMOKE_SQL)
        .execute(&mut conn)
        .await?;
    let row =
        sqlx::query("SELECT count(*)::int4 AS count FROM pg_extension WHERE extname = 'pgcrypto'")
            .fetch_one(&mut conn)
            .await?;
    assert_eq!(row.try_get::<i32, _>("count")?, 1);

    conn.close().await?;
    server.shutdown()?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn vector_extension_server_sqlx_smoke() -> Result<()> {
    let _trace = TestTrace::new("vector_extension_server_sqlx_smoke");
    let server = OliphauntServer::builder()
        .temporary()
        .extension(extensions::VECTOR)
        .start()?;
    let mut conn = sqlx::PgConnection::connect(&server.connection_uri()).await?;

    sqlx::query("CREATE TABLE oxide_vec_server (embedding vector(3))")
        .execute(&mut conn)
        .await?;
    sqlx::query("INSERT INTO oxide_vec_server VALUES ('[1,2,3]')")
        .execute(&mut conn)
        .await?;
    let row =
        sqlx::query("SELECT embedding <-> '[1,2,4]'::vector AS distance FROM oxide_vec_server")
            .fetch_one(&mut conn)
            .await?;

    assert_eq!(row.try_get::<f64, _>("distance")?, 1.0);

    trace_expected("vector_server_sqlx division-by-zero");
    let err = sqlx::query("SELECT 10 / $1::int4 AS impossible_after_vector")
        .bind(0_i32)
        .fetch_one(&mut conn)
        .await
        .expect_err("division by zero after vector load should fail");
    assert_sqlx_code(&err, "22012");
    let row = sqlx::query("SELECT 14::int4 AS recovered_after_vector_error")
        .fetch_one(&mut conn)
        .await?;
    assert_eq!(row.try_get::<i32, _>("recovered_after_vector_error")?, 14);

    trace_expected("vector_server_sqlx invalid-vector-literal");
    let err = sqlx::query("SELECT $1::text::vector AS embedding")
        .bind("[hello,1]")
        .fetch_one(&mut conn)
        .await
        .expect_err("invalid vector input through SQLx should fail in the vector extension");
    assert_sqlx_code(&err, "22P02");
    let row = sqlx::query("SELECT 18::int4 AS recovered_after_invalid_vector")
        .fetch_one(&mut conn)
        .await?;
    assert_eq!(row.try_get::<i32, _>("recovered_after_invalid_vector")?, 18);

    trace_expected("vector_server_sqlx dimension-mismatch");
    let err = sqlx::query("SELECT $1::text::vector <-> $2::text::vector AS distance")
        .bind("[1,2]")
        .bind("[3]")
        .fetch_one(&mut conn)
        .await
        .expect_err("vector distance should reject mismatched dimensions through SQLx");
    assert_sqlx_code(&err, "22000");
    let row = sqlx::query("SELECT 19::int4 AS recovered_after_dimension_mismatch")
        .fetch_one(&mut conn)
        .await?;
    assert_eq!(
        row.try_get::<i32, _>("recovered_after_dimension_mismatch")?,
        19
    );

    conn.close().await?;
    server.shutdown()?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn vector_extension_server_sqlx_transaction_commit_rollback_and_error_recovery() -> Result<()>
{
    let _trace = TestTrace::new(
        "vector_extension_server_sqlx_transaction_commit_rollback_and_error_recovery",
    );
    let server = OliphauntServer::builder()
        .temporary()
        .extension(extensions::VECTOR)
        .start()?;
    let mut conn = sqlx::PgConnection::connect(&server.connection_uri()).await?;

    sqlx::query("CREATE TABLE vector_server_tx_items(id int PRIMARY KEY, embedding vector(3))")
        .execute(&mut conn)
        .await?;

    {
        let mut tx = conn.begin().await?;
        sqlx::query(
            "INSERT INTO vector_server_tx_items(id, embedding) VALUES ($1, $2::text::vector)",
        )
        .bind(1_i32)
        .bind("[1,2,3]")
        .execute(&mut *tx)
        .await?;
        let row = sqlx::query(
            "SELECT embedding <-> '[1,2,4]'::vector AS distance \
             FROM vector_server_tx_items WHERE id = 1",
        )
        .fetch_one(&mut *tx)
        .await?;
        assert_eq!(row.try_get::<f64, _>("distance")?, 1.0);
        tx.commit().await?;
    }

    {
        let mut tx = conn.begin().await?;
        sqlx::query(
            "INSERT INTO vector_server_tx_items(id, embedding) VALUES ($1, $2::text::vector)",
        )
        .bind(2_i32)
        .bind("[9,9,9]")
        .execute(&mut *tx)
        .await?;
        tx.rollback().await?;
    }

    {
        let mut tx = conn.begin().await?;
        sqlx::query(
            "INSERT INTO vector_server_tx_items(id, embedding) VALUES ($1, $2::text::vector)",
        )
        .bind(3_i32)
        .bind("[3,3,3]")
        .execute(&mut *tx)
        .await?;
        trace_expected("vector_server_sqlx_transaction invalid-vector-literal");
        let err = sqlx::query("SELECT $1::text::vector AS embedding")
            .bind("[hello,1]")
            .fetch_one(&mut *tx)
            .await
            .expect_err("invalid vector should fail inside SQLx transaction");
        assert_sqlx_code(&err, "22P02");
        trace_expected("vector_server_sqlx_transaction still-aborted");
        let aborted = sqlx::query("SELECT 1::int4 AS still_aborted")
            .fetch_one(&mut *tx)
            .await
            .expect_err("transaction should stay aborted after vector failure");
        assert_sqlx_code(&aborted, "25P02");
        tx.rollback().await?;
    }

    let row = sqlx::query(
        "SELECT count(*)::int4 AS count, \
                min(embedding <-> '[1,2,4]'::vector)::float8 AS distance \
         FROM vector_server_tx_items",
    )
    .fetch_one(&mut conn)
    .await?;
    assert_eq!(row.try_get::<i32, _>("count")?, 1);
    assert_eq!(row.try_get::<f64, _>("distance")?, 1.0);

    let row = sqlx::query("SELECT 45::int4 AS recovered_after_vector_tx")
        .fetch_one(&mut conn)
        .await?;
    assert_eq!(row.try_get::<i32, _>("recovered_after_vector_tx")?, 45);

    conn.close().await?;
    server.shutdown()?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn multiple_extension_set_server_sqlx_smoke() -> Result<()> {
    let _trace = TestTrace::new("multiple_extension_set_server_sqlx_smoke");
    let server = OliphauntServer::builder()
        .temporary()
        .extensions([extensions::VECTOR, extensions::PG_TRGM])
        .start()?;
    let mut conn = sqlx::PgConnection::connect(&server.connection_uri()).await?;

    let row = sqlx::query(
        "SELECT \
            '[1,2,3]'::vector <-> '[1,2,4]'::vector AS distance, \
            similarity('postgres', 'postgrex')::float8 AS score",
    )
    .fetch_one(&mut conn)
    .await?;
    assert_eq!(row.try_get::<f64, _>("distance")?, 1.0);
    assert!(row.try_get::<f64, _>("score")? > 0.5);

    let row = sqlx::query(
        "SELECT count(*)::int4 AS count \
         FROM pg_extension \
         WHERE extname IN ('vector', 'pg_trgm')",
    )
    .fetch_one(&mut conn)
    .await?;
    assert_eq!(row.try_get::<i32, _>("count")?, 2);

    conn.close().await?;
    server.shutdown()?;
    Ok(())
}
