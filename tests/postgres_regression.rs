#![cfg(feature = "extensions")]

use anyhow::{Context, Result, anyhow};
use pglite_oxide::{Pglite, QueryOptions};
use serde_json::{Map, Value, json};

struct TestTrace {
    name: &'static str,
}

impl TestTrace {
    fn new(name: &'static str) -> Self {
        eprintln!("postgres_regression::{name} start");
        Self { name }
    }
}

impl Drop for TestTrace {
    fn drop(&mut self) {
        eprintln!("postgres_regression::{} end", self.name);
    }
}

fn first_row(result: &pglite_oxide::Results) -> Result<&Map<String, Value>> {
    result
        .rows
        .first()
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("expected at least one object row"))
}

fn single_column_strings(result: &pglite_oxide::Results, column: &str) -> Result<Vec<String>> {
    result
        .rows
        .iter()
        .map(|row| {
            row.get(column)
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or_else(|| anyhow!("expected string column {column} in row {row:?}"))
        })
        .collect()
}

#[test]
fn datatypes_cover_pglite_basic_surface() -> Result<()> {
    let _trace = TestTrace::new("datatypes_cover_pglite_basic_surface");
    let mut db = Pglite::builder().temporary().open()?;

    db.exec(
        "CREATE TABLE regression_types (
            id serial PRIMARY KEY,
            text_col text NOT NULL,
            small_col smallint,
            int_col integer,
            big_col bigint,
            numeric_col numeric(12,2),
            real_col real,
            double_col double precision,
            bool_col boolean,
            date_col date,
            ts_col timestamp,
            tstz_col timestamptz,
            json_col json,
            jsonb_col jsonb,
            bytea_col bytea,
            text_arr text[],
            int_arr integer[],
            nested_float double precision[][],
            nullable_col integer
        )",
        None,
    )?;

    db.query(
        "INSERT INTO regression_types (
            text_col,
            small_col,
            int_col,
            big_col,
            numeric_col,
            real_col,
            double_col,
            bool_col,
            date_col,
            ts_col,
            tstz_col,
            json_col,
            jsonb_col,
            bytea_col,
            text_arr,
            int_arr,
            nested_float,
            nullable_col
        ) VALUES (
            $1::text,
            $2::int2,
            $3::int4,
            $4::int8,
            $5::numeric,
            $6::float4,
            $7::float8,
            $8::bool,
            $9::date,
            $10::timestamp,
            $11::timestamptz,
            $12::json,
            $13::jsonb,
            $14::bytea,
            $15::text[],
            $16::int4[],
            $17::float8[][],
            $18::int4
        )",
        &[
            json!("hello, \"postgres\""),
            json!(7),
            json!(42),
            json!(9_007_199_254_740_i64),
            json!(1234.5),
            json!(1.25),
            json!(2.5),
            json!(true),
            json!("2021-01-02"),
            json!("2021-01-02 03:04:05"),
            json!("2021-01-02 03:04:05+00"),
            json!({"kind": "json", "items": [1, 2, 3]}),
            json!({"kind": "jsonb", "nested": {"ok": true}}),
            json!([0, 1, 2, 255]),
            json!(["alpha", "beta,gamma", "quote \" value"]),
            json!([1, 2, 3]),
            json!([[1.5, 2.5], [3.5, 4.5]]),
            Value::Null,
        ],
        None,
    )?;

    let result = db.query(
        "SELECT
            text_col,
            small_col,
            int_col,
            big_col,
            numeric_col,
            real_col,
            double_col,
            bool_col,
            date_col::text AS date_text,
            ts_col::text AS timestamp_text,
            to_char(tstz_col AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS timestamptz_utc,
            json_col,
            jsonb_col,
            bytea_col,
            text_arr,
            int_arr,
            nested_float,
            nullable_col
         FROM regression_types",
        &[],
        None,
    )?;
    let row = first_row(&result)?;

    assert_eq!(row.get("text_col"), Some(&json!("hello, \"postgres\"")));
    assert_eq!(row.get("small_col"), Some(&json!(7)));
    assert_eq!(row.get("int_col"), Some(&json!(42)));
    assert_eq!(row.get("big_col"), Some(&json!(9_007_199_254_740_i64)));
    assert_eq!(row.get("numeric_col"), Some(&json!(1234.5)));
    assert_eq!(row.get("real_col"), Some(&json!(1.25)));
    assert_eq!(row.get("double_col"), Some(&json!(2.5)));
    assert_eq!(row.get("bool_col"), Some(&json!(true)));
    assert_eq!(row.get("date_text"), Some(&json!("2021-01-02")));
    assert_eq!(
        row.get("timestamp_text"),
        Some(&json!("2021-01-02 03:04:05"))
    );
    assert_eq!(
        row.get("timestamptz_utc"),
        Some(&json!("2021-01-02 03:04:05"))
    );
    assert_eq!(
        row.get("json_col")
            .and_then(|value| value.get("items"))
            .and_then(Value::as_array)
            .map(Vec::len),
        Some(3)
    );
    assert_eq!(
        row.get("jsonb_col")
            .and_then(|value| value.get("nested"))
            .and_then(|value| value.get("ok")),
        Some(&json!(true))
    );
    assert_eq!(row.get("bytea_col"), Some(&json!([0, 1, 2, 255])));
    assert_eq!(
        row.get("text_arr"),
        Some(&json!(["alpha", "beta,gamma", "quote \" value"]))
    );
    assert_eq!(row.get("int_arr"), Some(&json!([1, 2, 3])));
    assert_eq!(
        row.get("nested_float"),
        Some(&json!([[1.5, 2.5], [3.5, 4.5]]))
    );
    assert_eq!(row.get("nullable_col"), Some(&Value::Null));

    let field_oids: Vec<(&str, i32)> = result
        .fields
        .iter()
        .map(|field| (field.name.as_str(), field.data_type_id))
        .collect();
    assert!(
        field_oids.contains(&("jsonb_col", 3802)),
        "jsonb field should preserve PostgreSQL type OID: {field_oids:?}"
    );
    assert!(
        field_oids.contains(&("bytea_col", 17)),
        "bytea field should preserve PostgreSQL type OID: {field_oids:?}"
    );
    assert!(
        field_oids.contains(&("text_arr", 1009)),
        "text[] field should preserve PostgreSQL type OID: {field_oids:?}"
    );

    Ok(())
}

