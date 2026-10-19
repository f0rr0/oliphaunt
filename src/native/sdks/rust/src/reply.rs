use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};

use crate::error::{Error, Result};

/// One-shot completion channel whose receiver cannot be stranded when its
/// sender disappears. This is deliberately specialized to SDK `Result`s: an
/// owner-thread exit always has the same observable `EngineStopped` outcome.
pub(crate) fn channel<T>() -> (Sender<T>, Receiver<T>) {
    let state = Arc::new(Mutex::new(State {
        value: None,
        receiver_alive: true,
        waker: None,
    }));
    (
        Sender {
            state: Arc::clone(&state),
            completed: false,
        },
        Receiver { state },
    )
}

pub(crate) struct Sender<T> {
    state: Arc<Mutex<State<T>>>,
    completed: bool,
}

impl<T> Sender<T> {
    /// Complete the receiver. Returns `false` when the awaiting operation was
    /// already abandoned, allowing owner-side control commands to compensate.
    pub(crate) fn send(mut self, value: Result<T>) -> bool {
        let (receiver_alive, waker) = {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            let receiver_alive = state.receiver_alive;
            if receiver_alive {
                state.value = Some(value);
            }
            self.completed = true;
            (receiver_alive, state.waker.take())
        };
        if let Some(waker) = waker {
            waker.wake();
        }
        receiver_alive
    }

    pub(crate) fn is_abandoned(&self) -> bool {
        !self
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .receiver_alive
    }
}

impl<T> Drop for Sender<T> {
    fn drop(&mut self) {
        if self.completed {
            return;
        }
        let waker = {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            if !state.receiver_alive || state.value.is_some() {
                return;
            }
            state.value = Some(Err(Error::EngineStopped));
            state.waker.take()
        };
        if let Some(waker) = waker {
            waker.wake();
        }
    }
}

pub(crate) struct Receiver<T> {
    state: Arc<Mutex<State<T>>>,
}

impl<T> Future for Receiver<T> {
    type Output = Result<T>;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(value) = state.value.take() {
            Poll::Ready(value)
        } else {
            state.waker = Some(cx.waker().clone());
            Poll::Pending
        }
    }
}

impl<T> Drop for Receiver<T> {
    fn drop(&mut self) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.receiver_alive = false;
        state.waker = None;
    }
}

struct State<T> {
    value: Option<Result<T>>,
    receiver_alive: bool,
    waker: Option<Waker>,
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::sync::Arc;
    use std::task::{Context, Poll, Wake, Waker};

    use super::*;

    #[test]
    fn dropping_sender_wakes_receiver_with_engine_stopped() {
        let (sender, mut receiver) = channel::<()>();
        let wake = Arc::new(WakeCounter(std::sync::atomic::AtomicUsize::new(0)));
        let waker = Waker::from(Arc::clone(&wake));
        let mut context = Context::from_waker(&waker);

        assert!(matches!(
            Pin::new(&mut receiver).poll(&mut context),
            Poll::Pending
        ));
        drop(sender);
        assert_eq!(wake.0.load(std::sync::atomic::Ordering::SeqCst), 1);
        let Poll::Ready(Err(error)) = Pin::new(&mut receiver).poll(&mut context) else {
            panic!("dropping the sender must stop the pending receiver");
        };
        assert_eq!(error.kind(), crate::error::ErrorKind::Lifecycle);
        assert_eq!(error.to_string(), "native database session has stopped");
    }

    #[test]
    fn sender_observes_abandoned_receiver() {
        let (sender, receiver) = channel::<()>();
        drop(receiver);
        assert!(sender.is_abandoned());
        assert!(!sender.send(Ok(())));
    }

    struct WakeCounter(std::sync::atomic::AtomicUsize);

    impl Wake for WakeCounter {
        fn wake(self: Arc<Self>) {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }

        fn wake_by_ref(self: &Arc<Self>) {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }
}
