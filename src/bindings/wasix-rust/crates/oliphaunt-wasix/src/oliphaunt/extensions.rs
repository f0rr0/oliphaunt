use std::collections::BTreeSet;

use anyhow::Result;
#[cfg(all(test, feature = "extension-pg-textsearch"))]
use anyhow::bail;

use crate::oliphaunt::config::PostgresConfig;

const SHARED_PRELOAD_LIBRARIES: &str = "shared_preload_libraries";

#[path = "generated_extensions.rs"]
mod generated;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) struct ExtensionNativeModule {
    runtime_path: &'static str,
    aot_name: Option<&'static str>,
}

impl ExtensionNativeModule {
    pub(crate) const fn runtime_path(self) -> &'static str {
        self.runtime_path
    }

    pub(crate) const fn aot_name(self) -> Option<&'static str> {
        self.aot_name
    }
}

/// A bundled PostgreSQL extension artifact that Oliphaunt can make available.
///
/// Selecting an extension does not run `CREATE EXTENSION`, `LOAD`, or other
/// database-local SQL. Applications retain ordinary migration ownership.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Extension {
    sql_name: &'static str,
    native_support_modules: &'static [ExtensionNativeModule],
    native_module_file: Option<&'static str>,
    aot_name: Option<&'static str>,
    dependencies: &'static [&'static str],
    startup_config: &'static [&'static str],
}

impl Extension {
    /// SQL extension name used in `CREATE EXTENSION`.
    pub const fn sql_name(self) -> &'static str {
        self.sql_name
    }

    /// Resolve a known extension artifact by its SQL name.
    pub fn by_sql_name(sql_name: &str) -> Option<Self> {
        Self::ALL
            .iter()
            .copied()
            .find(|extension| extension.sql_name == sql_name)
    }

    pub(crate) const fn aot_name(self) -> Option<&'static str> {
        self.aot_name
    }

    pub(crate) const fn native_module_file(self) -> Option<&'static str> {
        self.native_module_file
    }

    pub(crate) const fn native_support_modules(self) -> &'static [ExtensionNativeModule] {
        self.native_support_modules
    }

    pub(crate) const fn dependencies(self) -> &'static [&'static str] {
        self.dependencies
    }

    pub(crate) const fn startup_config(self) -> &'static [&'static str] {
        self.startup_config
    }
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

/// Merge startup settings required by selected extensions into the caller's
/// PostgreSQL configuration before either a cluster seed or a backend is started.
///
/// `shared_preload_libraries` is a list-valued GUC, so caller-provided and
/// extension-required entries are unioned in stable first-seen order. Other
/// extension startup settings may reuse an identical caller value, but a
/// conflicting value is rejected instead of silently weakening the extension
/// contract.
pub(crate) fn postgres_config_with_extension_startup(
    mut postgres_config: PostgresConfig,
    extensions: &[Extension],
) -> Result<PostgresConfig> {
    let mut shared_preload_libraries = Vec::new();
    let mut seen_shared_preload_libraries = BTreeSet::new();
    if let Some(configured) = postgres_config.get(SHARED_PRELOAD_LIBRARIES) {
        append_unique_csv_values(
            configured,
            &mut shared_preload_libraries,
            &mut seen_shared_preload_libraries,
        );
    }

    for extension in extensions {
        for assignment in extension.startup_config() {
            let (name, value) = parse_startup_config_assignment(*extension, assignment)?;

            if name == SHARED_PRELOAD_LIBRARIES {
                append_unique_csv_values(
                    value,
                    &mut shared_preload_libraries,
                    &mut seen_shared_preload_libraries,
                );
                continue;
            }

            if let Some(configured) = postgres_config.get(name) {
                if configured != value {
                    return Err(crate::error::invalid_configuration(format!(
                        "extension '{}' requires PostgreSQL startup config {name}={value}, but the caller configured {name}={configured}",
                        extension.sql_name()
                    )));
                }
            } else {
                postgres_config.insert(name, value);
            }
        }
    }

    if !shared_preload_libraries.is_empty() {
        postgres_config.insert(SHARED_PRELOAD_LIBRARIES, shared_preload_libraries.join(","));
    }
    postgres_config.validate()?;
    Ok(postgres_config)
}

