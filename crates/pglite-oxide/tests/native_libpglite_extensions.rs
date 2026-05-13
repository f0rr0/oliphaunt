#![cfg(feature = "extensions")]

use std::process::Command;

use anyhow::{Context, Result, ensure};
use pglite_oxide::extensions::{self, Extension};
use pglite_oxide::{EngineKind, Pglite};

const CHILD_ENV: &str = "PGLITE_OXIDE_NATIVE_EXTENSION_CHILD";

#[test]
fn native_libpglite_pg18_supported_extensions_smoke() -> Result<()> {
    if std::env::var_os("PGLITE_OXIDE_NATIVE_LIBPGLITE").is_none() {
        eprintln!("skipping native extension smoke: PGLITE_OXIDE_NATIVE_LIBPGLITE is not set");
        return Ok(());
    }

    let current_exe = std::env::current_exe().context("resolve current test binary")?;
    let mut failures = Vec::new();
    for extension in native_pg18_supported_extensions() {
        let output = Command::new(&current_exe)
            .arg("--exact")
            .arg("native_libpglite_extension_child")
            .arg("--nocapture")
            .env(CHILD_ENV, extension.sql_name())
            .output()
            .with_context(|| format!("spawn extension child for {}", extension.sql_name()))?;
        if !output.status.success() {
            failures.push(format!(
                "{} failed with status {}\nstdout:\n{}\nstderr:\n{}",
                extension.sql_name(),
                output.status,
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            ));
        }
    }

    ensure!(
        failures.is_empty(),
        "native extension smoke failures:\n{}",
        failures.join("\n\n")
    );
    Ok(())
}

#[test]
fn native_libpglite_rejects_extension_without_pg18_support() -> Result<()> {
    if std::env::var_os("PGLITE_OXIDE_NATIVE_LIBPGLITE").is_none() {
        eprintln!(
            "skipping native unsupported extension smoke: PGLITE_OXIDE_NATIVE_LIBPGLITE is not set"
        );
        return Ok(());
    }

    let root = tempfile::tempdir().context("create native unsupported extension root")?;
    let result = Pglite::builder()
        .path(root.path())
        .engine(EngineKind::NativeLibPglite)
        .extension(extensions::PG_HASHIDS)
        .open();
    let err = match result {
        Ok(_) => anyhow::bail!("pg_hashids should not be enabled in the native PostgreSQL 18 lane"),
        Err(err) => err,
    };
    ensure!(
        format!("{err:#}").contains("not enabled in the PostgreSQL 18 native lane"),
        "unexpected unsupported extension error: {err:#}"
    );
    Ok(())
}

#[test]
fn native_libpglite_extension_child() -> Result<()> {
    let Some(sql_name) = std::env::var_os(CHILD_ENV) else {
        return Ok(());
    };
    let sql_name = sql_name.to_string_lossy().into_owned();
    let extension = native_extension_by_name(&sql_name)
        .with_context(|| format!("unknown native extension child {sql_name}"))?;

    let root = tempfile::tempdir().context("create native extension root")?;
    let mut db = Pglite::builder()
        .path(root.path())
        .engine(EngineKind::NativeLibPglite)
        .extension(extension)
        .open()
        .with_context(|| format!("open native database with extension {sql_name}"))?;

    let capabilities = db.engine_capabilities();
    assert!(capabilities.extensions);
    assert_selected_artifacts(root.path(), extension)?;
    run_smoke_sql(&mut db, extension)?;
    db.close()
        .with_context(|| format!("close native database with extension {sql_name}"))?;
    Ok(())
}

fn native_pg18_supported_extensions() -> &'static [Extension] {
    &[
        extensions::AMCHECK,
        extensions::AUTO_EXPLAIN,
        extensions::BLOOM,
        extensions::BTREE_GIN,
        extensions::BTREE_GIST,
        extensions::CITEXT,
        extensions::CUBE,
        extensions::DICT_INT,
        extensions::DICT_XSYN,
        extensions::EARTHDISTANCE,
        extensions::FILE_FDW,
        extensions::FUZZYSTRMATCH,
        extensions::HSTORE,
        extensions::INTARRAY,
        extensions::ISN,
        extensions::LO,
        extensions::LTREE,
        extensions::PAGEINSPECT,
        extensions::PG_BUFFERCACHE,
        extensions::PG_FREESPACEMAP,
        extensions::PG_IVM,
        extensions::PG_SURGERY,
        extensions::PG_TEXTSEARCH,
        extensions::PG_TRGM,
        extensions::PG_UUIDV7,
        extensions::PG_VISIBILITY,
        extensions::PG_WALINSPECT,
        extensions::PGTAP,
        extensions::SEG,
        extensions::TABLEFUNC,
        extensions::TCN,
        extensions::TSM_SYSTEM_ROWS,
        extensions::TSM_SYSTEM_TIME,
        extensions::UNACCENT,
        extensions::VECTOR,
    ]
}

