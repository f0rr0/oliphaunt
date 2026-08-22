use std::collections::BTreeSet;
use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::task::{Context, Poll, Wake, Waker};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use oliphaunt::{Extension, Oliphaunt, OliphauntServer, Result};

mod support;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TestMode {
    Direct,
    Broker,
    Server,
}

const DIRECT_CHILD_EXTENSION_ENV: &str = "OLIPHAUNT_EXTENSION_DIRECT_CHILD";
const DIRECT_CHILD_ACTION_ENV: &str = "OLIPHAUNT_EXTENSION_DIRECT_ACTION";
const DIRECT_CHILD_ROOT_ENV: &str = "OLIPHAUNT_EXTENSION_DIRECT_ROOT";
const DIRECT_CHILD_BACKUP_ENV: &str = "OLIPHAUNT_EXTENSION_DIRECT_BACKUP";
const RELEASE_PROOF_RUNNER_ENV: &str = "OLIPHAUNT_NATIVE_EXTENSION_PROOF_RUNNER";

fn extension_smoke_recipe(sql_name: &str) -> String {
    support::fixture_text(
        &format!("shared/fixtures/extensions/{sql_name}.sql"),
        &format!("tests/fixtures/extensions/{sql_name}.sql"),
    )
}

fn extension_smoke_statements(sql: &str) -> impl Iterator<Item = &str> {
    sql.split("-- oliphaunt-statement")
        .map(str::trim)
        .filter(|statement| !statement.is_empty())
}

