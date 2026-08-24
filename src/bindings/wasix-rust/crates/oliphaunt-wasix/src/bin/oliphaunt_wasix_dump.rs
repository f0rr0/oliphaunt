use anyhow::Result;
#[cfg(all(feature = "tools", feature = "extensions"))]
use oliphaunt_wasix::extensions;
#[cfg(feature = "tools")]
use oliphaunt_wasix::{DatabaseStorage, Oliphaunt, OliphauntBuilder, tools};
#[cfg(feature = "tools")]
use std::env;
#[cfg(feature = "tools")]
use std::path::PathBuf;

#[cfg(feature = "tools")]
#[derive(Debug)]
struct Args {
    directory: PathBuf,
    database: String,
    username: String,
    extensions: Vec<String>,
    passthrough: Vec<String>,
}

fn main() -> Result<()> {
    #[cfg(not(feature = "tools"))]
    {
        anyhow::bail!("oliphaunt-wasix-dump requires the `tools` feature");
    }
    #[cfg(feature = "tools")]
    {
        let Args {
            directory,
            database,
            username,
            extensions,
            passthrough,
        } = parse_args()?;
        let builder = Oliphaunt::builder()
            .storage(DatabaseStorage::Directory(directory))
            .database(&database)
            .username(&username);
        let mut database = configure_extensions(builder, &extensions)?.open()?;
        let sql = tools::pg_dump(&mut database, tools::PgDumpOptions::new().args(passthrough))?;
        print!("{sql}");
        database.close()?;
        Ok(())
    }
}

#[cfg(feature = "tools")]
fn parse_args() -> Result<Args> {
    parse_args_from(env::args().skip(1))
}

#[cfg(feature = "tools")]
fn parse_args_from(args: impl IntoIterator<Item = String>) -> Result<Args> {
    let mut directory = PathBuf::from("./.oliphaunt");
    let mut database = "postgres".to_owned();
    let mut username = "postgres".to_owned();
    let mut extensions = Vec::new();
    let mut passthrough = Vec::new();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--directory" => {
                directory = PathBuf::from(
                    args.next()
                        .ok_or_else(|| anyhow::anyhow!("--directory requires a path"))?,
                );
            }
            "--database" => {
                database = args
                    .next()
                    .ok_or_else(|| anyhow::anyhow!("--database requires a name"))?;
            }
            "--username" => {
                username = args
                    .next()
                    .ok_or_else(|| anyhow::anyhow!("--username requires a name"))?;
            }
            "--extension" => {
                extensions.push(
                    args.next()
                        .ok_or_else(|| anyhow::anyhow!("--extension requires a name"))?,
                );
            }
            "--help" | "-h" => {
                print_usage();
                std::process::exit(0);
            }
            "--" => {
                passthrough.extend(args);
                break;
            }
            other => passthrough.push(other.to_string()),
        }
    }
    Ok(Args {
        directory,
        database,
        username,
        extensions,
        passthrough,
    })
}

#[cfg(all(feature = "tools", feature = "extensions"))]
fn configure_extensions(
    mut builder: OliphauntBuilder,
    extension_names: &[String],
) -> Result<OliphauntBuilder> {
    for name in extension_names {
        let extension = extensions::by_sql_name(name)
            .ok_or_else(|| anyhow::anyhow!("unknown extension: {name}"))?;
        builder = builder.extension(extension);
    }
    Ok(builder)
}

#[cfg(all(feature = "tools", not(feature = "extensions")))]
fn configure_extensions(
    builder: OliphauntBuilder,
    extension_names: &[String],
) -> Result<OliphauntBuilder> {
    if !extension_names.is_empty() {
        anyhow::bail!("this oliphaunt-wasix-dump build was compiled without extension support");
    }
    Ok(builder)
}

#[cfg(feature = "tools")]
fn print_usage() {
    eprintln!(
        "Usage: oliphaunt-wasix-dump [--directory PATH] [--database NAME] [--username NAME] [--extension NAME] [--] [pg_dump args]"
    );
    eprintln!("  --directory PATH  Use this database root. Defaults to ./.oliphaunt");
    eprintln!("  --database NAME   Select the database to dump. Defaults to postgres");
    eprintln!("  --username NAME   Select the database user. Defaults to postgres");
    eprintln!("  --extension NAME  Enable an installed extension by SQL name; repeat as needed");
    eprintln!("Example: oliphaunt-wasix-dump --directory ./.oliphaunt -- --schema-only");
}

#[cfg(all(test, feature = "tools"))]
mod tests {
    use super::*;

    #[test]
    fn typed_dump_selectors_are_not_forwarded_as_raw_pg_dump_arguments() -> Result<()> {
        let args = parse_args_from(
            [
                "--directory",
                "/tmp/database",
                "--database",
                "app",
                "--username",
                "owner",
                "--extension",
                "vector",
                "--extension",
                "pg_trgm",
                "--",
                "--schema-only",
            ]
            .into_iter()
            .map(str::to_owned),
        )?;

        assert_eq!(args.directory, PathBuf::from("/tmp/database"));
        assert_eq!(args.database, "app");
        assert_eq!(args.username, "owner");
        assert_eq!(args.extensions, ["vector", "pg_trgm"]);
        assert_eq!(args.passthrough, ["--schema-only"]);
        assert_eq!(
            tools::PgDumpOptions::new().args(args.passthrough),
            tools::PgDumpOptions::new().arg("--schema-only")
        );
        Ok(())
    }

    #[test]
    fn typed_dump_selectors_require_values() {
        for (flag, expected) in [
            ("--directory", "--directory requires a path"),
            ("--database", "--database requires a name"),
            ("--username", "--username requires a name"),
            ("--extension", "--extension requires a name"),
        ] {
            let error = parse_args_from([flag.to_owned()]).expect_err("missing value must fail");
            assert!(
                error.to_string().contains(expected),
                "unexpected error: {error:#}"
            );
        }
    }

    #[cfg(not(feature = "extensions"))]
    #[test]
    fn extension_selection_fails_before_start_when_support_is_not_compiled() {
        let error = configure_extensions(Oliphaunt::builder(), &["vector".to_owned()])
            .expect_err("extension selection must be explicit about missing feature support");
        assert!(
            error
                .to_string()
                .contains("compiled without extension support"),
            "unexpected error: {error:#}"
        );
    }
}
