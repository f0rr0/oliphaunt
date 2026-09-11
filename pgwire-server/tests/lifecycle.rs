#![cfg(feature = "wasix")]
use anyhow::Result;
use oliphaunt_pgwire_server::{AsyncOliphauntServer, DatabaseStorage, OliphauntServer};
use oliphaunt_wasix::Oliphaunt;

#[test]
#[ignore = "requires prepared WASIX runtime"]
fn direct_server_close_releases_directory_ownership_before_returning() -> Result<()> {
    let workspace = tempfile::tempdir()?;
    let root = workspace.path().join("server-root");
    let mut server = OliphauntServer::builder()
        .storage(DatabaseStorage::Directory(root.clone()))
        .start()?;
    server.close()?;
    let mut database = Oliphaunt::builder()
        .storage(DatabaseStorage::Directory(root))
        .open()?;
    database.close()?;
    assert!(server.is_closed());
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires prepared WASIX runtime"]
async fn async_server_close_releases_directory_ownership_before_completion() -> Result<()> {
    let workspace = tempfile::tempdir()?;
    let root = workspace.path().join("async-server-root");
    let server = AsyncOliphauntServer::builder()
        .storage(DatabaseStorage::Directory(root.clone()))
        .start()
        .await?;
    server.close().await?;
    let mut database = Oliphaunt::builder()
        .storage(DatabaseStorage::Directory(root))
        .open()?;
    database.close()?;
    assert!(server.is_closed());
    Ok(())
}
