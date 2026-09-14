use std::sync::{Arc, Mutex, mpsc};
use std::thread;

use tokio::sync::oneshot;

use crate::{Error, ErrorKind, OliphauntServer, OliphauntServerBuilder, Result};

type Completion = Box<dyn FnOnce(Result<()>) + Send>;
enum State {
    Open,
    Closing(Vec<Completion>),
    Closed(Result<()>),
}
enum Control {
    Close,
}
struct OwnerStopped(Arc<Mutex<State>>);
impl Drop for OwnerStopped {
    fn drop(&mut self) {
        complete(&self.0, Err(stopped()));
    }
}
struct Owner {
    sender: mpsc::Sender<Control>,
    state: Arc<Mutex<State>>,
}
impl Drop for Owner {
    fn drop(&mut self) {
        let _ = self.sender.send(Control::Close);
    }
}

/// Cloneable, asynchronous owner of a sequential PostgreSQL socket server.
#[derive(Clone)]
pub struct AsyncOliphauntServer {
    owner: Arc<Owner>,
    connection_string: Arc<str>,
}

impl AsyncOliphauntServer {
    pub fn builder() -> AsyncOliphauntServerBuilder {
        AsyncOliphauntServerBuilder::new()
    }
    pub fn connection_string(&self) -> &str {
        &self.connection_string
    }
    pub fn is_closed(&self) -> bool {
        matches!(
            *self
                .owner
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
            State::Closed(_)
        )
    }
    /// Join the one terminal shutdown attempt. Dropping this future does not
    /// cancel accepted teardown; later calls observe the same result.
    pub async fn close(&self) -> Result<()> {
        let (reply, receiver) = oneshot::channel();
        self.close_with_completion(move |result| {
            let _ = reply.send(result);
        });
        receiver.await.map_err(|_| stopped())?
    }
    pub fn close_with_completion(&self, completion: impl FnOnce(Result<()>) + Send + 'static) {
        let mut completion: Option<Completion> = Some(Box::new(completion));
        let mut start = false;
        let settled = {
            let mut state = self
                .owner
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            match &mut *state {
                State::Open => {
                    *state = State::Closing(vec![completion.take().unwrap()]);
                    start = true;
                    None
                }
                State::Closing(waiters) => {
                    waiters.push(completion.take().unwrap());
                    None
                }
                State::Closed(result) => Some(result.clone()),
            }
        };
        if let Some(result) = settled {
            dispatch(completion.take().unwrap(), result);
        }
        if start && self.owner.sender.send(Control::Close).is_err() {
            complete(&self.owner.state, Err(stopped()));
        }
    }
}

fn stopped() -> Error {
    Error::classified(ErrorKind::Lifecycle, "WASIX server owner has stopped")
}
fn dispatch(completion: Completion, result: Result<()>) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| completion(result)));
}
fn complete(state: &Mutex<State>, result: Result<()>) {
    let waiters = {
        let mut state = state.lock().unwrap_or_else(|error| error.into_inner());
        if matches!(*state, State::Closed(_)) {
            return;
        }
        match std::mem::replace(&mut *state, State::Closed(result.clone())) {
            State::Closing(waiters) => waiters,
            _ => Vec::new(),
        }
    };
    for waiter in waiters {
        dispatch(waiter, result.clone());
    }
}

/// Builder for the asynchronous socket owner.
#[derive(Debug, Clone, Default)]
pub struct AsyncOliphauntServerBuilder {
    inner: OliphauntServerBuilder,
}
impl AsyncOliphauntServerBuilder {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn storage(mut self, storage: crate::DatabaseStorage) -> Self {
        self.inner = self.inner.storage(storage);
        self
    }
    pub fn seed(mut self, seed: oliphaunt_wasix::ClusterSeed) -> Self {
        self.inner = self.inner.seed(seed);
        self
    }

