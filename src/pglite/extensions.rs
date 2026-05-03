use std::collections::BTreeSet;

use anyhow::{Result, bail};

#[path = "generated_extensions.rs"]
mod generated;

pub use generated::*;

/// A bundled Postgres extension that can be installed into a PGlite database.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Extension {
    name: &'static str,
    sql_name: &'static str,
    archive_name: &'static str,
    native_module_file: Option<&'static str>,
    aot_name: Option<&'static str>,
    dependencies: &'static [&'static str],
    setup: ExtensionSetup,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct ExtensionSetup {
    create_extension: bool,
    create_schema: Option<&'static str>,
    load_sql: &'static [&'static str],
    post_create_sql: &'static [&'static str],
}

impl ExtensionSetup {
    pub(crate) const fn new(
        create_extension: bool,
        create_schema: Option<&'static str>,
        load_sql: &'static [&'static str],
        post_create_sql: &'static [&'static str],
    ) -> Self {
        Self {
            create_extension,
            create_schema,
            load_sql,
            post_create_sql,
        }
    }
}

impl Extension {
    #[allow(dead_code)]
    pub(crate) const fn new(
        name: &'static str,
        sql_name: &'static str,
        archive_name: &'static str,
        native_module_file: Option<&'static str>,
        aot_name: Option<&'static str>,
        dependencies: &'static [&'static str],
        setup: ExtensionSetup,
    ) -> Self {
        Self {
            name,
            sql_name,
            archive_name,
            native_module_file,
            aot_name,
            dependencies,
            setup,
        }
    }

    /// Human-facing extension name.
    pub const fn name(self) -> &'static str {
        self.name
    }

    /// SQL extension name used in `CREATE EXTENSION`.
    pub const fn sql_name(self) -> &'static str {
        self.sql_name
    }

    /// Archive path inside the asset manifest.
    pub const fn archive_name(self) -> &'static str {
        self.archive_name
    }

    /// AOT artifact key for the extension side module.
    pub const fn aot_name(self) -> Option<&'static str> {
        self.aot_name
    }

    /// Native side-module file installed into `/lib/postgresql`, when the
    /// extension has one.
    pub const fn native_module_file(self) -> Option<&'static str> {
        self.native_module_file
    }

    /// SQL extension names that must be installed before this extension.
    pub const fn dependencies(self) -> &'static [&'static str] {
        self.dependencies
    }

    pub(crate) const fn setup(self) -> ExtensionSetup {
        self.setup
    }
}

pub fn by_sql_name(sql_name: &str) -> Option<Extension> {
    ALL.iter()
        .copied()
        .find(|extension| extension.sql_name == sql_name)
}

pub(crate) fn candidate_by_sql_name(sql_name: &str) -> Option<Extension> {
    generated::CANDIDATES
        .iter()
        .copied()
        .find(|extension| extension.sql_name == sql_name)
}

pub(crate) fn resolve_extension_set(extensions: &[Extension]) -> Result<Vec<Extension>> {
    let mut visiting = BTreeSet::new();
    let mut visited = BTreeSet::new();
    let mut resolved = Vec::new();
    let mut requested = extensions.to_vec();
    requested.sort_by_key(|extension| extension.sql_name());
    for extension in requested {
        visit_extension(extension, &mut visiting, &mut visited, &mut resolved)?;
    }
    Ok(resolved)
}

fn visit_extension(
    extension: Extension,
    visiting: &mut BTreeSet<&'static str>,
    visited: &mut BTreeSet<&'static str>,
    resolved: &mut Vec<Extension>,
) -> Result<()> {
    if visited.contains(extension.sql_name()) {
        return Ok(());
    }
    if !visiting.insert(extension.sql_name()) {
        bail!(
            "cyclic bundled extension dependency involving '{}'",
            extension.sql_name()
        );
    }
    for dependency in extension.dependencies() {
        let dependency_extension = candidate_by_sql_name(dependency).ok_or_else(|| {
            anyhow::anyhow!(
                "bundled extension '{}' depends on missing packaged extension '{}'",
                extension.sql_name(),
                dependency
            )
        })?;
        visit_extension(dependency_extension, visiting, visited, resolved)?;
    }
    visiting.remove(extension.sql_name());
    visited.insert(extension.sql_name());
    resolved.push(extension);
    Ok(())
}