#[test]
fn ddl_schema_view_trigger_and_rollback_behave_like_postgres() -> Result<()> {
    let _trace = TestTrace::new("ddl_schema_view_trigger_and_rollback_behave_like_postgres");
    let mut db = Pglite::builder().temporary().open()?;

    db.exec(
        "CREATE SCHEMA reg;
         CREATE TABLE reg.accounts (
            id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            email text NOT NULL UNIQUE,
            balance numeric(12,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
            status text NOT NULL DEFAULT 'open'
         );
         ALTER TABLE reg.accounts ADD COLUMN tags text[] NOT NULL DEFAULT ARRAY[]::text[];
         ALTER TABLE reg.accounts RENAME COLUMN email TO login;
         CREATE TABLE reg.account_audit (
            account_id integer NOT NULL,
            action text NOT NULL
         );
         CREATE FUNCTION reg.audit_account_insert() RETURNS trigger
         LANGUAGE plpgsql
         AS $$
         BEGIN
             INSERT INTO reg.account_audit(account_id, action)
             VALUES (NEW.id, 'insert');
             RETURN NEW;
         END
         $$;
         CREATE TRIGGER account_insert_audit
         AFTER INSERT ON reg.accounts
         FOR EACH ROW EXECUTE FUNCTION reg.audit_account_insert();
         INSERT INTO reg.accounts(login, balance, tags)
         VALUES ('one@example.com', 12.50, ARRAY['seed', 'ddl']);
         CREATE VIEW reg.open_accounts AS
         SELECT id, login, balance, tags
         FROM reg.accounts
         WHERE status = 'open';",
        None,
    )?;

    let view_result = db.query(
        "SELECT login, balance, tags FROM reg.open_accounts",
        &[],
        None,
    )?;
    let view_row = first_row(&view_result)?;
    assert_eq!(view_row.get("login"), Some(&json!("one@example.com")));
    assert_eq!(view_row.get("balance"), Some(&json!(12.5)));
    assert_eq!(view_row.get("tags"), Some(&json!(["seed", "ddl"])));

    let audit_result = db.query(
        "SELECT count(*)::int AS audit_count FROM reg.account_audit",
        &[],
        None,
    )?;
    assert_eq!(
        first_row(&audit_result)?.get("audit_count"),
        Some(&json!(1))
    );

    let constraint_error = db
        .exec(
            "INSERT INTO reg.accounts(login, balance)
             VALUES ('bad@example.com', -1)",
            None,
        )
        .expect_err("check constraint should reject negative balance");
    eprintln!("postgres_regression::ddl_schema expected check-constraint error returned");
    let pg_error = constraint_error
        .downcast_ref::<pglite_oxide::PgliteError>()
        .context("constraint error should preserve PostgreSQL fields")?;
    assert_eq!(pg_error.database_error().code.as_deref(), Some("23514"));

    db.exec(
        "BEGIN;
         CREATE TABLE reg.rolled_back(id integer);
         INSERT INTO reg.rolled_back VALUES (1);
         ROLLBACK;",
        None,
    )?;
    let regclass = db.query(
        "SELECT to_regclass('reg.rolled_back')::text AS rolled_back_table",
        &[],
        None,
    )?;
    assert_eq!(
        first_row(&regclass)?.get("rolled_back_table"),
        Some(&Value::Null)
    );

    db.exec("ALTER TABLE reg.accounts RENAME TO customers", None)?;
    let rename_result = db.query(
        "SELECT
            to_regclass('reg.accounts')::text AS old_name,
            to_regclass('reg.customers')::text AS new_name",
        &[],
        None,
    )?;
    let rename_row = first_row(&rename_result)?;
    assert_eq!(rename_row.get("old_name"), Some(&Value::Null));
    assert_eq!(rename_row.get("new_name"), Some(&json!("reg.customers")));

    Ok(())
}

#[test]
fn transactions_savepoints_and_error_recovery_match_postgres() -> Result<()> {
    let _trace = TestTrace::new("transactions_savepoints_and_error_recovery_match_postgres");
    let mut db = Pglite::builder().temporary().open()?;
    db.exec(
        "CREATE TABLE tx_items (
            id integer PRIMARY KEY,
            value text NOT NULL
        )",
        None,
    )?;

    db.exec("BEGIN", None)?;
    db.exec(
        "INSERT INTO tx_items VALUES (1, 'committed-before-savepoint')",
        None,
    )?;
    db.exec("SAVEPOINT before_second", None)?;
    db.exec(
        "INSERT INTO tx_items VALUES (2, 'rolled-back-to-savepoint')",
        None,
    )?;
    db.exec("ROLLBACK TO SAVEPOINT before_second", None)?;
    db.exec(
        "INSERT INTO tx_items VALUES (3, 'committed-after-savepoint')",
        None,
    )?;
    db.exec("COMMIT", None)?;

    let ids = db.query(
        "SELECT array_agg(id ORDER BY id) AS ids FROM tx_items",
        &[],
        None,
    )?;
    assert_eq!(first_row(&ids)?.get("ids"), Some(&json!([1, 3])));

    db.exec("BEGIN", None)?;
    db.exec("SAVEPOINT duplicate_guard", None)?;
    let duplicate = db
        .exec("INSERT INTO tx_items VALUES (1, 'duplicate')", None)
        .expect_err("duplicate primary key should fail inside savepoint");
    eprintln!("postgres_regression::transactions expected duplicate-key error returned");
    let pg_error = duplicate
        .downcast_ref::<pglite_oxide::PgliteError>()
        .context("duplicate error should preserve PostgreSQL fields")?;
    assert_eq!(pg_error.database_error().code.as_deref(), Some("23505"));
    db.exec("ROLLBACK TO SAVEPOINT duplicate_guard", None)?;
    db.exec(
        "INSERT INTO tx_items VALUES (4, 'recovered-after-savepoint-error')",
        None,
    )?;
    db.exec("COMMIT", None)?;

    let values = db.query("SELECT value FROM tx_items ORDER BY id", &[], None)?;
    assert_eq!(
        single_column_strings(&values, "value")?,
        vec![
            "committed-before-savepoint",
            "committed-after-savepoint",
            "recovered-after-savepoint-error",
        ]
    );

    let after_error = db.query("SELECT 99::int AS recovered", &[], None)?;
    assert_eq!(first_row(&after_error)?.get("recovered"), Some(&json!(99)));

    Ok(())
}

