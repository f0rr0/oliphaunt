use std::error::Error;
use std::future::Future;
use std::io;
use std::path::PathBuf;
use std::task::{Context, Poll, Waker};
use std::thread;
use std::time::Duration;

use oliphaunt::Oliphaunt;

fn main() -> Result<(), Box<dyn Error>> {
    let root = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::other("usage: oliphaunt-rust-release-consumer DATABASE_ROOT"))?;
    let database = block_on(Oliphaunt::builder().path(root).native_server().open())?;
    let result = block_on(database.query("SELECT 42::text AS value"))?;
    let value = result
        .get_text(0, "value")?
        .ok_or_else(|| io::Error::other("release consumer query returned SQL NULL"))?;
    if value != "42" {
        return Err(io::Error::other(format!(
            "release consumer query returned {value:?}, expected \"42\""
        ))
        .into());
    }
    block_on(database.close())?;
    println!("OLIPHAUNT_RUST_RELEASE_CONSUMER_PASS checks=open,query,close");
    Ok(())
}

fn block_on<F: Future>(future: F) -> F::Output {
    let mut context = Context::from_waker(Waker::noop());
    let mut future = Box::pin(future);
    loop {
        match future.as_mut().poll(&mut context) {
            Poll::Ready(value) => return value,
            Poll::Pending => thread::park_timeout(Duration::from_millis(1)),
        }
    }
}
