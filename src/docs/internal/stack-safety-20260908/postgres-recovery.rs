use anyhow::{Result, ensure};
use oliphaunt_wasix::{DatabaseStorage, Oliphaunt};

fn scalar(db: &mut Oliphaunt, sql: &str, expected: &str) -> Result<()> {
    let result = db.query(sql)?;
    ensure!(result.rows().len() == 1, "expected one row: {sql}");
    ensure!(
        result.rows()[0].text(0)? == Some(expected),
        "wrong scalar result: {sql}"
    );
    Ok(())
}

fn depth_error(db: &mut Oliphaunt, name: &str, sql: &str) -> Result<()> {
    let error = db
        .query(sql)
        .expect_err("deep recursion must raise an SQL error");
    ensure!(
        error.postgres_error().and_then(|e| e.sqlstate.as_deref()) == Some("54001"),
        "{name}: expected SQLSTATE 54001, got {error:#}"
    );
    scalar(db, "SELECT 42::text", "42")?;
    println!("PASS {name}: SQLSTATE 54001 and same-session reuse");
    Ok(())
}

fn main() -> Result<()> {
    let mut args: Vec<_> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--stack-mib") {
        let mib: usize = args[2].parse()?;
        wasmer_vm::set_stack_size(mib * 1024 * 1024);
        args.drain(1..3);
    }
    eprintln!("diagnostic VM stack bytes={}", wasmer_vm::get_stack_size());
    if args.get(1).map(String::as_str) == Some("server") {
        let mut server = oliphaunt_wasix::OliphauntServer::builder().start()?;
        println!("{}", server.connection_string());
        let authority = server
            .connection_string()
            .strip_prefix("postgresql://")
            .unwrap()
            .split('/')
            .next()
            .unwrap()
            .rsplit('@')
            .next()
            .unwrap()
            .to_owned();
        let address: std::net::SocketAddr = authority.parse()?;
        let status = std::process::Command::new(&args[2])
            .args(&args[3..])
            .env("PGHOST", address.ip().to_string())
            .env("PGPORT", address.port().to_string())
            .env("PGUSER", "postgres")
            .env("PGDATABASE", "postgres")
            .status()?;
        server.close()?;
        ensure!(status.success(), "client failed: {status}");
        return Ok(());
    }
    let storage = match args.get(1) {
        Some(path) => DatabaseStorage::Directory(path.into()),
        None => DatabaseStorage::Memory,
    };
    let mut db = Oliphaunt::builder().storage(storage).open()?;
    db.exec("CREATE FUNCTION pg_temp.stack_probe(n integer) RETURNS integer LANGUAGE plpgsql AS $$ BEGIN IF n = 0 THEN RETURN 0; END IF; RETURN pg_temp.stack_probe(n - 1) + 1; END $$")?;
    db.exec("CREATE FUNCTION pg_temp.stack_catch() RETURNS text LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_temp.stack_probe(2000); RETURN 'missing-error'; EXCEPTION WHEN statement_too_complex THEN RETURN SQLSTATE; END $$")?;
    // Left-associative input builds a deep expression tree without first
    // exhausting Bison's separate parser stack with nested parentheses.
    let expression = format!("SELECT {}0", "1+".repeat(5000));
    for limit in ["100kB", "2MB"] {
        db.exec(&format!("SET max_stack_depth = '{limit}'"))?;
        for cycle in 1..=3 {
            println!("LIMIT {limit} cycle={cycle}");
            depth_error(
                &mut db,
                "malformed JSON array",
                "SELECT repeat('[', 10000)::json",
            )?;
            depth_error(
                &mut db,
                "malformed JSON object",
                "SELECT repeat('{\"a\":', 10000)::json",
            )?;
            depth_error(
                &mut db,
                "valid deep JSON",
                "SELECT length((repeat('[', 10000) || '0' || repeat(']', 10000))::json::text)",
            )?;
            depth_error(&mut db, "expression", &expression)?;
            depth_error(
                &mut db,
                "PL/pgSQL recursion",
                "SELECT pg_temp.stack_probe(2000)",
            )?;
            scalar(&mut db, "SELECT pg_temp.stack_catch()", "54001")?;
            scalar(&mut db, "SELECT pg_temp.stack_probe(4)::text", "4")?;
            db.transaction(|transaction| {
                transaction.execute("SAVEPOINT stack_probe")?;
                let error = transaction
                    .query("SELECT pg_temp.stack_probe(2000)")
                    .expect_err("savepoint depth error");
                assert_eq!(
                    error.postgres_error().and_then(|e| e.sqlstate.as_deref()),
                    Some("54001"),
                    "savepoint: {error:#}"
                );
                transaction.execute("ROLLBACK TO SAVEPOINT stack_probe")?;
                let result = transaction.query("SELECT 42::text")?;
                assert_eq!(result.rows()[0].text(0)?, Some("42"));
                Ok::<(), oliphaunt_wasix::Error>(())
            })?;
            scalar(&mut db, "SELECT 42::text", "42")?;
            println!("PASS caught PL/pgSQL error and savepoint rollback/reuse");
        }
    }
    db.exec("RESET max_stack_depth")?;
    scalar(&mut db, "SHOW max_stack_depth", "2MB")?;
    scalar(&mut db, "SELECT 'true'::json::text", "true")?;
    db.exec("CREATE TABLE stack_survivor(value integer); INSERT INTO stack_survivor VALUES (42)")?;
    db.close()?;
    if let Some(path) = args.get(1) {
        let mut reopened = Oliphaunt::builder()
            .storage(DatabaseStorage::Directory(path.into()))
            .open()?;
        scalar(
            &mut reopened,
            "SELECT value::text FROM stack_survivor",
            "42",
        )?;
        reopened.close()?;
        println!("PASS directory close/reopen and committed data");
    }
    println!("PASS real SQL recovery at 100kB and 2MB, unchanged engine stack");
    Ok(())
}