#[test]
fn expected_sql_error_recovery_stays_inside_protocol_loop() -> Result<()> {
    let _trace = TestTrace::new("expected_sql_error_recovery_stays_inside_protocol_loop");
    let mut db = Pglite::builder().temporary().open()?;
    db.exec(
        "CREATE TABLE error_recovery (
            id integer PRIMARY KEY,
            value integer NOT NULL CHECK (value > 0)
        );
         INSERT INTO error_recovery VALUES (1, 1);",
        None,
    )?;

    for (label, sql, code) in [
        (
            "check-constraint",
            "INSERT INTO error_recovery VALUES (2, -1)",
            "23514",
        ),
        (
            "duplicate-key",
            "INSERT INTO error_recovery VALUES (1, 2)",
            "23505",
        ),
    ] {
        eprintln!("postgres_regression::expected_sql_error exercising {label}");
        let err = db.exec(sql, None).expect_err(label);
        let pg_error = err
            .downcast_ref::<pglite_oxide::PgliteError>()
            .with_context(|| format!("{label} should preserve PostgreSQL fields"))?;
        assert_eq!(pg_error.database_error().code.as_deref(), Some(code));
        let recovered = db.query(
            "SELECT count(*)::int AS rows FROM error_recovery",
            &[],
            None,
        )?;
        assert_eq!(first_row(&recovered)?.get("rows"), Some(&json!(1)));
    }

    Ok(())
}

