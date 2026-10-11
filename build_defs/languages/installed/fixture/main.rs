use oliphaunt::{DatabaseStorage, Oliphaunt};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    oliphaunt::register_build_resources!()?;
    let directory =
        std::env::temp_dir().join(format!("oliphaunt-installed-{}", std::process::id()));
    for broker in [false, true] {
        let storage = directory.join(if broker { "broker" } else { "direct" });
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
        let builder = Oliphaunt::builder().storage(DatabaseStorage::Directory(storage));
        let mut db = if broker {
            builder.broker().open()?
        } else {
            builder.direct().open()?
        };
        let rows = db
            .sql("SELECT value AS answer FROM installed_answer")
            .query()?;
        assert_eq!(rows.rows()[0].try_get::<i32>("answer")?, 42);
        db.close()?;
    }
    std::fs::remove_dir_all(directory)?;
    Ok(())
}
