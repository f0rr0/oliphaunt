use oliphaunt::{DatabaseStorage, Oliphaunt};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    oliphaunt::register_build_resources!()?;
    let directory = std::path::PathBuf::from(
        std::env::var_os("OLIPHAUNT_INSTALLED_STORAGE")
            .ok_or("installed consumer storage directory was not declared")?,
    );
    for broker in [false, true] {
        let mode = if broker { "broker" } else { "direct" };
        let storage = directory.join(mode);
        eprintln!("installed Cargo consumer: {mode} first open");
        let builder = Oliphaunt::builder().storage(DatabaseStorage::Directory(storage.clone()));
        let mut db = if broker {
            builder.broker().open()?
        } else {
            builder.direct().open()?
        };
        db.exec(
            "CREATE TABLE installed_answer(value int4); INSERT INTO installed_answer VALUES (42)",
        )?;
        db.close()?;
        eprintln!("installed Cargo consumer: {mode} reopen");
        let builder = Oliphaunt::builder().storage(DatabaseStorage::Directory(storage));
        let mut db = if broker {
            builder.broker().open()?
        } else {
            builder.direct().open()?
        };
        let rows = db
            .sql("SELECT value AS answer FROM installed_answer")
            .query()?;
        assert_eq!(rows.rows()[0].try_get::<i32, _>("answer")?, 42);
        db.close()?;
        eprintln!("installed Cargo consumer: {mode} SQL and reopen passed");
    }
    // Direct close detaches a process-resident backend. The parent removes
    // storage after this process's terminal PostgreSQL shutdown has completed.
    Ok(())
}
