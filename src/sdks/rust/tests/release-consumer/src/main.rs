use std::error::Error;
use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::task::{Context, Poll, Wake, Waker};
use std::thread;
use std::time::Duration;

use oliphaunt::{
    BackupArtifact, BackupFormat, BackupRequest, Extension, Oliphaunt, OliphauntRuntime,
    RestoreRequest,
};

fn main() -> Result<(), Box<dyn Error>> {
    let work_root = required_directory("OLIPHAUNT_RUST_RELEASE_CONSUMER_WORK_DIR")?;
    let library = required_file("LIBOLIPHAUNT_PATH")?;
    let broker = required_executable("OLIPHAUNT_BROKER")?;
    // Validate the exact server artifact selected by the release harness. The
    // SDK must still launch the materialized runtime copy so selected
    // extension control/SQL files are resolved relative to that executable.
    required_executable("OLIPHAUNT_POSTGRES")?;

    prove_server(&work_root)?;
    println!(
        "OLIPHAUNT_RUST_RELEASE_CONSUMER_MODE_PASS mode=nativeServer checks=open,select,vector,backup,restore,close"
    );
    prove_broker(&work_root, &broker)?;
    println!(
        "OLIPHAUNT_RUST_RELEASE_CONSUMER_MODE_PASS mode=nativeBroker checks=open,select,vector,backup,close"
    );
    // NativeDirect owns process-global embedded PostgreSQL state, so exercise
    // it last after the server and broker roots have been closed and restored.
    prove_direct(&work_root, &library)?;
    println!(
        "OLIPHAUNT_RUST_RELEASE_CONSUMER_MODE_PASS mode=nativeDirect checks=open,select,vector,backup,close"
    );

    println!(
        "Rust exact-candidate consumer proof passed: server, broker, direct, backup, restore, vector"
    );
    println!("OLIPHAUNT_RUST_RELEASE_CONSUMER_PASS");
    Ok(())
}

fn prove_server(work_root: &Path) -> Result<(), Box<dyn Error>> {
    let root = work_root.join("server-root");
    let restored_root = work_root.join("server-restored-root");
    let db = block_on(
        Oliphaunt::builder()
            .path(&root)
            .native_server()
            .extension(Extension::Vector)
            .open(),
    )?;
    create_and_select_vector(&db, "server", "[1,2,3]")?;
    block_on(db.query("CREATE TABLE release_consumer(value integer NOT NULL)"))?;
    block_on(db.query("INSERT INTO release_consumer VALUES (42)"))?;
    let backup = block_on(db.backup(BackupRequest::physical_archive()))?;
    require_physical_backup(&backup, "server")?;
    block_on(db.close())?;

    block_on(Oliphaunt::restore(RestoreRequest::physical_archive(
        &restored_root,
        backup,
    )))?;
    let restored = block_on(
        Oliphaunt::builder()
            .path(&restored_root)
            .native_server()
            .extension(Extension::Vector)
            .existing_only()
            .open(),
    )?;
    require_query_value(
        &restored,
        "SELECT value::text AS value FROM release_consumer",
        "42",
        "server restored scalar",
    )?;
    require_query_value(
        &restored,
        "SELECT '[1,2,3]'::vector::text AS value",
        "[1,2,3]",
        "server restored vector",
    )?;
    block_on(restored.close())?;
    Ok(())
}

fn prove_broker(work_root: &Path, broker: &Path) -> Result<(), Box<dyn Error>> {
    let db = block_on(
        Oliphaunt::builder()
            .path(work_root.join("broker-root"))
            .native_broker()
            .broker_executable(broker)
            .extension(Extension::Vector)
            .open(),
    )?;
    create_and_select_vector(&db, "broker", "[4,5,6]")?;
    let backup = block_on(db.backup(BackupRequest::physical_archive()))?;
    require_physical_backup(&backup, "broker")?;
    block_on(db.close())?;
    Ok(())
}

fn prove_direct(work_root: &Path, library: &Path) -> Result<(), Box<dyn Error>> {
    let db = block_on(
        Oliphaunt::builder()
            .path(work_root.join("direct-root"))
            .native_direct()
            .runtime(OliphauntRuntime::from_path(library))
            .extension(Extension::Vector)
            .open(),
    )?;
    create_and_select_vector(&db, "direct", "[7,8,9]")?;
    let backup = block_on(db.backup(BackupRequest::physical_archive()))?;
    require_physical_backup(&backup, "direct")?;
    block_on(db.close())?;
    Ok(())
}

fn create_and_select_vector(
    db: &Oliphaunt,
    mode: &str,
    vector: &str,
) -> Result<(), Box<dyn Error>> {
    block_on(db.query("CREATE EXTENSION vector"))?;
    require_query_value(
        db,
        &format!("SELECT '{vector}'::vector::text AS value"),
        vector,
        &format!("{mode} vector"),
    )
}

fn require_query_value(
    db: &Oliphaunt,
    sql: &str,
    expected: &str,
    context: &str,
) -> Result<(), Box<dyn Error>> {
    let result = block_on(db.query(sql))?;
    let actual = result.get_text(0, "value")?.ok_or_else(|| {
        io::Error::other(format!(
            "{context} query returned SQL NULL instead of {expected}"
        ))
    })?;
    if actual != expected {
        return Err(io::Error::other(format!(
            "{context} query returned {actual:?}, expected {expected:?}",
        ))
        .into());
    }
    Ok(())
}

fn require_physical_backup(artifact: &BackupArtifact, mode: &str) -> Result<(), Box<dyn Error>> {
    if artifact.format != BackupFormat::PhysicalArchive || artifact.bytes.is_empty() {
        return Err(io::Error::other(format!(
            "{mode} did not produce a non-empty physical backup archive",
        ))
        .into());
    }
    Ok(())
}

fn required_directory(name: &str) -> Result<PathBuf, Box<dyn Error>> {
    let path = required_path(name)?;
    if !path.is_dir() {
        return Err(
            io::Error::other(format!("{name} is not a directory: {}", path.display(),)).into(),
        );
    }
    Ok(path)
}

fn required_file(name: &str) -> Result<PathBuf, Box<dyn Error>> {
    let path = required_path(name)?;
    if !path.is_file() {
        return Err(io::Error::other(format!("{name} is not a file: {}", path.display(),)).into());
    }
    Ok(path)
}

fn required_executable(name: &str) -> Result<PathBuf, Box<dyn Error>> {
    let path = required_file(name)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if path.metadata()?.permissions().mode() & 0o111 == 0 {
            return Err(
                io::Error::other(format!("{name} is not executable: {}", path.display(),)).into(),
            );
        }
    }
    Ok(path)
}

fn required_path(name: &str) -> Result<PathBuf, Box<dyn Error>> {
    let value = std::env::var_os(name)
        .ok_or_else(|| io::Error::other(format!("missing required environment variable {name}")))?;
    if value.is_empty() {
        return Err(
            io::Error::other(format!("required environment variable {name} is empty")).into(),
        );
    }
    Ok(PathBuf::from(value))
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