#[test]
fn pg17_uuidv4_alias_error_is_recoverable() -> Result<()> {
    let _trace = TestTrace::new("pg17_uuidv4_alias_error_is_recoverable");
    let mut db = Pglite::builder().temporary().open()?;

    let built_in = db.query(
        "SELECT uuid_extract_version(gen_random_uuid())::int AS version",
        &[],
        None,
    )?;
    assert_eq!(first_row(&built_in)?.get("version"), Some(&json!(4)));

    let err = db
        .query("SELECT uuidv4() AS id", &[], None)
        .expect_err("PostgreSQL 17 should not expose the PostgreSQL 18 uuidv4 alias");
    let pg_error = err
        .downcast_ref::<pglite_oxide::PgliteError>()
        .context("uuidv4 error should preserve PostgreSQL fields")?;
    assert_eq!(pg_error.database_error().code.as_deref(), Some("42883"));
    assert!(
        pg_error
            .database_error()
            .message
            .contains("function uuidv4() does not exist"),
        "unexpected uuidv4 error: {}",
        pg_error.database_error().message
    );

    let recovered = db.query("SELECT 7::int AS recovered", &[], None)?;
    assert_eq!(first_row(&recovered)?.get("recovered"), Some(&json!(7)));

    Ok(())
}

#[test]
fn planner_uses_indexes_for_selective_queries_and_updates() -> Result<()> {
    let _trace = TestTrace::new("planner_uses_indexes_for_selective_queries_and_updates");
    let mut db = Pglite::builder().temporary().open()?;
    db.exec(
        "CREATE TABLE plan_items (
            id integer PRIMARY KEY,
            category integer NOT NULL,
            name text NOT NULL,
            active boolean NOT NULL,
            score integer NOT NULL
        );
         INSERT INTO plan_items(id, category, name, active, score)
         SELECT
            i,
            i % 17,
            'item-' || lpad(i::text, 4, '0'),
            (i % 3 = 0),
            i % 101
         FROM generate_series(1, 2000) AS s(i);
         CREATE INDEX plan_items_category_idx ON plan_items(category);
         CREATE INDEX plan_items_lower_name_idx ON plan_items((lower(name)));
         CREATE INDEX plan_items_active_score_idx ON plan_items(score) WHERE active;
         ANALYZE plan_items;
         SET enable_seqscan = off;",
        None,
    )?;

    let category_plan = explain_text(
        &mut db,
        "EXPLAIN (COSTS OFF)
         SELECT id FROM plan_items WHERE category = 7",
    )?;
    assert!(
        category_plan.contains("plan_items_category_idx"),
        "category query should use category index:\n{category_plan}"
    );

    let expression_plan = explain_text(
        &mut db,
        "EXPLAIN (COSTS OFF)
         SELECT id FROM plan_items WHERE lower(name) = 'item-0042'",
    )?;
    assert!(
        expression_plan.contains("plan_items_lower_name_idx"),
        "expression query should use expression index:\n{expression_plan}"
    );

    let partial_plan = explain_text(
        &mut db,
        "EXPLAIN (COSTS OFF)
         SELECT id FROM plan_items WHERE active AND score = 42",
    )?;
    assert!(
        partial_plan.contains("plan_items_active_score_idx"),
        "partial-index query should use partial index:\n{partial_plan}"
    );

    db.exec(
        "UPDATE plan_items
         SET score = score + 1000
         WHERE category = 7",
        None,
    )?;
    let updated = db.query(
        "SELECT count(*)::int AS updated_count
         FROM plan_items
         WHERE category = 7 AND score >= 1000",
        &[],
        None,
    )?;
    assert_eq!(first_row(&updated)?.get("updated_count"), Some(&json!(118)));

    db.exec(
        "DELETE FROM plan_items
         WHERE active AND score = 42",
        None,
    )?;
    let deleted = db.query(
        "SELECT count(*)::int AS remaining
         FROM plan_items
         WHERE active AND score = 42",
        &[],
        None,
    )?;
    assert_eq!(first_row(&deleted)?.get("remaining"), Some(&json!(0)));

    Ok(())
}