    /// Select independently packaged ICU data and its catalog profile.
    pub fn icu_data(mut self, data: oliphaunt_wasix::IcuData) -> Self {
        self.inner = self.inner.icu_data(data);
        self
    }
    pub fn catalog_profile(mut self, profile: oliphaunt_wasix::session::CatalogProfile) -> Self {
        self.inner = self.inner.catalog_profile(profile);
        self
    }
    pub fn listen(mut self, listen: crate::ServerListen) -> Self {
        self.inner = self.inner.listen(listen);
        self
    }
    pub fn username(mut self, user: impl Into<String>) -> Self {
        self.inner = self.inner.username(user);
        self
    }
    pub fn database(mut self, database: impl Into<String>) -> Self {
        self.inner = self.inner.database(database);
        self
    }
    pub fn startup_guc(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.inner = self.inner.startup_guc(name, value);
        self
    }
    pub fn startup_gucs<K: Into<String>, V: Into<String>>(
        mut self,
        settings: impl IntoIterator<Item = (K, V)>,
    ) -> Self {
        self.inner = self.inner.startup_gucs(settings);
        self
    }
    #[cfg(feature = "extensions")]
    pub fn extension(mut self, extension: oliphaunt_wasix::Extension) -> Self {
        self.inner = self.inner.extension(extension);
        self
    }
    #[cfg(feature = "extensions")]
    pub fn extensions(
        mut self,
        extensions: impl IntoIterator<Item = oliphaunt_wasix::Extension>,
    ) -> Self {
        self.inner = self.inner.extensions(extensions);
        self
    }
    pub async fn start(self) -> Result<AsyncOliphauntServer> {
        let (reply, receiver) = oneshot::channel();
        self.start_with_completion(move |result| {
            let _ = reply.send(result);
        });
        receiver.await.map_err(|_| stopped())?
    }
    pub fn start_with_completion(
        self,
        completion: impl FnOnce(Result<AsyncOliphauntServer>) + Send + 'static,
    ) {
        let completion = Arc::new(Mutex::new(Some(completion)));
        let callback = completion.clone();
        let spawned = thread::Builder::new()
            .name("oliphaunt-pgwire-owner".into())
            .spawn(move || {
                let result =
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.inner.start()))
                        .unwrap_or_else(|_| {
                            Err(Error::classified(
                                ErrorKind::Lifecycle,
                                "WASIX server startup panicked",
                            ))
                        });
                let callback = callback
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .take()
                    .unwrap();
                let mut server: OliphauntServer = match result {
                    Ok(server) => server,
                    Err(error) => {
                        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            callback(Err(error))
                        }));
                        return;
                    }
                };
                let (sender, receiver) = mpsc::channel();
                let state = Arc::new(Mutex::new(State::Open));
                let _stopped = OwnerStopped(state.clone());
                let handle = AsyncOliphauntServer {
                    owner: Arc::new(Owner {
                        sender,
                        state: state.clone(),
                    }),
                    connection_string: Arc::from(server.connection_string()),
                };
                // A cancelled start future drops this handle and queues shutdown.
                let _ =
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| callback(Ok(handle))));
                let _ = receiver.recv();
                let result = server.owner_close();
                drop(server);
                complete(&state, result);
            });
        if let Err(error) = spawned
            && let Some(callback) = completion
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take()
        {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                callback(Err(Error::from_anyhow(anyhow::anyhow!(
                    "spawn WASIX server owner: {error}"
                ))))
            }));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::Future;
    use std::task::{Context, Poll, Waker};

    fn pending_server() -> (AsyncOliphauntServer, mpsc::Receiver<Control>) {
        let (sender, receiver) = mpsc::channel();
        let server = AsyncOliphauntServer {
            owner: Arc::new(Owner {
                sender,
                state: Arc::new(Mutex::new(State::Open)),
            }),
            connection_string: Arc::from("postgres://localhost/test"),
        };
        (server, receiver)
    }

    #[tokio::test]
    async fn cancelled_waiter_and_clones_join_one_shutdown_and_replay_failure() {
        let (server, receiver) = pending_server();
        let mut first = Box::pin(server.close());
        let mut context = Context::from_waker(Waker::noop());
        assert!(matches!(first.as_mut().poll(&mut context), Poll::Pending));
        receiver.try_recv().expect("accepted close queued");
        drop(first);
        let clone = server.clone();
        let mut second = Box::pin(clone.close());
        assert!(matches!(second.as_mut().poll(&mut context), Poll::Pending));
        assert!(
            receiver.try_recv().is_err(),
            "must not queue a second teardown"
        );
        let failure = Error::classified(ErrorKind::Lifecycle, "worker did not stop");
        complete(&server.owner.state, Err(failure));
        assert_eq!(second.await.unwrap_err().to_string(), "worker did not stop");
        assert!(server.is_closed());
        assert_eq!(
            server.close().await.unwrap_err().to_string(),
            "worker did not stop"
        );
        // Worker-drop notification cannot overwrite the actual terminal error.
        drop(OwnerStopped(server.owner.state.clone()));
        assert_eq!(
            server.close().await.unwrap_err().to_string(),
            "worker did not stop"
        );
    }

    #[test]
    fn panicking_and_reentrant_callbacks_do_not_block_other_waiters() {
        let (server, _receiver) = pending_server();
        server.close_with_completion(|_| panic!("caller panic"));
        let clone = server.clone();
        let (reply, received) = mpsc::channel();
        server.close_with_completion(move |result| {
            result.unwrap();
            assert!(clone.is_closed());
            clone.close_with_completion(move |result| {
                reply.send(result).unwrap();
            });
        });
        complete(&server.owner.state, Ok(()));
        received
            .recv_timeout(std::time::Duration::from_secs(1))
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn stopped_owner_settles_accepted_waiters() {
        let (server, receiver) = pending_server();
        let mut close = Box::pin(server.close());
        assert!(matches!(
            close.as_mut().poll(&mut Context::from_waker(Waker::noop())),
            Poll::Pending
        ));
        receiver.try_recv().unwrap();
        drop(OwnerStopped(server.owner.state.clone()));
        assert_eq!(close.await.unwrap_err().kind(), ErrorKind::Lifecycle);
        assert!(server.is_closed());
    }
}
