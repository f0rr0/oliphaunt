// Appended to an isolated copy of the actual loader by delivery-check.py.
#[cfg(test)]
mod faults {
    use super::*;
    use std::os::windows::fs::OpenOptionsExt;

    struct DenyWrites(PathBuf, String);
    impl DenyWrites {
        fn new(path: &Path) -> Self {
            let account = std::process::Command::new("whoami").output().unwrap();
            assert!(account.status.success());
            let account = String::from_utf8(account.stdout).unwrap().trim().to_owned();
            assert!(
                std::process::Command::new("icacls")
                    .arg(path)
                    .arg("/deny")
                    // Generic write denial also denies synchronization and
                    // therefore reads. Deny only actual mutation rights.
                    .arg(format!("{account}:(OI)(CI)(WD,AD,WEA,WA,DE,DC)"))
                    .status()
                    .unwrap()
                    .success()
            );
            Self(path.to_owned(), account)
        }
    }
    impl Drop for DenyWrites {
        fn drop(&mut self) {
            assert!(
                std::process::Command::new("icacls")
                    .arg(&self.0)
                    .arg("/remove:d")
                    .arg(&self.1)
                    .status()
                    .unwrap()
                    .success()
            );
        }
    }

    #[test]
    fn native_delivery_faults() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("oliphaunt_wee8.dll");
        for bytes in [
            None,
            Some(&DLL[..DLL.len() / 2]),
            Some(&b"wrong engine"[..]),
        ] {
            if let Some(bytes) = bytes {
                std::fs::write(&path, bytes).unwrap();
            }
            install(&path).unwrap();
            assert!(valid_payload(&path).unwrap());
        }
        let denied = DenyWrites::new(root.path());
        assert_eq!(std::fs::read(&path).unwrap(), DLL);
        install(&path).unwrap();
        drop(load(&path, REQUIRED_SYMBOLS).unwrap());
        let cold = root.path().join("missing.dll");
        assert!(install(&cold).is_err());
        drop(denied);
        std::fs::write(&path, b"damaged").unwrap();
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&path)
            .unwrap();
        let error = install(&path).unwrap_err();
        assert!(error.to_string().contains("replace internal engine cache"));
        assert_eq!(std::fs::read(&path).unwrap(), b"damaged");
        drop(lock);
        let handles: Vec<_> = (0..4)
            .map(|_| {
                let path = path.clone();
                std::thread::spawn(move || install(&path).unwrap())
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
        assert!(valid_payload(&path).unwrap());
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);

        let invalid = root.path().join("invalid.dll");
        std::fs::write(&invalid, b"not a PE image").unwrap();
        let error = load(&invalid, REQUIRED_SYMBOLS)
            .err()
            .expect("load must fail");
        assert!(error.to_string().contains("load internal engine"));
        assert!(std::error::Error::source(&error).is_some());
        let error = load(&path, &[b"missing_oliphaunt_entry\0"])
            .err()
            .expect("entry must fail");
        assert!(error.to_string().contains("missing_oliphaunt_entry"));
        // Failed export preparation must release its library before initialization.
        std::fs::remove_file(&path).unwrap();
        install(&path).unwrap();
        let prepared = load(&path, REQUIRED_SYMBOLS).unwrap();
        assert_eq!(prepared.symbols.len(), REQUIRED_SYMBOLS.len());
        drop(prepared);
        std::fs::remove_file(&path).unwrap();
        println!(
            "native_delivery_faults=PASS missing=repair truncated=repair wrong=repair warm_readonly=usable cold_readonly=error locked_bad=error concurrent_repair=valid load=error exports=error failed_library=unloaded retry=success temporaries=clean"
        );
    }

    fn locked_bad_cache() -> (PathBuf, std::fs::File) {
        let path = cache_path().unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"locked damaged engine").unwrap();
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&path)
            .unwrap();
        (path, lock)
    }

    fn assert_sdk_error(error: oliphaunt_wasix::Error, path: &Path) {
        assert_eq!(error.kind(), oliphaunt_wasix::ErrorKind::Other);
        assert!(
            error.to_string().contains("prepare Windows V8 engine"),
            "{error}"
        );
        assert!(
            error.to_string().contains(&path.display().to_string()),
            "{error}"
        );
        let mut source: &(dyn std::error::Error + 'static) = &error;
        let mut found_os_error = false;
        loop {
            if source
                .downcast_ref::<io::Error>()
                .is_some_and(|e| e.raw_os_error().is_some())
            {
                found_os_error = true;
            }
            let Some(next) = source.source() else {
                break;
            };
            source = next;
        }
        assert!(
            found_os_error,
            "original Windows error must remain in the source chain"
        );
    }

    #[test]
    fn blocking_open_failure_then_retry() {
        let (path, lock) = locked_bad_cache();
        let error = oliphaunt_wasix::Oliphaunt::builder()
            .open()
            .err()
            .expect("delivery error");
        assert_sdk_error(error, &path);
        drop(lock);
        let mut database = oliphaunt_wasix::Oliphaunt::builder().open().unwrap();
        assert_eq!(
            database
                .query("SELECT 42::text AS value")
                .unwrap()
                .get_text(0, "value")
                .unwrap(),
            Some("42")
        );
        database.close().unwrap();
        println!("blocking_loader_open=PASS failure=typed_error retry=query close=success");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn async_open_failure_then_retry() {
        let (path, lock) = locked_bad_cache();
        let error = oliphaunt_wasix::AsyncOliphaunt::builder()
            .open()
            .await
            .err()
            .expect("delivery error");
        assert_sdk_error(error, &path);
        drop(lock);
        let database = oliphaunt_wasix::AsyncOliphaunt::builder()
            .open()
            .await
            .unwrap();
        assert_eq!(
            database
                .query("SELECT 42::text AS value")
                .await
                .unwrap()
                .get_text(0, "value")
                .unwrap(),
            Some("42")
        );
        database.close().await.unwrap();
        println!("async_loader_open=PASS failure=typed_error retry=query close=success");
    }
}
