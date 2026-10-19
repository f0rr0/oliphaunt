#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    use oliphaunt::{DatabaseStorage, Extension, OliphauntServer};
    use oliphaunt_tools::{PgDumpOptions, PsqlOptions};
    use serde_json::Value;

    #[test]
    #[ignore = "requires prepared native runtime, PostgreSQL tools and pgtap"]
    fn native_server_pg_dump_psql_round_trip() {
        let library = std::env::var_os("LIBOLIPHAUNT_PATH")
            .expect("LIBOLIPHAUNT_PATH must point to the prepared native runtime library");
        assert!(
            Path::new(&library).is_file(),
            "LIBOLIPHAUNT_PATH must name an existing file"
        );

        let source_root = unique_root("native-logical-source");
        let restored_root = unique_root("native-logical-restored");
        let seed = fixture("logical-tools-seed.sql");
        let verify = fixture("logical-tools-verify.sql");
        let result = std::panic::catch_unwind(|| {
            let mut source = OliphauntServer::builder()
                .storage(DatabaseStorage::Directory(source_root.clone()))
                .extension(Extension::PGTAP)
                .start()
                .expect("open native logical source server");
            oliphaunt_tools::psql(
                source.connection_string(),
                PsqlOptions::new().script(seed.as_str()),
            )
            .expect("seed native server through public psql facade");
            let dump_sql =
                oliphaunt_tools::pg_dump(source.connection_string(), PgDumpOptions::new())
                    .expect("dump native server through public pg_dump facade");
            assert!(dump_sql.contains("COPY public.logical_items"));
            assert!(!dump_sql.contains("INSERT INTO public.logical_items"));
            source.close().expect("close native logical source server");

            let mut restored = OliphauntServer::builder()
                .storage(DatabaseStorage::Directory(restored_root.clone()))
                .extension(Extension::PGTAP)
                .start()
                .expect("open native logical restore server");
            oliphaunt_tools::psql(
                restored.connection_string(),
                PsqlOptions::new().script(dump_sql),
            )
            .expect("restore native server through public psql facade");
            let verify_output = oliphaunt_tools::psql(
                restored.connection_string(),
                PsqlOptions::new().arg("-tA").script(verify.as_str()),
            )
            .expect("verify native logical restore through public psql facade");
            assert_eq!(verify_output.trim(), expected_logical_tools_row());
            restored
                .close()
                .expect("close native logical restore server");
        });
        let _ = std::fs::remove_dir_all(source_root);
        let _ = std::fs::remove_dir_all(restored_root);
        if let Err(payload) = result {
            std::panic::resume_unwind(payload);
        }
    }

    fn fixture(name: &str) -> String {
        std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../test-fixtures/postgres")
                .join(name),
        )
        .unwrap_or_else(|error| panic!("read canonical logical tools fixture {name}: {error}"))
    }

    fn expected_logical_tools_row() -> String {
        let fixture: Value = serde_json::from_str(&fixture("logical-tools.json"))
            .expect("canonical logical tools fixture must be valid JSON");
        let expected = &fixture["expected"];
        format!(
            "{}|{}|{}|{}|{}|{}",
            expected["rows"].as_i64().expect("fixture rows"),
            expected["sum"].as_i64().expect("fixture sum"),
            expected["sequenceLastValue"]
                .as_i64()
                .expect("fixture sequence last value"),
            expected["quotedValue"]
                .as_str()
                .expect("fixture quoted value"),
            expected["normalizedMatches"]
                .as_i64()
                .expect("fixture normalized matches"),
            if expected["extensionLoaded"]
                .as_bool()
                .expect("fixture extension loaded")
            {
                "t"
            } else {
                "f"
            }
        )
    }

    fn unique_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "oliphaunt-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock is before Unix epoch")
                .as_nanos()
        ))
    }
}
