#![cfg(feature = "wasix")]
#[cfg(unix)]
use oliphaunt_pgwire_server::ServerListen;
use oliphaunt_pgwire_server::{
    AsyncOliphauntServer, DatabaseStorage, Error, ErrorKind, OliphauntServer, Result,
};
use std::path::PathBuf;
#[cfg(unix)]
fn non_utf8_unix_socket_directory() -> PathBuf {
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;

    let mut leaf = format!("oliphaunt-wasix-socket-{}-", std::process::id()).into_bytes();
    leaf.push(0xff);
    std::env::temp_dir().join(OsString::from_vec(leaf))
}

fn assert_invalid_startup_identity(error: Error, name: &str) {
    assert_invalid_configuration(error, &format!("{name} must not be empty"));
}

fn assert_invalid_configuration(error: Error, expected_message: &str) {
    assert_eq!(error.kind(), ErrorKind::InvalidConfiguration);
    assert_eq!(error.to_string(), expected_message);
}

fn expect_sdk_error<T>(result: Result<T>, message: &str) -> Error {
    match result {
        Ok(_) => panic!("{message}"),
        Err(error) => error,
    }
}

#[test]
fn direct_builders_reject_empty_startup_identities_before_runtime_work() {
    for value in ["", " \t\n"] {
        let error = expect_sdk_error(
            OliphauntServer::builder().username(value).start(),
            "empty server username must fail before runtime setup",
        );
        assert_invalid_startup_identity(error, "username");

        let error = expect_sdk_error(
            OliphauntServer::builder().database(value).start(),
            "empty server database must fail before runtime setup",
        );
        assert_invalid_startup_identity(error, "database");
    }
}

#[tokio::test]
async fn async_builders_preserve_startup_identity_validation() {
    let error = expect_sdk_error(
        AsyncOliphauntServer::builder().database("").start().await,
        "async server must preserve direct database validation",
    );
    assert_invalid_startup_identity(error, "database");
}

#[test]
fn sync_builders_reject_invalid_host_paths_before_filesystem_work() {
    for (path, reason) in [
        (PathBuf::new(), "must not be empty"),
        (PathBuf::from("invalid\0path"), "must not contain NUL bytes"),
    ] {
        let error = expect_sdk_error(
            OliphauntServer::builder()
                .storage(DatabaseStorage::Directory(path.clone()))
                .start(),
            "invalid server storage path must fail before runtime setup",
        );
        assert_invalid_configuration(error, &format!("database storage directory {reason}"));

        #[cfg(unix)]
        {
            let error = expect_sdk_error(
                OliphauntServer::builder()
                    .listen(ServerListen::unix(path))
                    .start(),
                "invalid Unix listener path must fail before runtime setup",
            );
            assert_invalid_configuration(error, &format!("Unix socket directory {reason}"));
        }
    }

    #[cfg(unix)]
    {
        let path = non_utf8_unix_socket_directory();
        assert!(!path.exists());
        let error = expect_sdk_error(
            OliphauntServer::builder()
                .listen(ServerListen::unix(path.clone()))
                .start(),
            "non-UTF-8 Unix listener path must fail before runtime setup",
        );
        assert_invalid_configuration(
            error,
            "Unix socket directory must be valid UTF-8 so the published PostgreSQL connection string preserves the exact path",
        );
        assert!(!path.exists());
    }
}

#[tokio::test]
async fn async_builders_preserve_host_path_validation() {
    for (path, reason) in [
        (PathBuf::new(), "must not be empty"),
        (PathBuf::from("invalid\0path"), "must not contain NUL bytes"),
    ] {
        let error = expect_sdk_error(
            AsyncOliphauntServer::builder()
                .storage(DatabaseStorage::Directory(path.clone()))
                .start()
                .await,
            "async server must preserve storage path validation",
        );
        assert_invalid_configuration(error, &format!("database storage directory {reason}"));

        #[cfg(unix)]
        {
            let error = expect_sdk_error(
                AsyncOliphauntServer::builder()
                    .listen(ServerListen::unix(path))
                    .start()
                    .await,
                "async server must preserve Unix listener path validation",
            );
            assert_invalid_configuration(error, &format!("Unix socket directory {reason}"));
        }
    }

    #[cfg(unix)]
    {
        let path = non_utf8_unix_socket_directory();
        assert!(!path.exists());
        let error = expect_sdk_error(
            AsyncOliphauntServer::builder()
                .listen(ServerListen::unix(path.clone()))
                .start()
                .await,
            "async non-UTF-8 Unix listener path must fail before runtime setup",
        );
        assert_invalid_configuration(
            error,
            "Unix socket directory must be valid UTF-8 so the published PostgreSQL connection string preserves the exact path",
        );
        assert!(!path.exists());
    }
}
