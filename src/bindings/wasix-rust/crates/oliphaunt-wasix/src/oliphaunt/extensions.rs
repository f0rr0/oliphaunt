use std::collections::BTreeSet;

use anyhow::{Result, bail};

#[path = "generated_extensions.rs"]
mod generated;

pub use generated::*;

/// A native WASIX side module required by a bundled extension.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ExtensionNativeModule {
    runtime_path: &'static str,
    aot_name: Option<&'static str>,
}

impl ExtensionNativeModule {
    pub(crate) const fn new(runtime_path: &'static str, aot_name: Option<&'static str>) -> Self {
        Self {
            runtime_path,
            aot_name,
        }
    }

    pub const fn runtime_path(self) -> &'static str {
        self.runtime_path
    }

    pub const fn aot_name(self) -> Option<&'static str> {
        self.aot_name
    }
}

/// A bundled Postgres extension that can be installed into a Oliphaunt database.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Extension {
    name: &'static str,
    sql_name: &'static str,
    archive_name: &'static str,
    native_support_modules: &'static [ExtensionNativeModule],
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
        native_support_modules: &'static [ExtensionNativeModule],
        native_module_file: Option<&'static str>,
        aot_name: Option<&'static str>,
        dependencies: &'static [&'static str],
        setup: ExtensionSetup,
    ) -> Self {
        Self {
            name,
            sql_name,
            archive_name,
            native_support_modules,
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

    /// Support side modules that must be available before the extension module
    /// is loaded.
    pub const fn native_support_modules(self) -> &'static [ExtensionNativeModule] {
        self.native_support_modules
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
                "selected extension '{}' depends on missing catalog extension '{}'",
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
    extension_setup_sql_with_schema_policy(extension)
}

fn extension_setup_sql_with_schema_policy(extension: Extension) -> Vec<String> {
    let setup = extension.setup();
    let mut statements = Vec::new();
    if setup.create_extension {
        let create_schema = setup.create_schema;
        if let Some(schema) = create_schema.filter(|schema| *schema != "pg_catalog") {
            statements.push(format!(
                "CREATE SCHEMA IF NOT EXISTS {};",
                crate::oliphaunt::templating::quote_identifier(schema)
            ));
        }
        let mut sql = format!(
            "CREATE EXTENSION IF NOT EXISTS {}",
            crate::oliphaunt::templating::quote_identifier(extension.sql_name())
        );
        if let Some(schema) = create_schema {
            sql.push_str(" WITH SCHEMA ");
            sql.push_str(&crate::oliphaunt::templating::quote_identifier(schema));
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
    #[cfg(feature = "tools")]
    use crate::PgDumpOptions;
    use crate::{Oliphaunt, OliphauntServer};
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
    #[cfg(feature = "tools")]
    fn public_extensions_pass_direct_dump_restore_smoke() -> Result<()> {
        run_direct_dump_restore_smoke_set(generated::ALL)
    }

    #[test]
    #[ignore = "promotion gate: run manually before marking packaged candidates stable"]
    fn packaged_candidate_extensions_pass_direct_and_restart_smoke() -> Result<()> {
        run_direct_and_restart_smoke_set(generated::CANDIDATES)
    }

    #[test]
    fn uuid_ossp_candidate_passes_direct_and_restart_smoke() -> Result<()> {
        run_direct_and_restart_smoke_set(&[generated::CANDIDATE_UUID_OSSP])
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "promotion gate: run manually before marking packaged candidates stable"]
    async fn packaged_candidate_extensions_pass_server_smoke() -> Result<()> {
        run_server_smoke_set(generated::CANDIDATES).await
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn uuid_ossp_candidate_passes_server_smoke() -> Result<()> {
        run_server_smoke_set(&[generated::CANDIDATE_UUID_OSSP]).await
    }

    #[test]
    #[ignore = "promotion gate: run manually before marking packaged candidates stable"]
    fn packaged_candidate_extensions_materialize_only_requested_libraries() -> Result<()> {
        run_lifecycle_materialization_set(generated::CANDIDATES)
    }

    #[test]
    fn uuid_ossp_candidate_materializes_only_requested_libraries() -> Result<()> {
        run_lifecycle_materialization_set(&[generated::CANDIDATE_UUID_OSSP])
    }

    #[test]
    #[ignore = "promotion gate: run manually before marking packaged candidates stable"]
    #[cfg(feature = "tools")]
    fn packaged_candidate_extensions_pass_direct_dump_restore_smoke() -> Result<()> {
        run_direct_dump_restore_smoke_set(generated::CANDIDATES)
    }

    #[test]
    #[cfg(feature = "tools")]
    fn uuid_ossp_candidate_passes_direct_dump_restore_smoke() -> Result<()> {
        run_direct_dump_restore_smoke_set(&[generated::CANDIDATE_UUID_OSSP])
    }

    fn embedded_extension_archives(extensions: &[Extension]) -> Result<Vec<Extension>> {
        let embedded: Vec<_> = extensions
            .iter()
            .copied()
            .filter(|extension| {
                crate::oliphaunt::assets::extension_archive(extension.sql_name()).is_some()
            })
            .collect();
        let embedded_names: BTreeSet<_> = embedded
            .iter()
            .map(|extension| extension.sql_name())
            .collect();
        let missing: Vec<_> = extensions
            .iter()
            .map(|extension| extension.sql_name())
            .filter(|name| !embedded_names.contains(name))
            .collect();
        ensure!(
            missing.is_empty(),
            "required WASIX extension archives are not embedded: {}",
            missing.join(", ")
        );
        Ok(embedded)
    }

    fn run_direct_and_restart_smoke_set(extensions: &[Extension]) -> Result<()> {
        let extensions = embedded_extension_archives(extensions)?;
        let mut failures = Vec::new();
        for extension in extensions {
            if let Err(error) = run_one_direct_and_restart_smoke(extension) {
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
            let mut db = Oliphaunt::builder()
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
            let mut db = Oliphaunt::builder()
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
            let mut db = Oliphaunt::builder()
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
        let extensions = embedded_extension_archives(extensions)?;
        let mut failures = Vec::new();
        for extension in extensions {
            if let Err(error) = run_one_server_smoke(extension).await {
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
        let server = OliphauntServer::builder()
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
        let extensions = embedded_extension_archives(extensions)?;
        let mut failures = Vec::new();
        for extension in extensions {
            if let Err(error) = run_one_lifecycle_materialization(extension) {
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
            let mut db = Oliphaunt::builder()
                .path(root.path())
                .extension(extension)
                .open()
                .with_context(|| format!("open lifecycle database with extension {name}"))?;
            db.close()
                .with_context(|| format!("close lifecycle database with extension {name}"))?;
        }
        assert_only_resolved_extension_libraries_are_materialized(root.path(), extension)
    }

    #[cfg(feature = "tools")]
    fn run_direct_dump_restore_smoke_set(extensions: &[Extension]) -> Result<()> {
        let extensions = embedded_extension_archives(extensions)?;
        let mut failures = Vec::new();
        for extension in extensions {
            if let Err(error) = run_one_direct_dump_restore_smoke(extension) {
                failures.push(format!("{}: {error:?}", extension.sql_name()));
            }
        }
        ensure!(
            failures.is_empty(),
            "extension direct dump/restore smoke failures:\n{}",
            failures.join("\n\n")
        );
        Ok(())
    }

    #[cfg(feature = "tools")]
    fn run_one_direct_dump_restore_smoke(extension: Extension) -> Result<()> {
        let name = extension.sql_name();
        let dump = {
            let mut db = Oliphaunt::builder()
                .temporary()
                .extension(extension)
                .open()
                .with_context(|| format!("open dump source database with extension {name}"))?;
            assert_extension_catalog_state(&mut db, extension)?;
            db.exec(
                "CREATE TABLE oxide_extension_dump_marker(value text);
                 INSERT INTO oxide_extension_dump_marker VALUES ('restored');",
                None,
            )
            .with_context(|| format!("seed dump source database with extension {name}"))?;
            let dump = db
                .dump_sql(PgDumpOptions::new())
                .with_context(|| format!("dump source database with extension {name}"))?;
            db.close()
                .with_context(|| format!("close dump source database with extension {name}"))?;
            dump
        };

        if extension.setup().create_extension {
            let unquoted_needle =
                format!("CREATE EXTENSION IF NOT EXISTS {}", extension.sql_name());
            let quoted_needle = format!(
                "CREATE EXTENSION IF NOT EXISTS {}",
                crate::oliphaunt::templating::quote_identifier(extension.sql_name())
            );
            ensure!(
                dump.contains(&unquoted_needle) || dump.contains(&quoted_needle),
                "pg_dump for extension {} should contain {:?} or {:?}; dump was:\n{}",
                extension.sql_name(),
                unquoted_needle,
                quoted_needle,
                dump
            );
        }

        let mut restored = Oliphaunt::builder()
            .temporary()
            .extension(extension)
            .open()
            .with_context(|| format!("open dump restore database with extension {name}"))?;
        restored
            .exec(&dump, None)
            .with_context(|| format!("restore dump SQL with extension {name}"))?;
        restored
            .exec("SET search_path TO public, pg_catalog", None)
            .with_context(|| {
                format!("reset restore session search_path after pg_dump SQL for extension {name}")
            })?;
        assert_extension_catalog_state(&mut restored, extension)?;
        let marker = restored.query(
            "SELECT value FROM public.oxide_extension_dump_marker",
            &[],
            None,
        )?;
        ensure!(
            marker.rows[0]["value"] == serde_json::json!("restored"),
            "extension {} dump marker did not restore",
            extension.sql_name()
        );
        run_direct_smoke(&mut restored, extension)?;
        restored
            .close()
            .with_context(|| format!("close dump restore database with extension {name}"))?;
        Ok(())
    }

    fn run_direct_smoke(db: &mut Oliphaunt, extension: Extension) -> Result<()> {
        for statement in smoke_sql(extension.sql_name()).statements() {
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
        for statement in smoke_sql(extension.sql_name()).statements() {
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

    fn assert_extension_catalog_state(db: &mut Oliphaunt, extension: Extension) -> Result<()> {
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
            .flat_map(|extension| {
                let mut modules = extension
                    .native_support_modules()
                    .iter()
                    .map(|module| {
                        PathBuf::from(module.runtime_path())
                            .strip_prefix("lib/postgresql")
                            .map(PathBuf::from)
                            .unwrap_or_else(|_| PathBuf::from(module.runtime_path()))
                    })
                    .collect::<Vec<_>>();
                if let Some(module) = extension.native_module_file() {
                    modules.push(PathBuf::from(module));
                }
                modules
            })
            .collect::<BTreeSet<_>>();
        let actual = relative_files(&root.join("tmp/oliphaunt/lib/postgresql"))
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

    const POSTGIS_SMOKE_SQL: &str =
        include_str!("../../../../../../extensions/external/postgis/tests/smoke.sql");

    enum SmokeSql {
        Inline(&'static [&'static str]),
        Recipe(&'static str),
    }

    impl SmokeSql {
        fn statements(&self) -> Vec<&'static str> {
            match self {
                Self::Inline(statements) => statements.to_vec(),
                Self::Recipe(sql) => sql
                    .split("-- oliphaunt-statement")
                    .map(str::trim)
                    .filter(|statement| !statement.is_empty())
                    .collect(),
            }
        }
    }

    fn smoke_sql(sql_name: &str) -> SmokeSql {
        if sql_name == "postgis" {
            return SmokeSql::Recipe(POSTGIS_SMOKE_SQL);
        }
        SmokeSql::Inline(inline_smoke_sql(sql_name))
    }

    fn inline_smoke_sql(sql_name: &str) -> &'static [&'static str] {
        // These are compact Rust ports of the Oliphaunt extension smoke tests in
        // src/extensions tests.
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
            "pgcrypto" => &[
                "DO $$ DECLARE hashed text; encrypted bytea; BEGIN IF encode(digest('abc', 'sha256'), 'hex') <> 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' THEN RAISE EXCEPTION 'sha256 digest failed'; END IF; IF length(gen_random_bytes(16)) <> 16 THEN RAISE EXCEPTION 'random bytes length failed'; END IF; SELECT crypt('secret', gen_salt('bf', 4)) INTO hashed; IF crypt('secret', hashed) <> hashed THEN RAISE EXCEPTION 'password hash verify failed'; END IF; SELECT pgp_sym_encrypt('oliphaunt secret', 'passphrase') INTO encrypted; IF pgp_sym_decrypt(encrypted, 'passphrase') <> 'oliphaunt secret' THEN RAISE EXCEPTION 'PGP symmetric decrypt failed'; END IF; END $$",
                "DO $$ BEGIN IF encode(hmac('test', 'key', 'sha1'), 'hex') <> '671f54ce0c540f78ffe1e26dcf9c2a047aea4fda' THEN RAISE EXCEPTION 'hmac failed'; END IF; IF gen_random_uuid()::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'random uuid format failed'; END IF; END $$",
                "DO $$ DECLARE armored text; header_count int; BEGIN SELECT armor(digest('test', 'sha1'), ARRAY['Version'], ARRAY['oliphaunt']) INTO armored; IF position('Version: oliphaunt' in armored) = 0 THEN RAISE EXCEPTION 'armor header failed'; END IF; SELECT count(*) INTO header_count FROM pgp_armor_headers(armored); IF header_count <> 1 THEN RAISE EXCEPTION 'armor header count failed: %', header_count; END IF; END $$",
                "DO $$ DECLARE encrypted bytea; crypto_key bytea := decode('000102030405060708090a0b0c0d0e0f', 'hex'); crypto_iv bytea := decode('101112131415161718191a1b1c1d1e1f', 'hex'); BEGIN SELECT pgp_sym_encrypt('oliphaunt secret', 'passphrase') INTO encrypted; IF pgp_key_id(encrypted) <> 'SYMKEY' THEN RAISE EXCEPTION 'PGP symmetric key id failed'; END IF; SELECT encrypt(convert_to('oliphaunt raw cipher', 'UTF8'), crypto_key, 'aes') INTO encrypted; IF convert_from(decrypt(encrypted, crypto_key, 'aes'), 'UTF8') <> 'oliphaunt raw cipher' THEN RAISE EXCEPTION 'raw decrypt failed'; END IF; SELECT encrypt_iv(convert_to('oliphaunt iv cipher', 'UTF8'), crypto_key, crypto_iv, 'aes-cbc') INTO encrypted; IF convert_from(decrypt_iv(encrypted, crypto_key, crypto_iv, 'aes-cbc'), 'UTF8') <> 'oliphaunt iv cipher' THEN RAISE EXCEPTION 'raw iv decrypt failed'; END IF; END $$",
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
            "uuid-ossp" => &[
                "DO $$ DECLARE id uuid; BEGIN SELECT uuid_generate_v1() INTO id; IF length(id::text) <> 36 THEN RAISE EXCEPTION 'uuid-ossp v1 length failed'; END IF; SELECT uuid_generate_v4() INTO id; IF length(id::text) <> 36 THEN RAISE EXCEPTION 'uuid-ossp v4 length failed'; END IF; END $$",
                "DO $$ BEGIN IF uuid_generate_v3(uuid_ns_dns(), 'www.example.com')::text <> '5df41881-3aed-3515-88a7-2f4a814cf09e' THEN RAISE EXCEPTION 'uuid-ossp v3 failed'; END IF; IF uuid_generate_v5(uuid_ns_dns(), 'www.example.com')::text <> '2ed6657d-e927-568b-95e1-2665a8aea6a2' THEN RAISE EXCEPTION 'uuid-ossp v5 failed'; END IF; END $$",
                "DO $$ BEGIN IF uuid_nil()::text <> '00000000-0000-0000-0000-000000000000' THEN RAISE EXCEPTION 'uuid-ossp nil failed'; END IF; IF uuid_ns_dns()::text <> '6ba7b810-9dad-11d1-80b4-00c04fd430c8' THEN RAISE EXCEPTION 'uuid-ossp dns namespace failed'; END IF; IF uuid_ns_oid()::text <> '6ba7b812-9dad-11d1-80b4-00c04fd430c8' THEN RAISE EXCEPTION 'uuid-ossp oid namespace failed'; END IF; END $$",
            ],
            "vector" => &[
                "CREATE TEMP TABLE oxide_vector (embedding vector(3))",
                "INSERT INTO oxide_vector VALUES ('[1,2,3]')",
                "DO $$ DECLARE d float8; BEGIN SELECT embedding <-> '[1,2,4]'::vector INTO d FROM oxide_vector; IF d <> 1 THEN RAISE EXCEPTION 'vector distance failed: %', d; END IF; END $$",
            ],
            other => panic!("missing smoke SQL for extension candidate {other}"),
        }
    }
}