#[test]
fn direct_blob_copy_round_trips_csv_with_pglite_dev_blob_surface() -> Result<()> {
    let _trace = TestTrace::new("direct_blob_copy_round_trips_csv_with_pglite_dev_blob_surface");
    let mut db = Pglite::builder().temporary().open()?;
    db.exec(
        "CREATE TABLE blob_items (
            id integer PRIMARY KEY,
            note text NOT NULL
        );
         INSERT INTO blob_items(id, note) VALUES
            (1, 'alpha'),
            (2, 'comma,value'),
            (3, 'quote \" value'),
            (4, E'line\nbreak');",
        None,
    )?;

    let copy_out = db.exec(
        "COPY blob_items TO '/dev/blob' WITH (FORMAT csv, HEADER true)",
        None,
    )?;
    let csv = copy_out
        .last()
        .and_then(|result| result.blob.as_ref())
        .context("COPY TO /dev/blob should return blob bytes")?;
    let csv_text = std::str::from_utf8(csv).context("COPY CSV should be UTF-8")?;
    assert!(
        csv_text.starts_with("id,note\n"),
        "CSV should include header: {csv_text:?}"
    );
    assert!(
        csv_text.contains("2,\"comma,value\""),
        "CSV should quote comma-containing fields: {csv_text:?}"
    );
    assert!(
        csv_text.contains("3,\"quote \"\" value\""),
        "CSV should quote embedded quote fields: {csv_text:?}"
    );

    db.exec(
        "CREATE TABLE blob_items_copy (
            id integer PRIMARY KEY,
            note text NOT NULL
        )",
        None,
    )?;
    let copy_options = QueryOptions {
        blob: Some(csv.clone()),
        ..Default::default()
    };
    let copy_in = db.exec(
        "COPY blob_items_copy FROM '/dev/blob' WITH (FORMAT csv, HEADER true)",
        Some(&copy_options),
    )?;
    assert_eq!(
        copy_in.last().and_then(|result| result.affected_rows),
        Some(4)
    );

    let copied = db.query(
        "SELECT jsonb_agg(jsonb_build_array(id, note) ORDER BY id) AS rows
         FROM blob_items_copy",
        &[],
        None,
    )?;
    assert_eq!(
        first_row(&copied)?.get("rows"),
        Some(&json!([
            [1, "alpha"],
            [2, "comma,value"],
            [3, "quote \" value"],
            [4, "line\nbreak"]
        ]))
    );

    Ok(())
}

fn explain_text(db: &mut Pglite, sql: &str) -> Result<String> {
    let result = db.query(sql, &[], None)?;
    let lines = single_column_strings(&result, "QUERY PLAN")?;
    Ok(lines.join("\n"))
}
