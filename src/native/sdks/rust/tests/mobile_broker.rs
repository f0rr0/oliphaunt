#![cfg(all(
    feature = "mobile-bindings",
    any(target_vendor = "apple", target_os = "linux", target_os = "android")
))]

use liboliphaunt_native_bindings::NativeOpenOptions;
use oliphaunt::mobile::{
    Request,
    broker::{self, Control, Epoch, Retirement, Worker},
};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

struct Platform(Arc<Worker>);
impl Control for Platform {
    fn cancel(&self, epoch: Epoch, id: u64) -> oliphaunt::Result<()> {
        self.0.cancel(epoch, id);
        Ok(())
    }
    fn close(&self, epoch: Epoch) -> oliphaunt::Result<()> {
        self.0.close(epoch);
        Ok(())
    }
}
struct Retired(AtomicBool);
impl Retirement for Retired {
    fn retire(&self) {
        self.0.store(true, Ordering::Release);
    }
}

fn block_on<F: std::future::Future>(future: F) -> F::Output {
    struct Wake(std::thread::Thread);
    impl std::task::Wake for Wake {
        fn wake(self: Arc<Self>) {
            self.0.unpark();
        }
    }
    let waker = std::task::Waker::from(Arc::new(Wake(std::thread::current())));
    let mut context = std::task::Context::from_waker(&waker);
    let mut future = std::pin::pin!(future);
    loop {
        match future.as_mut().poll(&mut context) {
            std::task::Poll::Ready(result) => return result,
            std::task::Poll::Pending => std::thread::park(),
        }
    }
}
fn query(sql: &str) -> Vec<u8> {
    let mut bytes = vec![b'Q'];
    bytes.extend_from_slice(&((sql.len() + 5) as u32).to_be_bytes());
    bytes.extend_from_slice(sql.as_bytes());
    bytes.push(0);
    bytes
}

