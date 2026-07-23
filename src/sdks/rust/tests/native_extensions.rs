use std::collections::BTreeSet;
use std::fs;
use std::future::Future;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::task::{Context, Poll, Wake, Waker};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use oliphaunt::{
    BackupArtifact, BackupFormat, BackupRequest, EngineMode, Extension, ExtensionSmokeCoverage,
    NATIVE_EXTENSION_MANIFEST, Oliphaunt, RestoreRequest, Result,
};

const DIRECT_CHILD_EXTENSION_ENV: &str = "OLIPHAUNT_EXTENSION_DIRECT_CHILD";
const DIRECT_CHILD_ACTION_ENV: &str = "OLIPHAUNT_EXTENSION_DIRECT_ACTION";
const DIRECT_CHILD_ROOT_ENV: &str = "OLIPHAUNT_EXTENSION_DIRECT_ROOT";
const DIRECT_CHILD_BACKUP_ENV: &str = "OLIPHAUNT_EXTENSION_DIRECT_BACKUP";
const EXTERNAL_MATRIX_ENV: &str = "OLIPHAUNT_EXTERNAL_EXTENSION_MATRIX";
const EXTERNAL_MATRIX_MODES_ENV: &str = "OLIPHAUNT_EXTERNAL_EXTENSION_MODES";
const RELEASE_PROOF_RUNNER_ENV: &str = "OLIPHAUNT_NATIVE_EXTENSION_PROOF_RUNNER";

#[test]
fn native_release_proof_catalog_has_the_expected_first_release_total() {
    let names = NATIVE_EXTENSION_MANIFEST
        .iter()
        .filter(|entry| entry.extension.desktop_release_ready())
        .map(|entry| entry.sql_name)
        .collect::<Vec<_>>();
    assert_eq!(names.len(), 39);
    assert_eq!(
        names.iter().copied().collect::<BTreeSet<_>>().len(),
        names.len()
    );
    assert!(
        names.windows(2).all(|pair| pair[0] < pair[1]),
        "release-ready native proof manifest must remain sorted by SQL name"
    );
}

pub fn run_native_extension_release_proof(shard_index: usize, shard_count: usize) {
    assert!(
        shard_count > 0,
        "native extension proof shard count must be positive"
    );
    assert!(
        shard_index < shard_count,
        "native extension proof shard index {shard_index} must be below shard count {shard_count}"
    );
    assert!(
        !native_runtime_env_is_unavailable(),
        "native extension release proof requires LIBOLIPHAUNT_PATH from a same-run runtime artifact"
    );
    let broker = std::env::var("OLIPHAUNT_BROKER").expect(
        "native extension release proof requires OLIPHAUNT_BROKER from a same-run broker artifact",
    );
    assert!(
        Path::new(&broker).is_file(),
        "native extension release proof broker does not exist: {broker}"
    );
    let release_ready_manifest = NATIVE_EXTENSION_MANIFEST
        .iter()
        .filter(|entry| entry.extension.desktop_release_ready())
        .collect::<Vec<_>>();
    let requested_raw = std::env::var("OLIPHAUNT_NATIVE_EXTENSION_PROOF_SQL_NAMES")
        .expect("native extension release proof requires the planner-owned extension SQL-name set");
    let requested = requested_raw
        .split(',')
        .filter(|name| !name.is_empty())
        .collect::<BTreeSet<_>>();
    assert!(
        !requested.is_empty(),
        "planned native extension proof set is empty"
    );
    assert_eq!(
        requested.len(),
        requested_raw.split(',').count(),
        "planned native extension proof set contains empty or duplicate SQL names"
    );
    let release_manifest = release_ready_manifest
        .into_iter()
        .filter(|entry| requested.contains(entry.sql_name))
        .collect::<Vec<_>>();
    assert_eq!(
        release_manifest.len(),
        requested.len(),
        "planned native extension proof set contains a non-release-ready or unknown SQL name"
    );
    let planned_count = release_manifest.len();
    let names = release_manifest
        .iter()
        .map(|entry| entry.sql_name)
        .collect::<BTreeSet<_>>();
    assert_eq!(
        names.len(),
        planned_count,
        "canonical native release proof contains duplicate extension SQL names"
    );

    let selected = release_manifest
        .iter()
        .enumerate()
        .filter(|(index, _)| index % shard_count == shard_index)
        .map(|(_, entry)| *entry)
        .collect::<Vec<_>>();
    println!(
        "OLIPHAUNT_NATIVE_EXTENSION_PROOF_START shard={shard_index}/{shard_count} selected={} planned={planned_count} modes=direct,broker,server",
        selected.len()
    );

    for entry in selected {
        for coverage in [
            entry.coverage.direct_c_abi,
            entry.coverage.broker,
            entry.coverage.server,
        ] {
            assert_eq!(
                coverage,
                ExtensionSmokeCoverage::InstallLoadRestartBackupRestore,
                "{} lacks full native lifecycle evidence",
                entry.sql_name
            );
        }
        println!(
            "OLIPHAUNT_NATIVE_EXTENSION_PROOF_EXTENSION_START shard={shard_index}/{shard_count} extension={} artifact_class={}",
            entry.sql_name,
            if entry.first_party_artifact() {
                "contrib"
            } else {
                "external"
            }
        );
        run_direct_extension_smoke(entry.extension);
        run_extension_smoke(EngineMode::NativeBroker, Some(&broker), entry.extension).unwrap();
        run_extension_smoke(EngineMode::NativeServer, None, entry.extension).unwrap();
        println!(
            "OLIPHAUNT_NATIVE_EXTENSION_PROOF_EXTENSION_PASS shard={shard_index}/{shard_count} extension={} modes=direct,broker,server lifecycle=install-load-restart-backup-restore",
            entry.sql_name
        );
    }
    println!(
        "OLIPHAUNT_NATIVE_EXTENSION_PROOF_PASS shard={shard_index}/{shard_count} planned={planned_count} modes=direct,broker,server"
    );
}