fn native_extension_by_name(sql_name: &str) -> Option<Extension> {
    native_pg18_supported_extensions()
        .iter()
        .copied()
        .find(|extension| extension.sql_name() == sql_name)
}

fn assert_selected_artifacts(root: &std::path::Path, extension: Extension) -> Result<()> {
    let runtime_root = root.join("tmp/pglite");
    ensure!(
        runtime_root.join("bin/postgres").is_file(),
        "native runtime should contain postgres argv0"
    );
    ensure!(
        !runtime_root
            .join("share/postgresql/extension/age.control")
            .exists(),
        "unsupported AGE control file must not be materialized"
    );
    ensure!(
        !runtime_root.join("lib/postgresql/age.dylib").exists(),
        "unsupported AGE module must not be materialized"
    );
    ensure!(
        !runtime_root
            .join("share/postgresql/extension/pg_hashids.control")
            .exists(),
        "extension without documented PostgreSQL 18 support must not be materialized"
    );
    ensure!(
        !runtime_root
            .join("lib/postgresql/pg_hashids.dylib")
            .exists(),
        "extension without documented PostgreSQL 18 support must not be materialized"
    );

    if extension.sql_name() != "auto_explain" {
        ensure!(
            runtime_root
                .join(format!(
                    "share/postgresql/extension/{}.control",
                    extension.sql_name()
                ))
                .is_file(),
            "selected extension control file should be materialized"
        );
    }
    if let Some(module) = native_module_file_name(extension) {
        ensure!(
            runtime_root.join("lib/postgresql").join(&module).is_file(),
            "selected extension module {module} should be materialized"
        );
    }

    let unrelated_sql = if extension.sql_name() == "vector" {
        "pg_trgm"
    } else {
        "vector"
    };
    ensure!(
        !runtime_root
            .join(format!(
                "share/postgresql/extension/{unrelated_sql}.control"
            ))
            .exists(),
        "unselected extension control file should not be materialized"
    );
    let unrelated_module = if extension.sql_name() == "vector" {
        "pg_trgm.dylib"
    } else {
        "vector.dylib"
    };
    ensure!(
        !runtime_root
            .join("lib/postgresql")
            .join(unrelated_module)
            .exists(),
        "unselected extension module should not be materialized"
    );
    Ok(())
}

fn native_module_file_name(extension: Extension) -> Option<String> {
    let stem = std::path::Path::new(extension.native_module_file()?)
        .file_stem()?
        .to_string_lossy();
    Some(format!("{}{}", stem, std::env::consts::DLL_SUFFIX))
}

fn run_smoke_sql(db: &mut Pglite, extension: Extension) -> Result<()> {
    for statement in smoke_sql(extension.sql_name()) {
        eprintln!(
            "native extension {} smoke: {}",
            extension.sql_name(),
            statement
        );
        db.exec(statement, None).with_context(|| {
            format!(
                "native smoke failed for extension {} while running:\n{}",
                extension.sql_name(),
                statement
            )
        })?;
    }
    Ok(())
}

fn smoke_sql(sql_name: &str) -> &'static [&'static str] {
    match sql_name {
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
            "DO $$ DECLARE lex text; BEGIN SELECT array_to_string(ts_lexize('unaccent', U&'H\\00F4tel'), ',') INTO lex; IF lex <> 'Hotel' THEN RAISE EXCEPTION 'unaccent failed: %', lex; END IF; END $$",
        ],
        "vector" => &[
            "CREATE TEMP TABLE oxide_vector (embedding vector(3))",
            "INSERT INTO oxide_vector VALUES ('[1,2,3]')",
            "DO $$ DECLARE d float8; BEGIN SELECT embedding <-> '[1,2,4]'::vector INTO d FROM oxide_vector; IF d <> 1 THEN RAISE EXCEPTION 'vector distance failed: %', d; END IF; END $$",
        ],
        other => panic!("missing native smoke SQL for extension {other}"),
    }
}
