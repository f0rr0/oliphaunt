#[cfg(test)]
#[path = "../../../src/runtimes/liboliphaunt/native/crates/tools/src/arguments.rs"]
mod native_arguments;

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    use oliphaunt::{Extension, Oliphaunt};
    use oliphaunt_tools::{PgDumpOptions, PsqlOptions};
    use serde_json::Value;

    use super::native_arguments::{validate_pg_dump_arguments, validate_psql_arguments};

    #[test]
    fn native_argument_validation_matches_the_canonical_fixture() {
        let fixture: Value = serde_json::from_str(&fixture("logical-tools.json"))
            .expect("canonical logical-tools fixture must be valid JSON");
        assert_fixture_cases(&fixture, "pgDump", |arguments| {
            validate_pg_dump_arguments(arguments)
        });
        assert_fixture_cases(&fixture, "psql", |arguments| {
            validate_psql_arguments(arguments)
        });
    }

    #[test]
    fn native_server_pg_dump_psql_round_trip_when_available() {
        if std::env::var_os("LIBOLIPHAUNT_PATH").is_none() {
            eprintln!("skipping native logical tools proof: LIBOLIPHAUNT_PATH is unset");
            return;
        }
        if !native_extension_available("pgtap") {
            eprintln!("skipping native logical tools proof: packaged pgtap is unavailable");
            return;
        }

        let source_root = unique_root("native-logical-source");
        let restored_root = unique_root("native-logical-restored");
        let seed = fixture("logical-tools-seed.sql");
        let verify = fixture("logical-tools-verify.sql");
        let result = std::panic::catch_unwind(|| {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("build native logical tools runtime");
            let source = runtime
                .block_on(
                    Oliphaunt::builder()
                        .directory(&source_root)
                        .extension(Extension::Pgtap)
                        .open_server(),
                )
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
            runtime
                .block_on(source.close())
                .expect("close native logical source server");

            let restored = runtime
                .block_on(
                    Oliphaunt::builder()
                        .directory(&restored_root)
                        .extension(Extension::Pgtap)
                        .open_server(),
                )
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
            runtime
                .block_on(restored.close())
                .expect("close native logical restore server");
        });
        let _ = std::fs::remove_dir_all(source_root);
        let _ = std::fs::remove_dir_all(restored_root);
        if let Err(payload) = result {
            std::panic::resume_unwind(payload);
        }
    }

    fn assert_fixture_cases(
        fixture: &Value,
        section: &str,
        validate: impl Fn(&[String]) -> Result<(), String>,
    ) {
        for arguments in scalar_cases(fixture, section, "acceptedArgs")
            .into_iter()
            .map(|argument| vec![argument])
            .chain(argv_cases(fixture, section, "acceptedArgv"))
        {
            validate(&arguments).unwrap_or_else(|error| {
                panic!("canonical {section} argv {arguments:?} must be accepted: {error}")
            });
        }
        for arguments in scalar_cases(fixture, section, "rejectedArgs")
            .into_iter()
            .map(|argument| vec![argument])
            .chain(argv_cases(fixture, section, "rejectedArgv"))
        {
            assert!(
                validate(&arguments).is_err(),
                "canonical {section} argv {arguments:?} must be rejected"
            );
        }
    }

    fn scalar_cases(fixture: &Value, section: &str, field: &str) -> Vec<String> {
        fixture[section][field]
            .as_array()
            .unwrap_or_else(|| panic!("canonical {section}.{field} must be an array"))
            .iter()
            .map(|argument| {
                argument
                    .as_str()
                    .unwrap_or_else(|| {
                        panic!("canonical {section}.{field} entries must be strings")
                    })
                    .to_owned()
            })
            .collect()
    }

    fn argv_cases(fixture: &Value, section: &str, field: &str) -> Vec<Vec<String>> {
        fixture[section][field]
            .as_array()
            .unwrap_or_else(|| panic!("canonical {section}.{field} must be an array"))
            .iter()
            .map(|arguments| {
                arguments
                    .as_array()
                    .unwrap_or_else(|| panic!("canonical {section}.{field} entries must be arrays"))
                    .iter()
                    .map(|argument| {
                        argument
                            .as_str()
                            .unwrap_or_else(|| {
                                panic!("canonical {section}.{field} argv entries must be strings")
                            })
                            .to_owned()
                    })
                    .collect()
            })
            .collect()
    }

    fn fixture(name: &str) -> String {
        std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../src/shared/fixtures/postgres")
                .join(name),
        )
        .unwrap_or_else(|error| panic!("read canonical logical tools fixture {name}: {error}"))
    }

    fn native_extension_available(sql_name: &str) -> bool {
        let control = format!("{sql_name}.control");
        if std::env::var_os("OLIPHAUNT_INSTALL_DIR").is_some_and(|root| {
            PathBuf::from(root)
                .join("share/postgresql/extension")
                .join(&control)
                .is_file()
        }) {
            return true;
        }
        let Some(resources) = std::env::var_os("OLIPHAUNT_RESOURCES_DIR") else {
            return false;
        };
        let Ok(products) = std::fs::read_dir(PathBuf::from(resources).join("extension")) else {
            return false;
        };
        products.flatten().any(|product| {
            product
                .path()
                .join("share/postgresql/extension")
                .join(&control)
                .is_file()
        })
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