#[test]
fn native_extension_matrix_when_enabled() {
    if let Some(result) = run_direct_extension_child_from_env() {
        result.unwrap();
        return;
    }

    if std::env::var("OLIPHAUNT_EXTENSION_MATRIX").ok().as_deref() != Some("1") {
        eprintln!("skipping native extension matrix: set OLIPHAUNT_EXTENSION_MATRIX=1");
        return;
    }
    if native_runtime_env_is_unavailable() {
        eprintln!("skipping native extension matrix: no native library env var is set");
        return;
    }
    let Some(broker) = option_env!("CARGO_BIN_EXE_oliphaunt-broker") else {
        eprintln!("skipping native extension matrix: cargo did not provide broker binary path");
        return;
    };

    for entry in NATIVE_EXTENSION_MANIFEST {
        if !entry.first_party_artifact() {
            eprintln!(
                "skipping external extension {} in first-party native matrix",
                entry.sql_name
            );
            continue;
        }
        assert_eq!(
            entry.coverage.direct_c_abi,
            ExtensionSmokeCoverage::InstallLoadRestartBackupRestore
        );
        assert_eq!(
            entry.coverage.broker,
            ExtensionSmokeCoverage::InstallLoadRestartBackupRestore
        );
        assert_eq!(
            entry.coverage.server,
            ExtensionSmokeCoverage::InstallLoadRestartBackupRestore
        );
        run_direct_extension_smoke(entry.extension);
        run_extension_smoke(EngineMode::NativeBroker, Some(broker), entry.extension).unwrap();
        run_extension_smoke(EngineMode::NativeServer, None, entry.extension).unwrap();
    }
}

#[test]
fn native_external_extension_matrix_when_enabled() {
    let Some(selection) = std::env::var(EXTERNAL_MATRIX_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty() && value.trim() != "0")
    else {
        eprintln!(
            "skipping native external extension matrix: set {EXTERNAL_MATRIX_ENV}=graph,pg_search or all"
        );
        return;
    };
    if native_runtime_env_is_unavailable() {
        eprintln!("skipping native external extension matrix: no native library env var is set");
        return;
    }

    let modes = selected_external_modes();
    let broker_from_env = std::env::var("OLIPHAUNT_BROKER").ok();
    let broker = if modes.contains(&EngineMode::NativeBroker) {
        Some(
            option_env!("CARGO_BIN_EXE_oliphaunt-broker")
                .or(broker_from_env.as_deref())
                .expect(
                    "external broker extension matrix needs a Cargo broker binary or OLIPHAUNT_BROKER",
                ),
        )
    } else {
        None
    };

    for extension in selected_external_extensions(&selection) {
        assert!(
            !extension.first_party_artifact(),
            "{} is not an external extension",
            extension.sql_name()
        );
        for mode in &modes {
            match mode {
                EngineMode::NativeDirect => run_direct_extension_smoke(extension),
                EngineMode::NativeBroker => {
                    run_extension_smoke(EngineMode::NativeBroker, broker, extension).unwrap()
                }
                EngineMode::NativeServer => {
                    run_extension_smoke(EngineMode::NativeServer, None, extension).unwrap()
                }
            }
        }
    }
}

fn selected_external_modes() -> Vec<EngineMode> {
    let raw = std::env::var(EXTERNAL_MATRIX_MODES_ENV).unwrap_or_else(|_| "direct".to_owned());
    let mut selected = Vec::new();
    for mode in raw.split(',') {
        let mode = mode.trim();
        if mode.is_empty() {
            continue;
        }
        let parsed = match mode {
            "all" => {
                for mode in [
                    EngineMode::NativeDirect,
                    EngineMode::NativeBroker,
                    EngineMode::NativeServer,
                ] {
                    if !selected.contains(&mode) {
                        selected.push(mode);
                    }
                }
                continue;
            }
            "direct" | "native-direct" => EngineMode::NativeDirect,
            "broker" | "native-broker" => EngineMode::NativeBroker,
            "server" | "native-server" => EngineMode::NativeServer,
            _ => panic!(
                "unknown external extension matrix mode in {EXTERNAL_MATRIX_MODES_ENV}: {mode}"
            ),
        };
        if !selected.contains(&parsed) {
            selected.push(parsed);
        }
    }
    assert!(
        !selected.is_empty(),
        "{EXTERNAL_MATRIX_MODES_ENV} did not select any native modes"
    );
    selected
}