#[cfg(all(test, feature = "extension-pg-textsearch"))]
pub(crate) fn ensure_extension_startup_config_is_active(
    postgres_config: &PostgresConfig,
    extension: Extension,
) -> Result<()> {
    for assignment in extension.startup_config() {
        let (name, required) = parse_startup_config_assignment(extension, assignment)?;
        let configured = postgres_config.get(name);
        let satisfied = if name == SHARED_PRELOAD_LIBRARIES {
            let configured_values = configured
                .into_iter()
                .flat_map(comma_separated_values)
                .collect::<BTreeSet<_>>();
            comma_separated_values(required).all(|value| configured_values.contains(value))
        } else {
            configured == Some(required)
        };

        if !satisfied {
            let configured = configured
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("<unset>");
            bail!(
                "extension '{}' requires PostgreSQL startup config {name}={required} before PostgreSQL starts, but the already-running backend has {name}={configured}; reopen the database with this extension selected on OliphauntBuilder (call .extension(...) before .open()), because it cannot be enabled safely after startup",
                extension.sql_name()
            );
        }
    }
    Ok(())
}

fn parse_startup_config_assignment(extension: Extension, assignment: &str) -> Result<(&str, &str)> {
    let (name, value) = assignment.split_once('=').ok_or_else(|| {
        crate::error::invalid_configuration(format!(
            "extension '{}' has invalid startup config assignment '{assignment}'; expected name=value",
            extension.sql_name()
        ))
    })?;
    let name = name.trim();
    let value = value.trim();
    if name.is_empty() {
        return Err(crate::error::invalid_configuration(format!(
            "extension '{}' has an empty startup config name in assignment '{assignment}'",
            extension.sql_name()
        )));
    }
    if value.is_empty() {
        return Err(crate::error::invalid_configuration(format!(
            "extension '{}' has an empty startup config value in assignment '{assignment}'",
            extension.sql_name()
        )));
    }
    Ok((name, value))
}

fn append_unique_csv_values(value: &str, ordered: &mut Vec<String>, seen: &mut BTreeSet<String>) {
    for item in comma_separated_values(value) {
        if seen.insert(item.to_owned()) {
            ordered.push(item.to_owned());
        }
    }
}

fn comma_separated_values(value: &str) -> impl Iterator<Item = &str> {
    value
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
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
        return Err(crate::error::invalid_configuration(format!(
            "cyclic bundled extension dependency involving '{}'",
            extension.sql_name()
        )));
    }
    for dependency in extension.dependencies() {
        let dependency_extension = Extension::by_sql_name(dependency).ok_or_else(|| {
            crate::error::invalid_configuration(format!(
                "selected extension '{}' depends on missing catalog extension '{}'",
                extension.sql_name(),
                dependency
            ))
        })?;
        visit_extension(dependency_extension, visiting, visited, resolved)?;
    }
    visiting.remove(extension.sql_name());
    visited.insert(extension.sql_name());
    resolved.push(extension);
    Ok(())
}

#[cfg(test)]
pub(crate) fn extension_smoke_sql(sql_name: &str) -> String {
    crate::oliphaunt::test_fixtures::source_text(
        &format!("shared/fixtures/extensions/{sql_name}.sql"),
        &format!("extensions/{sql_name}.sql"),
    )
}

#[cfg(test)]
pub(crate) fn extension_smoke_statements(sql: &str) -> impl Iterator<Item = &str> {
    sql.split("-- oliphaunt-statement")
        .map(str::trim)
        .filter(|statement| !statement.is_empty())
}

#[cfg(test)]
fn extension_activation_sql_for_test(extension: Extension) -> Result<Vec<&'static str>> {
    Ok(resolve_extension_set(&[extension])?
        .into_iter()
        .flat_map(|resolved| generated::activation_sql_for_test(resolved).iter().copied())
        .collect())
}

#[cfg(all(test, feature = "extension-pg-textsearch"))]
mod startup_config_tests {
    use super::*;

    #[test]
    fn late_pg_textsearch_enable_requires_active_preload() {
        let error = ensure_extension_startup_config_is_active(
            &PostgresConfig::default(),
            Extension::PG_TEXTSEARCH,
        )
        .unwrap_err();
        let message = error.to_string();

        assert!(message.contains("shared_preload_libraries=pg_textsearch"));
        assert!(message.contains("already-running backend"));
        assert!(message.contains(".extension(...) before .open()"));

        let mut active = PostgresConfig::default();
        active.insert(
            "shared_preload_libraries",
            "auto_explain, pg_textsearch,pg_textsearch",
        );
        ensure_extension_startup_config_is_active(&active, Extension::PG_TEXTSEARCH).unwrap();
    }
}

#[cfg(all(test, feature = "extensions"))]
mod extension_tests {
    use super::*;
    use crate::Oliphaunt;
    use crate::{AsyncOliphauntServer, DatabaseStorage};
    use anyhow::{Context, Result, ensure};
    use sqlx::{Connection, PgConnection};
    use std::collections::BTreeSet;
    use std::path::{Path, PathBuf};