pub(crate) fn extension_setup_sql(extension: Extension) -> Vec<String> {
    let setup = extension.setup();
    let mut statements = Vec::new();
    if setup.create_extension {
        if let Some(schema) = setup.create_schema.filter(|schema| *schema != "pg_catalog") {
            statements.push(format!(
                "CREATE SCHEMA IF NOT EXISTS {};",
                crate::pglite::templating::quote_identifier(schema)
            ));
        }
        let mut sql = format!(
            "CREATE EXTENSION IF NOT EXISTS {}",
            crate::pglite::templating::quote_identifier(extension.sql_name())
        );
        if let Some(schema) = setup.create_schema {
            sql.push_str(" WITH SCHEMA ");
            sql.push_str(&crate::pglite::templating::quote_identifier(schema));
        }
        sql.push(';');
        statements.push(sql);
    }
    statements.extend(setup.load_sql.iter().map(|sql| (*sql).to_owned()));
    statements.extend(setup.post_create_sql.iter().map(|sql| (*sql).to_owned()));
    statements
}

pub(crate) fn extension_session_setup_sql(extension: Extension) -> Vec<String> {
    let setup = extension.setup();
    let mut statements = Vec::new();
    statements.extend(setup.load_sql.iter().map(|sql| (*sql).to_owned()));
    statements.extend(setup.post_create_sql.iter().map(|sql| (*sql).to_owned()));
    statements
}

#[cfg(all(test, feature = "extensions"))]
mod candidate_tests {
    use super::*;
    use crate::{Pglite, PgliteServer};
    use anyhow::{Context, Result, ensure};
    use sqlx::{Connection, PgConnection};
    use std::collections::BTreeSet;
    use std::path::{Path, PathBuf};