fn selected_external_extensions(selection: &str) -> Vec<Extension> {
    if selection.trim() == "all" {
        return Extension::EXTERNAL_PG18_SUPPORTED.to_vec();
    }

    let mut selected = Vec::new();
    for raw in selection.split(',') {
        let name = raw.trim();
        if name.is_empty() {
            continue;
        }
        let extension = Extension::by_sql_name(name).unwrap_or_else(|| {
            panic!("unknown external extension in {EXTERNAL_MATRIX_ENV}: {name}")
        });
        assert!(
            Extension::EXTERNAL_PG18_SUPPORTED.contains(&extension),
            "{name} is not an external PostgreSQL 18 extension"
        );
        selected.push(extension);
    }
    selected.sort_unstable();
    selected.dedup();
    assert!(
        !selected.is_empty(),
        "{EXTERNAL_MATRIX_ENV} did not select any external extensions"
    );
    selected
}

fn run_direct_extension_smoke(extension: Extension) {
    let root = unique_temp_root(&format!(
        "oliphaunt-extension-direct-{}",
        extension.sql_name()
    ));
    let restored_root = unique_temp_root(&format!(
        "oliphaunt-extension-direct-{}-restore",
        extension.sql_name()
    ));
    let backup_path = unique_temp_root(&format!(
        "oliphaunt-extension-direct-{}-backup.tar",
        extension.sql_name()
    ));

    let result = std::panic::catch_unwind(|| {
        run_direct_extension_child(
            DirectExtensionChildAction::InstallBackup,
            extension,
            &root,
            Some(&backup_path),
        );
        run_direct_extension_child(
            DirectExtensionChildAction::AssertExisting,
            extension,
            &root,
            None,
        );

        let backup = BackupArtifact {
            format: BackupFormat::PhysicalArchive,
            bytes: fs::read(&backup_path).expect("direct extension child did not write backup"),
        };
        block_on(Oliphaunt::restore(RestoreRequest::physical_archive(
            &restored_root,
            backup,
        )))
        .unwrap();

        run_direct_extension_child(
            DirectExtensionChildAction::AssertExisting,
            extension,
            &restored_root,
            None,
        );
    });

    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&restored_root);
    let _ = fs::remove_file(&backup_path);

    if let Err(payload) = result {
        std::panic::resume_unwind(payload);
    }
}

#[derive(Clone, Copy)]
enum DirectExtensionChildAction {
    InstallBackup,
    AssertExisting,
}

impl DirectExtensionChildAction {
    fn as_env(self) -> &'static str {
        match self {
            Self::InstallBackup => "install-backup",
            Self::AssertExisting => "assert-existing",
        }
    }

    fn from_env(value: &str) -> Option<Self> {
        match value {
            "install-backup" => Some(Self::InstallBackup),
            "assert-existing" => Some(Self::AssertExisting),
            _ => None,
        }
    }
}