#[test]
fn native_release_proof_catalog_and_smoke_recipes_match() {
    let names = Extension::ALL_PG18_SUPPORTED
        .iter()
        .map(|extension| extension.sql_name())
        .collect::<Vec<_>>();
    assert!(!names.is_empty());
    assert_eq!(
        names.iter().copied().collect::<BTreeSet<_>>().len(),
        names.len()
    );
    assert!(
        names.windows(2).all(|pair| pair[0] < pair[1]),
        "native proof manifest must remain sorted by SQL name"
    );

    let package_root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let recipe_directory = [
        package_root
            .join("../..")
            .join("shared/fixtures/extensions"),
        package_root
            .join("../..")
            .join("src/shared/fixtures/extensions"),
        package_root.join("tests/fixtures/extensions"),
    ]
    .into_iter()
    .find(|candidate| candidate.is_dir())
    .expect("canonical extension smoke recipe directory is missing");
    let recipes = fs::read_dir(recipe_directory)
        .expect("read canonical extension smoke recipes")
        .filter_map(|entry| {
            let path = entry
                .expect("read canonical extension smoke recipe entry")
                .path();
            (path.extension().and_then(|extension| extension.to_str()) == Some("sql")).then(|| {
                path.file_stem()
                    .and_then(|name| name.to_str())
                    .expect("extension smoke recipe must have a UTF-8 SQL filename")
                    .to_owned()
            })
        })
        .collect::<BTreeSet<_>>();
    assert_eq!(
        recipes,
        names
            .iter()
            .map(|name| (*name).to_owned())
            .collect::<BTreeSet<_>>()
    );
    for sql_name in names {
        let recipe = extension_smoke_recipe(sql_name);
        assert!(
            extension_smoke_statements(&recipe).next().is_some(),
            "extension {sql_name} has an empty smoke recipe"
        );
    }
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
    let release_extensions = Extension::ALL_PG18_SUPPORTED
        .iter()
        .copied()
        .filter(|extension| requested.contains(extension.sql_name()))
        .collect::<Vec<_>>();
    assert_eq!(
        release_extensions.len(),
        requested.len(),
        "planned native extension proof set contains an unknown SQL name"
    );
    let planned_count = release_extensions.len();
    let names = release_extensions
        .iter()
        .map(|extension| extension.sql_name())
        .collect::<BTreeSet<_>>();
    assert_eq!(
        names.len(),
        planned_count,
        "canonical native release proof contains duplicate extension SQL names"
    );

    let selected = release_extensions
        .iter()
        .enumerate()
        .filter(|(index, _)| index % shard_count == shard_index)
        .map(|(_, extension)| *extension)
        .collect::<Vec<_>>();
    println!(
        "OLIPHAUNT_NATIVE_EXTENSION_PROOF_START shard={shard_index}/{shard_count} selected={} planned={planned_count} modes=direct,broker,server",
        selected.len()
    );

    for extension in selected {
        println!(
            "OLIPHAUNT_NATIVE_EXTENSION_PROOF_EXTENSION_START shard={shard_index}/{shard_count} extension={}",
            extension.sql_name(),
        );
        run_direct_extension_smoke(extension);
        run_extension_smoke(TestMode::Broker, Some(&broker), extension).unwrap();
        run_extension_smoke(TestMode::Server, None, extension).unwrap();
        println!(
            "OLIPHAUNT_NATIVE_EXTENSION_PROOF_EXTENSION_PASS shard={shard_index}/{shard_count} extension={} modes=direct,broker,server lifecycle=install-load-restart-backup-restore",
            extension.sql_name()
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

    for extension in Extension::ALL_PG18_SUPPORTED {
        run_direct_extension_smoke(*extension);
        run_extension_smoke(TestMode::Broker, Some(broker), *extension).unwrap();
        run_extension_smoke(TestMode::Server, None, *extension).unwrap();
    }
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

        let backup = fs::read(&backup_path).expect("direct extension child did not write backup");
        Oliphaunt::restore(&restored_root, backup).unwrap();

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
    let db = TestDatabase::Embedded(block_on(
        Oliphaunt::builder()
            .directory(root)
            .direct()
            .extension(extension)
            .open(),
    )?);
    install_or_load_extension(&db, TestMode::Direct, extension)?;
    assert_repeated_create_extension_error_recovers(&db, TestMode::Direct, extension)?;
    assert_extension_visible(&db, TestMode::Direct, extension)?;
    run_extension_functional_smoke(&db, TestMode::Direct, extension)?;
    assert_extension_root_artifacts(root, TestMode::Direct, extension);
    let archive = block_on(db.backup())?;
    fs::write(backup_path, &archive).expect("failed to write direct extension backup artifact");
    block_on(db.close())
}

fn run_direct_extension_child_assert_existing(extension: Extension, root: &Path) -> Result<()> {
    let db = TestDatabase::Embedded(block_on(
        Oliphaunt::builder()
            .directory(root)
            .direct()
            .extension(extension)
            .open(),
    )?);
    assert_extension_visible(&db, TestMode::Direct, extension)?;
    run_extension_functional_smoke(&db, TestMode::Direct, extension)?;
    assert_extension_root_artifacts(root, TestMode::Direct, extension);
    block_on(db.close())
}

fn run_extension_smoke(mode: TestMode, broker: Option<&str>, extension: Extension) -> Result<()> {
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
    mode: TestMode,
    broker: Option<&str>,
    extension: Extension,
    root: &Path,
    restored_root: &Path,
) -> Result<()> {
    let db = block_on(open_extension_database(mode, broker, extension, root))?;
    install_or_load_extension(&db, mode, extension)?;
    assert_repeated_create_extension_error_recovers(&db, mode, extension)?;
    assert_extension_visible(&db, mode, extension)?;
    run_extension_functional_smoke(&db, mode, extension)?;
    assert_extension_root_artifacts(root, mode, extension);
    let archive = if mode == TestMode::Server {
        None
    } else {
        Some(block_on(db.backup())?)
    };
    block_on(db.close())?;

    let reopened = block_on(open_extension_database(mode, broker, extension, root))?;
    assert_extension_visible(&reopened, mode, extension)?;
    run_extension_functional_smoke(&reopened, mode, extension)?;
    assert_extension_root_artifacts(root, mode, extension);
    block_on(reopened.close())?;

    let Some(archive) = archive else {
        return Ok(());
    };
    Oliphaunt::restore(restored_root, archive)?;
    let restored = block_on(open_extension_database(
        mode,
        broker,
        extension,
        restored_root,
    ))?;
    assert_extension_visible(&restored, mode, extension)?;
    run_extension_functional_smoke(&restored, mode, extension)?;
    assert_extension_root_artifacts(restored_root, mode, extension);
    block_on(restored.close())
}

async fn open_extension_database(
    mode: TestMode,
    broker: Option<&str>,
    extension: Extension,
    root: &Path,
) -> Result<TestDatabase> {
    let builder = extension_builder(mode, broker, extension, root);
    if mode == TestMode::Server {
        builder.open_server().await.map(TestDatabase::Server)
    } else {
        builder.open().await.map(TestDatabase::Embedded)
    }
}

enum TestDatabase {
    Embedded(Oliphaunt),
    Server(OliphauntServer),
}

impl TestDatabase {
    async fn exec_protocol_raw(&self, request: impl AsRef<[u8]>) -> Result<Vec<u8>> {
        match self {
            Self::Embedded(database) => database.exec_protocol_raw(request).await,
            Self::Server(database) => database.exec_protocol_raw(request).await,
        }
    }

    async fn backup(&self) -> Result<Vec<u8>> {
        match self {
            Self::Embedded(database) => database.backup().await,
            Self::Server(_) => panic!("native server backup must use pg_basebackup"),
        }
    }

    async fn close(&self) -> Result<()> {
        match self {
            Self::Embedded(database) => database.close().await,
            Self::Server(database) => database.close().await,
        }
    }
}

fn extension_builder(
    mode: TestMode,
    broker: Option<&str>,
    extension: Extension,
    root: &Path,
) -> oliphaunt::OliphauntBuilder {
    let builder = Oliphaunt::builder().directory(root).extension(extension);
    let mut builder = match mode {
        TestMode::Direct | TestMode::Server => builder.direct(),
        TestMode::Broker => builder.broker(),
    };
    if let Some(broker) = broker {
        builder = builder.broker_executable(broker);
    }
    builder
}

fn install_or_load_extension(
    db: &TestDatabase,
    mode: TestMode,
    extension: Extension,
) -> Result<()> {
    let sql = install_sql(extension);
    let response = block_on(db.exec_protocol_raw(raw_query_message(&sql)))?;
    assert_success_response(response.as_slice(), mode, extension, "install/load")
}

fn assert_repeated_create_extension_error_recovers(
    db: &TestDatabase,
    mode: TestMode,
    extension: Extension,
) -> Result<()> {
    if extension == Extension::AutoExplain {
        return Ok(());
    }

    let repeated = block_on(db.exec_protocol_raw(raw_query_message(&install_sql(extension))))?;
    let tags = raw_message_tags(repeated.as_slice());
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
        recovered.as_slice(),
        mode,
        extension,
        "post repeated-create recovery",
        &["ready"],
    );
    Ok(())
}

fn assert_extension_visible(db: &TestDatabase, mode: TestMode, extension: Extension) -> Result<()> {
    if extension != Extension::AutoExplain {
        let response = block_on(db.exec_protocol_raw(raw_query_message(&format!(
            "SELECT extname FROM pg_extension WHERE extname = '{}'",
            extension.sql_name()
        ))))?;
        assert_success_response(response.as_slice(), mode, extension, "catalog visibility")?;
        assert_eq!(
            first_data_row_text_values(response.as_slice()),
            vec![extension.sql_name().to_owned()],
            "{mode:?} extension {} was not present in pg_extension after restart/restore",
            extension.sql_name()
        );
        Ok(())
    } else {
        let response = block_on(db.exec_protocol_raw(raw_query_message(&install_sql(extension))))?;
        assert_success_response(response.as_slice(), mode, extension, "reload visibility")
    }
}

fn install_sql(extension: Extension) -> String {
    if extension != Extension::AutoExplain {
        let sql_name = extension.sql_name().replace('"', "\"\"");
        format!("CREATE EXTENSION \"{sql_name}\" CASCADE")
    } else {
        let sql_name = extension.sql_name().replace('\'', "''");
        format!("LOAD '{sql_name}'")
    }
}

fn run_extension_functional_smoke(
    db: &TestDatabase,
    mode: TestMode,
    extension: Extension,
) -> Result<()> {
    let recipe = extension_smoke_recipe(extension.sql_name());
    for statement in extension_smoke_statements(&recipe) {
        exec_extension_sql(db, mode, extension, "functional smoke", statement)?;
    }
    Ok(())
}

fn exec_extension_sql(
    db: &TestDatabase,
    mode: TestMode,
    extension: Extension,
    action: &str,
    sql: &str,
) -> Result<Vec<u8>> {
    let response = block_on(db.exec_protocol_raw(raw_query_message(sql)))?;
    assert_success_response(response.as_slice(), mode, extension, action)?;
    Ok(response)
}

fn assert_first_data_row_text_values(
    bytes: &[u8],
    mode: TestMode,
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
    mode: TestMode,
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

fn assert_extension_root_artifacts(_root: &Path, _mode: TestMode, _extension: Extension) {}

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

fn mode_label(mode: TestMode) -> &'static str {
    match mode {
        TestMode::Direct => "direct",
        TestMode::Broker => "broker",
        TestMode::Server => "server",
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