    #[test]
    fn public_extensions_pass_direct_and_restart_smoke() -> Result<()> {
        run_direct_and_restart_smoke_set(generated::ALL)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn public_extensions_pass_server_smoke() -> Result<()> {
        run_server_smoke_set(generated::ALL).await
    }

    #[test]
    fn public_extensions_materialize_only_requested_libraries() -> Result<()> {
        run_lifecycle_materialization_set(generated::ALL)
    }

    #[test]
    #[ignore = "promotion gate: run manually before marking packaged candidates stable"]
    fn packaged_candidate_extensions_pass_direct_and_restart_smoke() -> Result<()> {
        run_direct_and_restart_smoke_set(generated::CANDIDATES)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "promotion gate: run manually before marking packaged candidates stable"]
    async fn packaged_candidate_extensions_pass_server_smoke() -> Result<()> {
        run_server_smoke_set(generated::CANDIDATES).await
    }

    #[test]
    #[ignore = "promotion gate: run manually before marking packaged candidates stable"]
    fn packaged_candidate_extensions_materialize_only_requested_libraries() -> Result<()> {
        run_lifecycle_materialization_set(generated::CANDIDATES)
    }

    fn run_direct_and_restart_smoke_set(extensions: &[Extension]) -> Result<()> {
        let mut failures = Vec::new();
        for extension in extensions {
            if let Err(error) = run_one_direct_and_restart_smoke(*extension) {
                failures.push(format!("{}: {error:?}", extension.sql_name()));
            }
        }
        ensure!(
            failures.is_empty(),
            "extension direct/restart smoke failures:\n{}",
            failures.join("\n\n")
        );
        Ok(())
    }

    fn run_one_direct_and_restart_smoke(extension: Extension) -> Result<()> {
        let name = extension.sql_name();
        {
            let mut db = Pglite::builder()
                .temporary()
                .extension(extension)
                .open()
                .with_context(|| format!("open temporary database with extension {name}"))?;
            run_direct_smoke(&mut db, extension)?;
            db.close()
                .with_context(|| format!("close temporary database with extension {name}"))?;
        }

        let root = tempfile::TempDir::new()
            .with_context(|| format!("create restart root for extension {name}"))?;
        {
            let mut db = Pglite::builder()
                .path(root.path())
                .extension(extension)
                .open()
                .with_context(|| {
                    format!("open persistent database with extension {name} before restart")
                })?;
            run_direct_smoke(&mut db, extension)?;
            assert_extension_catalog_state(&mut db, extension)?;
            db.close()
                .with_context(|| format!("close persistent database with extension {name}"))?;
        }
        {
            let mut db = Pglite::builder()
                .path(root.path())
                .extension(extension)
                .open()
                .with_context(|| {
                    format!("reopen persistent database with extension {name} after restart")
                })?;
            assert_extension_catalog_state(&mut db, extension)?;
            db.close()
                .with_context(|| format!("close restarted database with extension {name}"))?;
        }
        Ok(())
    }

    async fn run_server_smoke_set(extensions: &[Extension]) -> Result<()> {
        let mut failures = Vec::new();
        for extension in extensions {
            if let Err(error) = run_one_server_smoke(*extension).await {
                failures.push(format!("{}: {error:?}", extension.sql_name()));
            }
        }
        ensure!(
            failures.is_empty(),
            "extension server smoke failures:\n{}",
            failures.join("\n\n")
        );
        Ok(())
    }

    async fn run_one_server_smoke(extension: Extension) -> Result<()> {
        let name = extension.sql_name();
        let server = PgliteServer::builder()
            .temporary()
            .extension(extension)
            .start()
            .with_context(|| format!("start server with extension {name}"))?;
        let mut conn = PgConnection::connect(&server.database_url())
            .await
            .with_context(|| format!("connect server with extension {name}"))?;
        run_server_smoke(&mut conn, extension).await?;
        drop(conn);
        server
            .shutdown()
            .with_context(|| format!("shutdown server with extension {name}"))?;
        Ok(())
    }

    fn run_lifecycle_materialization_set(extensions: &[Extension]) -> Result<()> {
        let mut failures = Vec::new();
        for extension in extensions {
            if let Err(error) = run_one_lifecycle_materialization(*extension) {
                failures.push(format!("{}: {error:?}", extension.sql_name()));
            }
        }
        ensure!(
            failures.is_empty(),
            "extension lifecycle/materialization failures:\n{}",
            failures.join("\n\n")
        );
        Ok(())
    }

    fn run_one_lifecycle_materialization(extension: Extension) -> Result<()> {
        let name = extension.sql_name();
        let root = tempfile::TempDir::new()
            .with_context(|| format!("create lifecycle root for extension {name}"))?;
        {
            let mut db = Pglite::builder()
                .path(root.path())
                .extension(extension)
                .open()
                .with_context(|| format!("open lifecycle database with extension {name}"))?;
            db.close()
                .with_context(|| format!("close lifecycle database with extension {name}"))?;
        }
        assert_only_resolved_extension_libraries_are_materialized(root.path(), extension)
    }

    fn run_direct_smoke(db: &mut Pglite, extension: Extension) -> Result<()> {
        for statement in smoke_sql(extension.sql_name()) {
            db.exec(statement, None).with_context(|| {
                format!(
                    "direct smoke failed for extension {} while running:\n{}",
                    extension.sql_name(),
                    statement
                )
            })?;
        }
        Ok(())
    }

    async fn run_server_smoke(conn: &mut PgConnection, extension: Extension) -> Result<()> {
        for statement in smoke_sql(extension.sql_name()) {
            sqlx::query(statement)
                .fetch_all(&mut *conn)
                .await
                .with_context(|| {
                    format!(
                        "server smoke failed for extension {} while running:\n{}",
                        extension.sql_name(),
                        statement
                    )
                })?;
        }
        Ok(())
    }

    fn assert_extension_catalog_state(db: &mut Pglite, extension: Extension) -> Result<()> {
        if extension.setup().create_extension {
            let result = db.query(
                "SELECT count(*)::int4 AS count FROM pg_extension WHERE extname = $1",
                &[serde_json::json!(extension.sql_name())],
                None,
            )?;
            ensure!(
                result.rows[0]["count"] == serde_json::json!(1),
                "extension {} should survive restart in pg_extension",
                extension.sql_name()
            );
        } else {
            let result = db.query("SELECT 1::int4 AS ok", &[], None)?;
            ensure!(
                result.rows[0]["ok"] == serde_json::json!(1),
                "extension {} should reopen cleanly",
                extension.sql_name()
            );
        }
        Ok(())
    }

    fn assert_only_resolved_extension_libraries_are_materialized(
        root: &Path,
        extension: Extension,
    ) -> Result<()> {
        let expected = resolve_extension_set(&[extension])?
            .into_iter()
            .filter_map(|extension| extension.native_module_file().map(PathBuf::from))
            .collect::<BTreeSet<_>>();
        let actual = relative_files(&root.join("tmp/pglite/lib/postgresql"))
            .into_iter()
            .collect::<BTreeSet<_>>();
        ensure!(
            actual == expected,
            "upper runtime library layer for {} should contain only resolved requested libraries; expected {:?}, got {:?}",
            extension.sql_name(),
            expected,
            actual
        );
        Ok(())
    }

    fn relative_files(root: &Path) -> Vec<PathBuf> {
        fn walk(base: &Path, current: &Path, files: &mut Vec<PathBuf>) {
            let Ok(entries) = std::fs::read_dir(current) else {
                return;
            };
            for entry in entries {
                let entry = entry.expect("read runtime test directory entry");
                let path = entry.path();
                if path.is_dir() {
                    walk(base, &path, files);
                } else if path.is_file() {
                    files.push(
                        path.strip_prefix(base)
                            .expect("relative extension library path")
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

    fn smoke_sql(sql_name: &str) -> &'static [&'static str] {
        // These are compact Rust ports of the PGlite extension smoke tests in
        // assets/checkouts/pglite/packages/pglite/tests.
        match sql_name {
            "age" => &[
                "SELECT ag_catalog.create_graph('oxide_graph')",
                "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM ag_catalog.ag_graph WHERE name = 'oxide_graph') THEN RAISE EXCEPTION 'age graph was not created'; END IF; END $$",
                "SELECT * FROM ag_catalog.cypher('oxide_graph', $$ RETURN 1 $$) AS (one agtype)",
            ],
            "amcheck" => &[
                "CREATE TEMP TABLE oxide_amcheck (id int PRIMARY KEY, value text)",
                "INSERT INTO oxide_amcheck SELECT i, 'v' || i::text FROM generate_series(1, 8) AS i",
                "SELECT bt_index_check('oxide_amcheck_pkey'::regclass)",
            ],
            "auto_explain" => &["EXPLAIN SELECT count(*) FROM pg_class"],
            "bloom" => &[
                "CREATE TEMP TABLE oxide_bloom (id int, value int)",
                "CREATE INDEX oxide_bloom_idx ON oxide_bloom USING bloom (id, value)",
                "INSERT INTO oxide_bloom SELECT i, i % 3 FROM generate_series(1, 20) AS i",
                "DO $$ DECLARE n int; BEGIN SELECT count(*) INTO n FROM oxide_bloom WHERE id = 7 AND value = 1; IF n <> 1 THEN RAISE EXCEPTION 'bloom lookup failed: %', n; END IF; END $$",
            ],
            "btree_gin" => &[
                "CREATE TEMP TABLE oxide_btree_gin (id int)",
                "CREATE INDEX oxide_btree_gin_idx ON oxide_btree_gin USING gin (id)",
                "INSERT INTO oxide_btree_gin SELECT generate_series(1, 10)",
                "DO $$ DECLARE n int; BEGIN SELECT count(*) INTO n FROM oxide_btree_gin WHERE id = 5; IF n <> 1 THEN RAISE EXCEPTION 'btree_gin lookup failed: %', n; END IF; END $$",
            ],
            "btree_gist" => &[
                "CREATE TEMP TABLE oxide_btree_gist (id int)",
                "CREATE INDEX oxide_btree_gist_idx ON oxide_btree_gist USING gist (id)",
                "INSERT INTO oxide_btree_gist SELECT generate_series(1, 10)",
                "DO $$ DECLARE n int; BEGIN SELECT count(*) INTO n FROM oxide_btree_gist WHERE id = 5; IF n <> 1 THEN RAISE EXCEPTION 'btree_gist lookup failed: %', n; END IF; END $$",
            ],
            "citext" => &[
                "CREATE TEMP TABLE oxide_citext (value citext)",
                "INSERT INTO oxide_citext VALUES ('Postgres')",
                "DO $$ DECLARE n int; BEGIN SELECT count(*) INTO n FROM oxide_citext WHERE value = 'postgres'; IF n <> 1 THEN RAISE EXCEPTION 'citext comparison failed: %', n; END IF; END $$",
            ],
            "cube" => &[
                "DO $$ DECLARE d float8; BEGIN SELECT cube(array[1,2,3]) <-> cube(array[1,2,4]) INTO d; IF d <> 1 THEN RAISE EXCEPTION 'cube distance failed: %', d; END IF; END $$",
            ],
            "dict_int" => &[
                "DO $$ DECLARE lex text; BEGIN SELECT array_to_string(ts_lexize('intdict', '40865854'), ',') INTO lex; IF lex <> '408658' THEN RAISE EXCEPTION 'dict_int lexize failed: %', lex; END IF; END $$",
            ],
            "dict_xsyn" => &[
                "ALTER TEXT SEARCH DICTIONARY xsyn (RULES = 'xsyn_sample', KEEPORIG = true, MATCHORIG = true, KEEPSYNONYMS = true, MATCHSYNONYMS = false)",
                "DO $$ DECLARE lex text; BEGIN SELECT array_to_string(ts_lexize('xsyn', 'supernova'), ',') INTO lex; IF lex IS NULL OR lex !~ 'sn' THEN RAISE EXCEPTION 'dict_xsyn lexize failed: %', lex; END IF; END $$",
            ],
            "earthdistance" => &[
                "DO $$ DECLARE d float8; BEGIN SELECT earth_distance(ll_to_earth(0, 0), ll_to_earth(0, 1)) INTO d; IF d <= 0 THEN RAISE EXCEPTION 'earthdistance failed: %', d; END IF; END $$",
            ],
            "file_fdw" => &[
                "CREATE SERVER oxide_file_server FOREIGN DATA WRAPPER file_fdw",
                "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_foreign_data_wrapper WHERE fdwname = 'file_fdw') THEN RAISE EXCEPTION 'file_fdw wrapper missing'; END IF; END $$",
            ],
            "fuzzystrmatch" => &[
                "DO $$ BEGIN IF levenshtein('kitten', 'sitting') <> 3 THEN RAISE EXCEPTION 'levenshtein failed'; END IF; IF soundex('kitten') <> 'K350' THEN RAISE EXCEPTION 'soundex failed'; END IF; END $$",
            ],
            "hstore" => &[
                "CREATE TEMP TABLE oxide_hstore (attrs hstore)",
                "INSERT INTO oxide_hstore VALUES ('a=>1,b=>2'::hstore)",
                "DO $$ DECLARE v text; BEGIN SELECT attrs -> 'b' INTO v FROM oxide_hstore; IF v <> '2' THEN RAISE EXCEPTION 'hstore lookup failed: %', v; END IF; END $$",
            ],
            "intarray" => &[
                "CREATE TEMP TABLE oxide_intarray (tags int[])",
                "INSERT INTO oxide_intarray VALUES (ARRAY[1, 2, 5]), (ARRAY[3, 4])",
                "DO $$ DECLARE n int; BEGIN SELECT count(*) INTO n FROM oxide_intarray WHERE tags && ARRAY[2, 9]; IF n <> 1 THEN RAISE EXCEPTION 'intarray overlap failed: %', n; END IF; SELECT count(*) INTO n FROM oxide_intarray WHERE tags @@ '1 & (2|3)'::query_int; IF n <> 1 THEN RAISE EXCEPTION 'intarray query_int failed: %', n; END IF; END $$",
            ],
            "isn" => &[
                "DO $$ BEGIN IF isbn('978-0-393-04002-9')::text <> '0-393-04002-X' THEN RAISE EXCEPTION 'isbn failed'; END IF; IF isbn13('0901690546')::text <> '978-0-901690-54-8' THEN RAISE EXCEPTION 'isbn13 failed'; END IF; IF issn('1436-4522')::text <> '1436-4522' THEN RAISE EXCEPTION 'issn failed'; END IF; END $$",
            ],
            "lo" => &[
                "CREATE TEMP TABLE oxide_lo (id int, data oid)",
                "CREATE TRIGGER oxide_lo_manage BEFORE UPDATE OR DELETE ON oxide_lo FOR EACH ROW EXECUTE FUNCTION lo_manage(data)",
                "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'oxide_lo_manage') THEN RAISE EXCEPTION 'lo trigger missing'; END IF; END $$",
            ],
            "ltree" => &[
                "CREATE TEMP TABLE oxide_ltree (path ltree)",
                "INSERT INTO oxide_ltree VALUES ('Top.Science.Astronomy'), ('Top.Collections.Pictures')",
                "DO $$ DECLARE n int; BEGIN SELECT count(*) INTO n FROM oxide_ltree WHERE path <@ 'Top.Science'; IF n <> 1 THEN RAISE EXCEPTION 'ltree ancestor query failed: %', n; END IF; END $$",
            ],
            "pageinspect" => &[
                "CREATE TEMP TABLE oxide_pageinspect (id int)",
                "INSERT INTO oxide_pageinspect SELECT generate_series(1, 5)",
                "SELECT * FROM page_header(get_raw_page('oxide_pageinspect', 0))",
            ],
            "pg_buffercache" => &[
                "SELECT * FROM pg_buffercache_summary()",
                "SELECT * FROM pg_buffercache_usage_counts()",
            ],
            "pg_freespacemap" => &[
                "CREATE TEMP TABLE oxide_fsm (id int, value text)",
                "INSERT INTO oxide_fsm SELECT i, repeat('x', 200) FROM generate_series(1, 20) AS i",
                "DELETE FROM oxide_fsm WHERE id % 2 = 0",
                "SELECT * FROM pg_freespace('oxide_fsm') LIMIT 1",
            ],
            "pg_hashids" => &[
                "DO $$ BEGIN IF id_encode(1001) <> 'jNl' THEN RAISE EXCEPTION 'pg_hashids encode failed'; END IF; IF id_decode_once('jNl') <> 1001 THEN RAISE EXCEPTION 'pg_hashids decode failed'; END IF; END $$",
            ],
            "pg_ivm" => &[
                "CREATE TABLE oxide_ivm_orders (id int, amount int)",
                "INSERT INTO oxide_ivm_orders VALUES (1, 10), (2, 20)",
                "SELECT pgivm.create_immv('oxide_ivm_summary', $$ SELECT id, amount FROM oxide_ivm_orders $$)",
                "DO $$ DECLARE n int; BEGIN SELECT count(*) INTO n FROM oxide_ivm_summary; IF n <> 2 THEN RAISE EXCEPTION 'pg_ivm initial count failed: %', n; END IF; END $$",
            ],
            "pg_surgery" => &[
                "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'heap_force_kill') THEN RAISE EXCEPTION 'pg_surgery function missing'; END IF; END $$",
            ],
            "pg_textsearch" => &[
                "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_am WHERE amname = 'bm25') THEN RAISE EXCEPTION 'bm25 access method missing'; END IF; END $$",
                "SELECT to_bm25query('postgres wasm')",
            ],
            "pg_trgm" => &[
                "DO $$ DECLARE score float8; BEGIN SELECT similarity('postgres', 'postgrex') INTO score; IF score <= 0 THEN RAISE EXCEPTION 'pg_trgm similarity failed: %', score; END IF; END $$",
            ],
            "pg_uuidv7" => &[
                "DO $$ DECLARE id uuid; ts timestamptz; BEGIN SELECT uuid_generate_v7() INTO id; IF length(id::text) <> 36 THEN RAISE EXCEPTION 'uuidv7 length failed'; END IF; SELECT uuid_v7_to_timestamptz('018570bb-4a7d-7c7e-8df4-6d47afd8c8fc') INTO ts; IF ts IS NULL THEN RAISE EXCEPTION 'uuidv7 timestamp failed'; END IF; END $$",
            ],
            "pg_visibility" => &[
                "CREATE TEMP TABLE oxide_visibility (id int)",
                "INSERT INTO oxide_visibility SELECT generate_series(1, 5)",
                "SELECT * FROM pg_visibility('oxide_visibility') LIMIT 1",
                "SELECT * FROM pg_visibility_map('oxide_visibility') LIMIT 1",
            ],
            "pg_walinspect" => &[
                "CREATE TEMP TABLE oxide_walinspect (value text)",
                "CREATE TEMP TABLE oxide_walinspect_lsn AS SELECT pg_current_wal_lsn() AS before_lsn",
                "INSERT INTO oxide_walinspect SELECT 'row ' || i::text FROM generate_series(1, 5) AS i",
                "SELECT * FROM pg_get_wal_block_info((SELECT before_lsn FROM oxide_walinspect_lsn), pg_current_wal_lsn()) ORDER BY start_lsn, block_id LIMIT 20",
            ],
            "pgtap" => &[
                "BEGIN",
                "SELECT plan(1)",
                "SELECT pass('pgtap smoke')",
                "SELECT * FROM finish()",
                "ROLLBACK",
            ],
            "seg" => &[
                "DO $$ BEGIN IF '7(+-)1'::seg::text <> '6 .. 8' THEN RAISE EXCEPTION 'seg cast failed'; END IF; END $$",
            ],
            "tablefunc" => &[
                "DO $$ DECLARE n int; BEGIN SELECT count(*) INTO n FROM normal_rand(10, 5, 3); IF n <> 10 THEN RAISE EXCEPTION 'normal_rand failed: %', n; END IF; END $$",
                "SELECT * FROM crosstab('SELECT 1, 1, 10 UNION ALL SELECT 1, 2, 20') AS ct(rowid int, c1 int, c2 int)",
            ],
            "tcn" => &[
                "CREATE TEMP TABLE oxide_tcn (id int PRIMARY KEY, value text)",
                "CREATE TRIGGER oxide_tcn_trigger AFTER INSERT OR UPDATE OR DELETE ON oxide_tcn FOR EACH ROW EXECUTE FUNCTION triggered_change_notification()",
                "INSERT INTO oxide_tcn VALUES (1, 'one')",
            ],
            "tsm_system_rows" => &[
                "CREATE TEMP TABLE oxide_tsm_rows AS SELECT i FROM generate_series(1, 20) AS i",
                "SELECT * FROM oxide_tsm_rows TABLESAMPLE SYSTEM_ROWS(5)",
            ],
            "tsm_system_time" => &[
                "CREATE TEMP TABLE oxide_tsm_time AS SELECT i FROM generate_series(1, 20) AS i",
                "SELECT * FROM oxide_tsm_time TABLESAMPLE SYSTEM_TIME(50)",
            ],
            "unaccent" => &[
                "DO $$ DECLARE lex text; BEGIN SELECT array_to_string(ts_lexize('unaccent', 'Hôtel'), ',') INTO lex; IF lex <> 'Hotel' THEN RAISE EXCEPTION 'unaccent failed: %', lex; END IF; END $$",
            ],
            "vector" => &[
                "CREATE TEMP TABLE oxide_vector (embedding vector(3))",
                "INSERT INTO oxide_vector VALUES ('[1,2,3]')",
                "DO $$ DECLARE d float8; BEGIN SELECT embedding <-> '[1,2,4]'::vector INTO d FROM oxide_vector; IF d <> 1 THEN RAISE EXCEPTION 'vector distance failed: %', d; END IF; END $$",
            ],
            other => panic!("missing smoke SQL for packaged extension candidate {other}"),
        }
    }
}