fn run_direct_extension_child(
    action: DirectExtensionChildAction,
    extension: Extension,
    root: &Path,
    backup_path: Option<&Path>,
) {
    let current_exe = std::env::current_exe().expect("current test executable is unavailable");
    let mut command = Command::new(current_exe);
    if std::env::var(RELEASE_PROOF_RUNNER_ENV).ok().as_deref() != Some("1") {
        command
            .arg("native_extension_matrix_when_enabled")
            .arg("--exact")
            .arg("--nocapture")
            .env("OLIPHAUNT_EXTENSION_MATRIX", "1");
    }
    command
        .env(DIRECT_CHILD_EXTENSION_ENV, extension.sql_name())
        .env(DIRECT_CHILD_ACTION_ENV, action.as_env())
        .env(DIRECT_CHILD_ROOT_ENV, root);
    if let Some(path) = backup_path {
        command.env(DIRECT_CHILD_BACKUP_ENV, path);
    }

    let output = command
        .output()
        .expect("failed to spawn direct extension child test process");
    assert!(
        output.status.success(),
        "direct extension child failed for {} ({})\nstdout:\n{}\nstderr:\n{}",
        extension.sql_name(),
        action.as_env(),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn run_direct_extension_child_from_env() -> Option<Result<()>> {
    let extension_name = std::env::var(DIRECT_CHILD_EXTENSION_ENV).ok()?;
    let action = std::env::var(DIRECT_CHILD_ACTION_ENV)
        .ok()
        .and_then(|value| DirectExtensionChildAction::from_env(&value))
        .expect("direct extension child action is missing or invalid");
    let root = std::env::var_os(DIRECT_CHILD_ROOT_ENV)
        .map(PathBuf::from)
        .expect("direct extension child root is missing");
    let extension = Extension::by_sql_name(&extension_name)
        .expect("direct extension child extension name is not in the manifest");

    Some(match action {
        DirectExtensionChildAction::InstallBackup => {
            let backup_path = std::env::var_os(DIRECT_CHILD_BACKUP_ENV)
                .map(PathBuf::from)
                .expect("direct extension child backup path is missing");
            run_direct_extension_child_install_backup(extension, &root, &backup_path)
        }
        DirectExtensionChildAction::AssertExisting => {
            run_direct_extension_child_assert_existing(extension, &root)
        }
    })
}

fn run_direct_extension_child_install_backup(
    extension: Extension,
    root: &Path,
    backup_path: &Path,
) -> Result<()> {
    let db = block_on(
        Oliphaunt::builder()
            .path(root)
            .native_direct()
            .extension(extension)
            .open(),
    )?;
    install_or_load_extension(&db, EngineMode::NativeDirect, extension)?;
    assert_repeated_create_extension_error_recovers(&db, EngineMode::NativeDirect, extension)?;
    assert_extension_visible(&db, EngineMode::NativeDirect, extension)?;
    setup_extension_functional_smoke(&db, EngineMode::NativeDirect, extension)?;
    assert_extension_functional_smoke(&db, EngineMode::NativeDirect, extension)?;
    assert_extension_root_artifacts(root, EngineMode::NativeDirect, extension);
    let archive = block_on(db.backup(BackupRequest::physical_archive()))?;
    assert_eq!(archive.format, BackupFormat::PhysicalArchive);
    assert_physical_archive_contains_extension_catalog(
        &archive,
        EngineMode::NativeDirect,
        extension,
    );
    fs::write(backup_path, &archive.bytes)
        .expect("failed to write direct extension backup artifact");
    block_on(db.close())
}

fn run_direct_extension_child_assert_existing(extension: Extension, root: &Path) -> Result<()> {
    let db = block_on(
        Oliphaunt::builder()
            .path(root)
            .native_direct()
            .extension(extension)
            .existing_only()
            .open(),
    )?;
    assert_extension_visible(&db, EngineMode::NativeDirect, extension)?;
    assert_extension_functional_smoke(&db, EngineMode::NativeDirect, extension)?;
    assert_extension_root_artifacts(root, EngineMode::NativeDirect, extension);
    block_on(db.close())
}

fn run_extension_smoke(mode: EngineMode, broker: Option<&str>, extension: Extension) -> Result<()> {
    let root = unique_temp_root(&format!(
        "oliphaunt-extension-{}-{}",
        mode_label(mode),
        extension.sql_name()
    ));
    let restored_root = unique_temp_root(&format!(
        "oliphaunt-extension-{}-{}-restore",
        mode_label(mode),
        extension.sql_name()
    ));
    let result = run_extension_recovery_smoke(mode, broker, extension, &root, &restored_root);
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&restored_root);
    result
}

fn run_extension_recovery_smoke(
    mode: EngineMode,
    broker: Option<&str>,
    extension: Extension,
    root: &Path,
    restored_root: &Path,
) -> Result<()> {
    let db = block_on(extension_builder(mode, broker, extension, root).open())?;
    install_or_load_extension(&db, mode, extension)?;
    assert_repeated_create_extension_error_recovers(&db, mode, extension)?;
    assert_extension_visible(&db, mode, extension)?;
    setup_extension_functional_smoke(&db, mode, extension)?;
    assert_extension_functional_smoke(&db, mode, extension)?;
    assert_extension_root_artifacts(root, mode, extension);
    let archive = block_on(db.backup(BackupRequest::physical_archive()))?;
    assert_eq!(archive.format, BackupFormat::PhysicalArchive);
    assert_physical_archive_contains_extension_catalog(&archive, mode, extension);
    block_on(db.close())?;

    let reopened = block_on(
        extension_builder(mode, broker, extension, root)
            .existing_only()
            .open(),
    )?;
    assert_extension_visible(&reopened, mode, extension)?;
    assert_extension_functional_smoke(&reopened, mode, extension)?;
    assert_extension_root_artifacts(root, mode, extension);
    block_on(reopened.close())?;

    block_on(Oliphaunt::restore(RestoreRequest::physical_archive(
        restored_root,
        archive,
    )))?;
    let restored = block_on(
        extension_builder(mode, broker, extension, restored_root)
            .existing_only()
            .open(),
    )?;
    assert_extension_visible(&restored, mode, extension)?;
    assert_extension_functional_smoke(&restored, mode, extension)?;
    assert_extension_root_artifacts(restored_root, mode, extension);
    block_on(restored.close())
}

fn extension_builder(
    mode: EngineMode,
    broker: Option<&str>,
    extension: Extension,
    root: &Path,
) -> oliphaunt::OliphauntBuilder {
    let mut builder = Oliphaunt::builder()
        .path(root)
        .engine(mode)
        .extension(extension);
    if let Some(broker) = broker {
        builder = builder.broker_executable(broker);
    }
    builder
}

fn install_or_load_extension(db: &Oliphaunt, mode: EngineMode, extension: Extension) -> Result<()> {
    let sql = install_sql(extension);
    let response = block_on(db.exec_protocol_raw(raw_query_message(&sql)))?;
    assert_success_response(response.as_bytes(), mode, extension, "install/load")
}

fn assert_repeated_create_extension_error_recovers(
    db: &Oliphaunt,
    mode: EngineMode,
    extension: Extension,
) -> Result<()> {
    if !extension.creates_extension() {
        return Ok(());
    }

    let repeated = block_on(db.exec_protocol_raw(raw_query_message(&install_sql(extension))))?;
    let tags = raw_message_tags(repeated.as_bytes());
    assert!(
        tags.contains(&b'E'),
        "{mode:?} repeated CREATE EXTENSION {} did not produce ErrorResponse: {tags:?}",
        extension.sql_name()
    );
    assert!(
        tags.contains(&b'Z'),
        "{mode:?} repeated CREATE EXTENSION {} did not return ReadyForQuery: {tags:?}",
        extension.sql_name()
    );

    let recovered = exec_extension_sql(
        db,
        mode,
        extension,
        "post repeated-create recovery",
        "SELECT 'ready'::text AS state",
    )?;
    assert_first_data_row_text_values(
        recovered.as_bytes(),
        mode,
        extension,
        "post repeated-create recovery",
        &["ready"],
    );
    Ok(())
}

fn assert_extension_visible(db: &Oliphaunt, mode: EngineMode, extension: Extension) -> Result<()> {
    if extension.creates_extension() {
        let response = block_on(db.exec_protocol_raw(raw_query_message(&format!(
            "SELECT extname FROM pg_extension WHERE extname = '{}'",
            extension.sql_name()
        ))))?;
        assert_success_response(response.as_bytes(), mode, extension, "catalog visibility")?;
        assert_eq!(
            first_data_row_text_values(response.as_bytes()),
            vec![extension.sql_name().to_owned()],
            "{mode:?} extension {} was not present in pg_extension after restart/restore",
            extension.sql_name()
        );
        Ok(())
    } else {
        let response = block_on(db.exec_protocol_raw(raw_query_message(&install_sql(extension))))?;
        assert_success_response(response.as_bytes(), mode, extension, "reload visibility")
    }
}

fn install_sql(extension: Extension) -> String {
    extension.manifest_entry().smoke_sql()
}

fn setup_extension_functional_smoke(
    db: &Oliphaunt,
    mode: EngineMode,
    extension: Extension,
) -> Result<()> {
    match extension {
        Extension::Graph => exec_extension_sql(
            db,
            mode,
            extension,
            "functional setup",
            r#"
SELECT graph.reset();
DROP TABLE IF EXISTS liboliphaunt_graph_people CASCADE;
DROP TABLE IF EXISTS liboliphaunt_graph_companies CASCADE;
CREATE TABLE liboliphaunt_graph_companies (
  id text PRIMARY KEY,
  name text NOT NULL
);
CREATE TABLE liboliphaunt_graph_people (
  id text PRIMARY KEY,
  name text NOT NULL,
  company_id text REFERENCES liboliphaunt_graph_companies(id)
);
INSERT INTO liboliphaunt_graph_companies VALUES
  ('c1', 'Acme Bank'),
  ('c2', 'Northwind Trading');
INSERT INTO liboliphaunt_graph_people VALUES
  ('p1', 'Alice', 'c1'),
  ('p2', 'Bob', 'c1'),
  ('p3', 'Carol', 'c2');
SELECT graph.add_table(
  'public.liboliphaunt_graph_people'::regclass,
  id_column := 'id',
  columns := ARRAY['name']
);
SELECT graph.add_table(
  'public.liboliphaunt_graph_companies'::regclass,
  id_column := 'id',
  columns := ARRAY['name']
);
SELECT graph.add_edge(
  from_table := 'public.liboliphaunt_graph_people'::regclass,
  from_column := 'company_id',
  to_table := 'public.liboliphaunt_graph_companies'::regclass,
  to_column := 'id',
  label := 'works_at',
  bidirectional := true
);
SELECT * FROM graph.build();
"#,
        )
        .map(|_| ()),
        Extension::PgSearch => exec_extension_sql(
            db,
            mode,
            extension,
            "functional setup",
            r#"
DROP TABLE IF EXISTS liboliphaunt_pg_search_docs CASCADE;
CREATE TABLE liboliphaunt_pg_search_docs (
  id serial8 NOT NULL PRIMARY KEY,
  body text NOT NULL
);
INSERT INTO liboliphaunt_pg_search_docs (body) VALUES
  ('embedded postgres search with oliphaunt'),
  ('sqlite compatibility layer notes'),
  ('postgres full text search on mobile');
CREATE INDEX liboliphaunt_pg_search_docs_bm25
  ON liboliphaunt_pg_search_docs
  USING bm25 (id, body)
  WITH (key_field = 'id');
"#,
        )
        .map(|_| ()),
        _ => Ok(()),
    }
}

fn assert_extension_functional_smoke(
    db: &Oliphaunt,
    mode: EngineMode,
    extension: Extension,
) -> Result<()> {
    match extension {
        Extension::Graph => {
            let traverse = exec_extension_sql(
                db,
                mode,
                extension,
                "functional graph.traverse",
                r#"
SELECT CASE WHEN count(*) >= 1 THEN 'ok' ELSE 'fail' END AS graph_traverse
FROM graph.traverse(
  'public.liboliphaunt_graph_people'::regclass,
  'p1',
  2,
  hydrate := false
);
"#,
            )?;
            assert_first_data_row_text_values(
                traverse.as_bytes(),
                mode,
                extension,
                "functional graph.traverse",
                &["ok"],
            );

            let status = exec_extension_sql(
                db,
                mode,
                extension,
                "functional graph.status",
                r#"
SELECT CASE WHEN node_count = 5 AND edge_count >= 4 THEN 'ok' ELSE 'fail' END AS graph_status
FROM graph.status();
"#,
            )?;
            assert_first_data_row_text_values(
                status.as_bytes(),
                mode,
                extension,
                "functional graph.status",
                &["ok"],
            );

            let search = exec_extension_sql(
                db,
                mode,
                extension,
                "regression graph.search exact",
                r#"
SELECT COALESCE(string_agg(node_id, ',' ORDER BY node_id), '') AS graph_search
FROM graph.search(
  'name',
  'Alice',
  table_filter := 'public.liboliphaunt_graph_people'::regclass,
  mode := 'exact',
  hydrate := false
);
"#,
            )?;
            assert_first_data_row_text_values(
                search.as_bytes(),
                mode,
                extension,
                "regression graph.search exact",
                &["p1"],
            );

            let path = exec_extension_sql(
                db,
                mode,
                extension,
                "regression graph.shortest_path",
                r#"
SELECT CASE WHEN count(*) >= 2 AND bool_or(node_id = 'c1') THEN 'ok' ELSE 'fail' END AS graph_path
FROM graph.shortest_path(
  'public.liboliphaunt_graph_people'::regclass,
  'p1',
  'public.liboliphaunt_graph_companies'::regclass,
  'c1',
  hydrate := false
);
"#,
            )?;
            assert_first_data_row_text_values(
                path.as_bytes(),
                mode,
                extension,
                "regression graph.shortest_path",
                &["ok"],
            );
            Ok(())
        }
        Extension::PgSearch => {
            let response = exec_extension_sql(
                db,
                mode,
                extension,
                "functional bm25 query",
                r#"
SELECT COALESCE(string_agg(id::text, ',' ORDER BY id), '') AS hits
FROM liboliphaunt_pg_search_docs
WHERE body @@@ 'postgres';
"#,
            )?;
            assert_first_data_row_text_values(
                response.as_bytes(),
                mode,
                extension,
                "functional bm25 query",
                &["1,3"],
            );

            let all = exec_extension_sql(
                db,
                mode,
                extension,
                "regression paradedb.all",
                r#"
SELECT count(*)::text AS all_docs
FROM liboliphaunt_pg_search_docs
WHERE id @@@ paradedb.all();
"#,
            )?;
            assert_first_data_row_text_values(
                all.as_bytes(),
                mode,
                extension,
                "regression paradedb.all",
                &["3"],
            );

            let scored = exec_extension_sql(
                db,
                mode,
                extension,
                "regression pdb.score",
                r#"
SELECT CASE WHEN count(*) = 2 AND count(pdb.score(id)) = 2 THEN 'ok' ELSE 'fail' END AS scored
FROM liboliphaunt_pg_search_docs
WHERE body @@@ 'postgres';
"#,
            )?;
            assert_first_data_row_text_values(
                scored.as_bytes(),
                mode,
                extension,
                "regression pdb.score",
                &["ok"],
            );

            let tokenize = exec_extension_sql(
                db,
                mode,
                extension,
                "regression paradedb.tokenize stopwords",
                r#"
SELECT COALESCE(string_agg(token, ',' ORDER BY token), '') AS tokens
FROM paradedb.tokenize(
  paradedb.tokenizer('default', stopwords => ARRAY['stopword']),
  'something, stopword, else'
);
"#,
            )?;
            assert_first_data_row_text_values(
                tokenize.as_bytes(),
                mode,
                extension,
                "regression paradedb.tokenize stopwords",
                &["else,something"],
            );
            Ok(())
        }
        Extension::Pgcrypto => exec_extension_sql(
            db,
            mode,
            extension,
            "functional pgcrypto coverage",
            r#"
DO $$
DECLARE
  hashed text;
  encrypted bytea;
  armored text;
  header_count int;
  crypto_key bytea := decode('000102030405060708090a0b0c0d0e0f', 'hex');
  crypto_iv bytea := decode('101112131415161718191a1b1c1d1e1f', 'hex');
BEGIN
  IF encode(digest('abc', 'sha256'), 'hex') <> 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' THEN
    RAISE EXCEPTION 'sha256 digest failed';
  END IF;
  IF encode(hmac('test', 'key', 'sha1'), 'hex') <> '671f54ce0c540f78ffe1e26dcf9c2a047aea4fda' THEN
    RAISE EXCEPTION 'hmac failed';
  END IF;
  IF length(gen_random_bytes(16)) <> 16 THEN
    RAISE EXCEPTION 'random bytes length failed';
  END IF;
  IF gen_random_uuid()::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'random uuid format failed';
  END IF;
  SELECT crypt('secret', gen_salt('bf', 4)) INTO hashed;
  IF crypt('secret', hashed) <> hashed THEN
    RAISE EXCEPTION 'password hash verify failed';
  END IF;
  SELECT armor(digest('test', 'sha1'), ARRAY['Version'], ARRAY['oliphaunt']) INTO armored;
  IF position('Version: oliphaunt' in armored) = 0 THEN
    RAISE EXCEPTION 'armor header failed';
  END IF;
  SELECT count(*) INTO header_count FROM pgp_armor_headers(armored);
  IF header_count <> 1 THEN
    RAISE EXCEPTION 'armor header count failed: %', header_count;
  END IF;
  SELECT pgp_sym_encrypt('oliphaunt secret', 'passphrase') INTO encrypted;
  IF pgp_sym_decrypt(encrypted, 'passphrase') <> 'oliphaunt secret' THEN
    RAISE EXCEPTION 'PGP symmetric decrypt failed';
  END IF;
  IF pgp_key_id(encrypted) <> 'SYMKEY' THEN
    RAISE EXCEPTION 'PGP symmetric key id failed';
  END IF;
  SELECT encrypt(convert_to('oliphaunt raw cipher', 'UTF8'), crypto_key, 'aes') INTO encrypted;
  IF convert_from(decrypt(encrypted, crypto_key, 'aes'), 'UTF8') <> 'oliphaunt raw cipher' THEN
    RAISE EXCEPTION 'raw decrypt failed';
  END IF;
  SELECT encrypt_iv(convert_to('oliphaunt iv cipher', 'UTF8'), crypto_key, crypto_iv, 'aes-cbc') INTO encrypted;
  IF convert_from(decrypt_iv(encrypted, crypto_key, crypto_iv, 'aes-cbc'), 'UTF8') <> 'oliphaunt iv cipher' THEN
    RAISE EXCEPTION 'raw iv decrypt failed';
  END IF;
END $$;
"#,
        )
        .map(|_| ()),
        Extension::Postgis => exec_extension_sql(
            db,
            mode,
            extension,
            "functional postgis coverage",
            include_str!("fixtures/postgis-smoke.sql"),
        )
        .map(|_| ()),
        Extension::UuidOssp => exec_extension_sql(
            db,
            mode,
            extension,
            "functional uuid-ossp coverage",
            r#"
DO $$
DECLARE
  id uuid;
BEGIN
  SELECT uuid_generate_v1() INTO id;
  IF length(id::text) <> 36 THEN
    RAISE EXCEPTION 'uuid-ossp v1 length failed';
  END IF;
  SELECT uuid_generate_v4() INTO id;
  IF length(id::text) <> 36 THEN
    RAISE EXCEPTION 'uuid-ossp v4 length failed';
  END IF;
  IF uuid_generate_v3(uuid_ns_dns(), 'www.example.com')::text <> '5df41881-3aed-3515-88a7-2f4a814cf09e' THEN
    RAISE EXCEPTION 'uuid-ossp v3 failed';
  END IF;
  IF uuid_generate_v5(uuid_ns_dns(), 'www.example.com')::text <> '2ed6657d-e927-568b-95e1-2665a8aea6a2' THEN
    RAISE EXCEPTION 'uuid-ossp v5 failed';
  END IF;
  IF uuid_nil()::text <> '00000000-0000-0000-0000-000000000000' THEN
    RAISE EXCEPTION 'uuid-ossp nil failed';
  END IF;
  IF uuid_ns_dns()::text <> '6ba7b810-9dad-11d1-80b4-00c04fd430c8' THEN
    RAISE EXCEPTION 'uuid-ossp dns namespace failed';
  END IF;
  IF uuid_ns_oid()::text <> '6ba7b812-9dad-11d1-80b4-00c04fd430c8' THEN
    RAISE EXCEPTION 'uuid-ossp oid namespace failed';
  END IF;
END $$;
"#,
        )
        .map(|_| ()),
        _ => Ok(()),
    }
}

fn exec_extension_sql(
    db: &Oliphaunt,
    mode: EngineMode,
    extension: Extension,
    action: &str,
    sql: &str,
) -> Result<oliphaunt::ProtocolResponse> {
    let response = block_on(db.exec_protocol_raw(raw_query_message(sql)))?;
    assert_success_response(response.as_bytes(), mode, extension, action)?;
    Ok(response)
}

fn assert_first_data_row_text_values(
    bytes: &[u8],
    mode: EngineMode,
    extension: Extension,
    action: &str,
    expected: &[&str],
) {
    let expected = expected
        .iter()
        .map(|value| value.to_string())
        .collect::<Vec<_>>();
    assert_eq!(
        first_data_row_text_values(bytes),
        expected,
        "{mode:?} extension {} returned an unexpected row during {action}",
        extension.sql_name()
    );
}

fn assert_success_response(
    bytes: &[u8],
    mode: EngineMode,
    extension: Extension,
    action: &str,
) -> Result<()> {
    let tags = raw_message_tags(bytes);
    assert!(
        !tags.contains(&b'E'),
        "{mode:?} extension {} failed during {action} with tags {tags:?}",
        extension.sql_name()
    );
    assert!(
        tags.contains(&b'Z'),
        "{mode:?} extension {} did not return ReadyForQuery during {action}: {tags:?}",
        extension.sql_name()
    );
    Ok(())
}

fn assert_physical_archive_contains_extension_catalog(
    artifact: &oliphaunt::BackupArtifact,
    mode: EngineMode,
    extension: Extension,
) {
    let mut archive = tar::Archive::new(Cursor::new(artifact.bytes.as_slice()));
    let has_catalog = archive.entries().unwrap().any(|entry| {
        entry
            .unwrap()
            .path()
            .map(|path| path.starts_with("pgdata/base"))
            .unwrap_or(false)
    });
    assert!(
        has_catalog,
        "{mode:?} extension {} physical archive did not include relation storage",
        extension.sql_name()
    );
}

fn assert_extension_root_artifacts(root: &Path, mode: EngineMode, extension: Extension) {
    if extension == Extension::Graph {
        let graph_file = root.join("pgdata/graph/main.pggraph");
        assert!(
            graph_file.is_file(),
            "{mode:?} extension graph did not persist its graph artifact under the database root at {}",
            graph_file.display()
        );
    }
}

fn native_runtime_env_is_unavailable() -> bool {
    std::env::var_os("LIBOLIPHAUNT_PATH").is_none()
}

fn raw_query_message(sql: &str) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(sql.as_bytes());
    body.push(0);

    let mut packet = Vec::with_capacity(body.len() + 5);
    packet.push(b'Q');
    packet.extend_from_slice(&((body.len() + 4) as i32).to_be_bytes());
    packet.extend_from_slice(&body);
    packet
}