// Each child represents one fresh mobile process generation; actual platform
// service/extension launch and signing still require installed-app checks.
#[test]
fn mobile_broker_native_roundtrip() {
    if std::env::var_os("LIBOLIPHAUNT_PATH").is_none() {
        return;
    }
    if let Ok(action) = std::env::var("OLIPHAUNT_MOBILE_TEST_ACTION") {
        let root = PathBuf::from(std::env::var_os("OLIPHAUNT_MOBILE_TEST_ROOT").unwrap());
        child(&action, &root);
        return;
    }
    let root = std::env::temp_dir().join(format!("oliphaunt-mobile-broker-{}", std::process::id()));
    fs::create_dir(&root).unwrap();
    let result = std::panic::catch_unwind(|| {
        let initialized = Command::new(std::env::var_os("OLIPHAUNT_INITDB").unwrap())
            .env("OLIPHAUNT_INTERNAL_SKIP_ICU_DISCOVERY", "1")
            .args([
                "--no-locale",
                "--encoding=UTF8",
                "--username=postgres",
                "--auth=trust",
                "--pgdata",
            ])
            .arg(root.join("original/pgdata"))
            .output()
            .unwrap();
        assert!(
            initialized.status.success(),
            "{}",
            String::from_utf8_lossy(&initialized.stderr)
        );
        fs::write(root.join("original/.oliphaunt.json"),
            br#"{"schema":"oliphaunt-database-root-v1","engineFamily":"native","pgdata":"pgdata","postgresMajor":18,"physicalFormat":"native-pg18-v1"}"#).unwrap();
        for action in ["produce", "restore", "verify", "stream"] {
            let output = Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "mobile_broker_native_roundtrip", "--nocapture"])
                .env("OLIPHAUNT_MOBILE_TEST_ACTION", action)
                .env("OLIPHAUNT_MOBILE_TEST_ROOT", &root)
                .output()
                .unwrap();
            if action == "stream" {
                print!("{}", String::from_utf8_lossy(&output.stdout));
            }
            assert!(
                output.status.success(),
                "{action}: {}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
    });
    fs::remove_dir_all(root).unwrap();
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}

fn child(action: &str, root: &Path) {
    let (host, socket) = std::os::unix::net::UnixStream::pair().unwrap();
    let retired = Arc::new(Retired(AtomicBool::new(false)));
    let worker = Worker::new(socket, retired.clone(), Duration::from_secs(30)).unwrap();
    let control = Arc::new(Platform(worker.clone()));
    let library = PathBuf::from(std::env::var_os("LIBOLIPHAUNT_PATH").unwrap());
    let archive = root.join("backup.tar");
    if action == "restore" {
        let epoch = worker.epoch();
        let destination = root.join("restored");
        let serving =
            std::thread::spawn(move || block_on(worker.restore(Some(library), destination)));
        block_on(broker::restore(
            host,
            epoch,
            control,
            Some(Duration::from_secs(30)),
            fs::File::open(&archive).unwrap(),
        ))
        .unwrap();
        serving.join().unwrap().unwrap();
        assert!(root.join("restored/.oliphaunt.json").is_file());
    } else {
        let ready = block_on(worker.open(NativeOpenOptions {
            library_path: Some(library),
            pgdata: root.join(if action == "produce" {
                "original/pgdata"
            } else {
                "restored/pgdata"
            }),
            runtime_directory: std::env::var_os("OLIPHAUNT_INSTALL_DIR").map(Into::into),
            module_directory: None,
            icu_data_directory: None,
            username: "postgres".into(),
            database: "postgres".into(),
            startup_args: vec![],
        }))
        .unwrap();
        assert_eq!(ready.abi, 12);
        assert!(!ready.runtime_version.is_empty());
        let serving = std::thread::spawn(move || block_on(worker.serve()));
        let (database, connection) =
            block_on(broker::connect(host, ready.epoch, control, None)).unwrap();
        if action == "produce" {
            block_on(Request::new(&database).execute(query("CREATE TABLE broker_probe(value text); INSERT INTO broker_probe VALUES ('roundtrip')"))).unwrap();
            let large =
                block_on(Request::new(&database).execute(query("SELECT repeat('x', 8388608)")))
                    .unwrap();
            assert!(large.len() > 8 * 1024 * 1024); // One field exceeds native's 4 MiB queue.
            let mut extended_copy = Vec::new();
            let mut parse = b"\0COPY broker_probe FROM STDIN\0".to_vec();
            parse.extend_from_slice(&[0, 0]);
            for (tag, payload) in [
                (b'P', parse.as_slice()),
                (b'B', &[0, 0, 0, 0, 0, 0, 0, 0][..]),
                (b'E', &[0, 0, 0, 0, 0][..]),
                (b'S', &[][..]),
            ] {
                extended_copy.push(tag);
                extended_copy.extend_from_slice(&((payload.len() + 4) as u32).to_be_bytes());
                extended_copy.extend_from_slice(payload);
            }
            for request in [query("COPY broker_probe FROM STDIN"), extended_copy] {
                // Recovery must drain its input before accepting another query.
                for _ in 0..16 {
                    let copy =
                        block_on(Request::new(&database).execute(request.clone())).unwrap_err();
                    assert_eq!(
                        copy.broker_failure().unwrap().execution,
                        broker::Execution::Completed
                    );
                    assert!(!copy.broker_failure().unwrap().requires_reopen);
                    let recovered =
                        block_on(Request::new(&database).execute(query("SELECT 42"))).unwrap();
                    assert!(recovered.windows(2).any(|bytes| bytes == b"42"));
                }
            }
            connection.set_operation_budget(Some(Duration::from_millis(100)));
            let cancelled =
                block_on(Request::new(&database).execute(query("SELECT pg_sleep(60)"))).unwrap();
            assert!(cancelled.windows(5).any(|bytes| bytes == b"57014"));
            assert!(connection.is_usable());
            block_on(Request::new(&database).backup_to(fs::File::create(&archive).unwrap()))
                .unwrap();
            assert!(fs::metadata(&archive).unwrap().len() > 1024 * 1024);
        } else if action == "stream" {
            slow_reader(&database);
        } else {
            let response =
                block_on(Request::new(&database).execute(query("SELECT value FROM broker_probe")))
                    .unwrap();
            assert!(response.windows(9).any(|bytes| bytes == b"roundtrip"));
        }
        block_on(database.close()).unwrap();
        serving.join().unwrap().unwrap();
    }
    assert!(retired.0.load(Ordering::Acquire));
}

fn slow_reader(database: &oliphaunt::AsyncOliphaunt) {
    use std::sync::atomic::AtomicUsize;
    let mut warmed_peak = None;
    for mib in [8, 32, 128] {
        let total = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(resident_kib()));
        let (received, measured) = (total.clone(), peak.clone());
        // Fixed-size rows separate transport growth from a growing PostgreSQL field.
        let sql = format!(
            "SELECT repeat('x', 1024) FROM generate_series(1, {})",
            mib * 1024
        );
        block_on(
            Request::new(database).stream(query(&sql), move |bytes: &[u8]| {
                let before = received.fetch_add(bytes.len(), Ordering::Relaxed);
                let after = before + bytes.len();
                if before / 65536 != after / 65536 {
                    std::thread::sleep(Duration::from_millis(1));
                    measured.fetch_max(resident_kib(), Ordering::Relaxed);
                }
            }),
        )
        .unwrap();
        assert!(total.load(Ordering::Relaxed) > mib * 1024 * 1024);
        let peak = peak.load(Ordering::Relaxed);
        println!("mobile broker slow reader: {mib} MiB, process peak sampled RSS {peak} KiB");
        // Both Rust endpoints and PostgreSQL share this test process. A full
        // 128 MiB response buffer would exceed this generous allocator allowance.
        let baseline = *warmed_peak.get_or_insert(peak);
        assert!(
            peak <= baseline + 32 * 1024,
            "streaming RSS grew with the response: {baseline} -> {peak} KiB"
        );
    }
}

fn resident_kib() -> usize {
    #[cfg(target_os = "linux")]
    {
        fs::read_to_string("/proc/self/status")
            .unwrap()
            .lines()
            .find_map(|line| {
                line.strip_prefix("VmRSS:")?
                    .split_whitespace()
                    .next()?
                    .parse()
                    .ok()
            })
            .expect("Linux reports process RSS")
    }
    #[cfg(not(target_os = "linux"))]
    {
        0
    } // Portable transport check; platform memory qualification uses device tools.
}