    #[test]
    fn public_extensions_pass_direct_and_restart_smoke() -> Result<()> {
        run_direct_and_restart_smoke_set(Extension::ALL)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn public_extensions_pass_server_smoke() -> Result<()> {
        run_server_smoke_set(Extension::ALL).await
    }

    #[test]
    fn public_extensions_materialize_only_requested_libraries() -> Result<()> {
        run_lifecycle_materialization_set(Extension::ALL)
    }

    #[test]
    #[cfg(all(feature = "extension-cube", feature = "extension-earthdistance"))]
    fn dependent_extension_activation_includes_dependencies_first() -> Result<()> {
        let activation = extension_activation_sql_for_test(Extension::EARTHDISTANCE)?;
        assert_eq!(activation.len(), 2);
        assert!(activation[0].contains("\"cube\""));
        assert!(activation[1].contains("\"earthdistance\""));
        Ok(())
    }

    #[test]
    #[cfg(feature = "extension-uuid-ossp")]
    fn uuid_ossp_aot_direct_and_restart_smoke() -> Result<()> {
        run_direct_and_restart_smoke_set(&[Extension::UUID_OSSP])
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[cfg(feature = "extension-uuid-ossp")]
    async fn uuid_ossp_aot_server_smoke() -> Result<()> {
        run_server_smoke_set(&[Extension::UUID_OSSP]).await
    }

    #[test]
    #[cfg(feature = "extension-uuid-ossp")]
    fn uuid_ossp_aot_materialization_smoke() -> Result<()> {
        run_lifecycle_materialization_set(&[Extension::UUID_OSSP])
    }

    #[cfg(all(feature = "tools", feature = "extension-uuid-ossp"))]
    #[test]
    fn uuid_ossp_aot_dump_restore_smoke() -> Result<()> {
        use crate::tools::{PgDumpOptions, PsqlOptions};

        let mut source = Oliphaunt::builder()
            .extension(Extension::UUID_OSSP)
            .open()
            .context("open UUID-OSSP AOT dump source")?;
        source
            .psql(PsqlOptions::new().script(
                "CREATE EXTENSION \"uuid-ossp\";\
                 CREATE TABLE uuid_ossp_aot_items(\
                   id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),\
                   label text NOT NULL\
                 );\
                INSERT INTO uuid_ossp_aot_items(label) VALUES ('first'), ('second');",
            ))
            .context("seed UUID-OSSP AOT dump source through psql")?;
        let dump = source
            .pg_dump(PgDumpOptions::new())
            .context("dump UUID-OSSP AOT source through pg_dump")?;
        ensure!(
            dump.contains("COPY public.uuid_ossp_aot_items"),
            "UUID-OSSP AOT dump should retain PostgreSQL COPY output"
        );
        source.close().context("close UUID-OSSP AOT dump source")?;

        let mut restored = Oliphaunt::builder()
            .extension(Extension::UUID_OSSP)
            .open()
            .context("open UUID-OSSP AOT restore target")?;
        restored
            .psql(PsqlOptions::new().script(dump))
            .context("restore UUID-OSSP AOT dump through psql")?;
        let result = restored.query(
            "SELECT count(*)::int4 AS rows,\
                    count(DISTINCT id)::int4 AS ids,\
                    bool_and(length(id::text) = 36) AS valid_ids,\
                    length(uuid_generate_v4()::text)::int4 AS generated_length \
             FROM uuid_ossp_aot_items",
        )?;
        ensure!(result.get_text(0, "rows")? == Some("2"));
        ensure!(result.get_text(0, "ids")? == Some("2"));
        ensure!(result.get_text(0, "valid_ids")? == Some("t"));
        ensure!(result.get_text(0, "generated_length")? == Some("36"));
        restored
            .close()
            .context("close UUID-OSSP AOT restore target")?;
        Ok(())
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
                .extension(extension)
                .open()
                .with_context(|| format!("open temporary database with extension {name}"))?;
            assert_extension_not_installed(&mut db, extension)?;
            run_direct_smoke(&mut db, extension)?;
            db.close()
                .with_context(|| format!("close temporary database with extension {name}"))?;
        }

        let root = tempfile::TempDir::new()
            .with_context(|| format!("create restart root for extension {name}"))?;
        {
            let mut db = Oliphaunt::builder()
                .storage(DatabaseStorage::Directory(root.path().to_path_buf()))
                .extension(extension)
                .open()
                .with_context(|| {
                    format!("open persistent database with extension {name} before restart")
                })?;
            assert_extension_not_installed(&mut db, extension)?;
            run_direct_smoke(&mut db, extension)?;
            assert_extension_catalog_state(&mut db, extension)?;
            db.close()
                .with_context(|| format!("close persistent database with extension {name}"))?;
        }
        {
            let mut db = Oliphaunt::builder()
                .storage(DatabaseStorage::Directory(root.path().to_path_buf()))
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
        let server = AsyncOliphauntServer::builder()
            .extension(extension)
            .start()
            .await
            .with_context(|| format!("start server with extension {name}"))?;
        let mut conn = PgConnection::connect(server.connection_string())
            .await
            .with_context(|| format!("connect server with extension {name}"))?;
        assert_server_extension_not_installed(&mut conn, extension).await?;
        run_server_smoke(&mut conn, extension).await?;
        drop(conn);
        server
            .close()
            .await
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
                .storage(DatabaseStorage::Directory(root.path().to_path_buf()))
                .extension(extension)
                .open()
                .with_context(|| format!("open lifecycle database with extension {name}"))?;
            let runtime_root = db
                .runtime_storage()
                .host_path()
                .context("directory database should use a host runtime workspace")?;
            assert_only_resolved_extension_libraries_are_materialized(runtime_root, extension)?;
            db.close()
                .with_context(|| format!("close lifecycle database with extension {name}"))?;
        }
        Ok(())
    }

    fn run_direct_smoke(db: &mut Oliphaunt, extension: Extension) -> Result<()> {
        for statement in extension_activation_sql_for_test(extension)? {
            let request = crate::oliphaunt::query::simple_query(statement)?;
            db.exec_protocol_raw(request).with_context(|| {
                format!(
                    "explicit activation failed for extension {} while running:\n{}",
                    extension.sql_name(),
                    statement
                )
            })?;
        }
        let smoke_sql = extension_smoke_sql(extension.sql_name());
        for statement in extension_smoke_statements(&smoke_sql) {
            let request = crate::oliphaunt::query::simple_query(statement)?;
            db.exec_protocol_raw(request).with_context(|| {
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
        for statement in extension_activation_sql_for_test(extension)? {
            sqlx::query(statement)
                .execute(&mut *conn)
                .await
                .with_context(|| {
                    format!(
                        "explicit server activation failed for extension {} while running:\n{}",
                        extension.sql_name(),
                        statement
                    )
                })?;
        }
        let smoke_sql = extension_smoke_sql(extension.sql_name());
        for statement in extension_smoke_statements(&smoke_sql) {
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

    fn assert_extension_not_installed(db: &mut Oliphaunt, extension: Extension) -> Result<()> {
        if !generated::creates_database_object_for_test(extension) {
            return Ok(());
        }
        let result = db.query_with_params(
            "SELECT count(*)::int4 AS count FROM pg_extension WHERE extname = $1",
            [extension.sql_name()],
        )?;
        ensure!(
            result.get_text(0, "count")? == Some("0"),
            "selecting extension {} must not install it in pg_extension",
            extension.sql_name()
        );
        Ok(())
    }

    async fn assert_server_extension_not_installed(
        conn: &mut PgConnection,
        extension: Extension,
    ) -> Result<()> {
        if !generated::creates_database_object_for_test(extension) {
            return Ok(());
        }
        let installed: i64 =
            sqlx::query_scalar("SELECT count(*)::int8 FROM pg_extension WHERE extname = $1")
                .bind(extension.sql_name())
                .fetch_one(&mut *conn)
                .await?;
        ensure!(
            installed == 0,
            "selecting server extension {} must not install it in pg_extension",
            extension.sql_name()
        );
        Ok(())
    }

    fn assert_extension_catalog_state(db: &mut Oliphaunt, extension: Extension) -> Result<()> {
        if generated::creates_database_object_for_test(extension) {
            let result = db.query_with_params(
                "SELECT count(*)::int4 AS count FROM pg_extension WHERE extname = $1",
                [extension.sql_name()],
            )?;
            ensure!(
                result.get_text(0, "count")? == Some("1"),
                "extension {} should survive restart in pg_extension",
                extension.sql_name()
            );
        } else {
            let result = db.query("SELECT 1::int4 AS ok")?;
            ensure!(
                result.get_text(0, "ok")? == Some("1"),
                "extension {} should reopen cleanly",
                extension.sql_name()
            );
        }
        Ok(())
    }

    fn assert_only_resolved_extension_libraries_are_materialized(
        runtime_root: &Path,
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
        let actual = relative_files(&runtime_root.join("lib/postgresql"))
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
}