fn raw_message_tags(mut bytes: &[u8]) -> Vec<u8> {
    let mut tags = Vec::new();
    while bytes.len() >= 5 {
        let tag = bytes[0];
        let len = i32::from_be_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]);
        if len < 4 {
            break;
        }
        let total = 1 + len as usize;
        if bytes.len() < total {
            break;
        }
        tags.push(tag);
        bytes = &bytes[total..];
    }
    tags
}

fn first_data_row_text_values(mut bytes: &[u8]) -> Vec<String> {
    while bytes.len() >= 5 {
        let tag = bytes[0];
        let len = i32::from_be_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]);
        if len < 4 {
            break;
        }
        let total = 1 + len as usize;
        if bytes.len() < total {
            break;
        }
        if tag == b'D' {
            return parse_data_row_text_values(&bytes[5..total]);
        }
        bytes = &bytes[total..];
    }
    Vec::new()
}

fn parse_data_row_text_values(payload: &[u8]) -> Vec<String> {
    if payload.len() < 2 {
        return Vec::new();
    }
    let columns = i16::from_be_bytes([payload[0], payload[1]]);
    if columns < 0 {
        return Vec::new();
    }
    let mut offset = 2;
    let mut values = Vec::with_capacity(columns as usize);
    for _ in 0..columns {
        if payload.len().saturating_sub(offset) < 4 {
            return Vec::new();
        }
        let len = i32::from_be_bytes([
            payload[offset],
            payload[offset + 1],
            payload[offset + 2],
            payload[offset + 3],
        ]);
        offset += 4;
        if len == -1 {
            values.push("NULL".to_owned());
            continue;
        }
        if len < 0 {
            return Vec::new();
        }
        let len = len as usize;
        if payload.len().saturating_sub(offset) < len {
            return Vec::new();
        }
        values.push(String::from_utf8_lossy(&payload[offset..offset + len]).into_owned());
        offset += len;
    }
    values
}

fn mode_label(mode: EngineMode) -> &'static str {
    match mode {
        EngineMode::NativeDirect => "direct",
        EngineMode::NativeBroker => "broker",
        EngineMode::NativeServer => "server",
    }
}

fn unique_temp_root(prefix: &str) -> PathBuf {
    let parent = std::env::temp_dir();
    let pid = std::process::id();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    for attempt in 0..100_u32 {
        let path = parent.join(format!("{prefix}-{pid}-{nanos}-{attempt}"));
        if !path.exists() {
            return path;
        }
    }
    panic!("failed to allocate a unique temp root for {prefix}");
}

fn block_on<F: Future>(future: F) -> F::Output {
    let waker = Waker::from(Arc::new(ThreadWaker(thread::current())));
    let mut context = Context::from_waker(&waker);
    let mut future = Box::pin(future);

    loop {
        match future.as_mut().poll(&mut context) {
            Poll::Ready(value) => return value,
            Poll::Pending => thread::park_timeout(Duration::from_millis(1)),
        }
    }
}

struct ThreadWaker(thread::Thread);

impl Wake for ThreadWaker {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }

    fn wake_by_ref(self: &Arc<Self>) {
        self.0.unpark();
    }
}
