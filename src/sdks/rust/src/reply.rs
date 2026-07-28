use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};

pub(crate) fn channel<T>() -> (Sender<T>, Receiver<T>) {
    let state = Arc::new(Mutex::new(State {
        value: None,
        waker: None,
    }));
    (
        Sender {
            state: Arc::clone(&state),
        },
        Receiver { state },
    )
}

pub(crate) struct Sender<T> {
    state: Arc<Mutex<State<T>>>,
}

impl<T> Sender<T> {
    pub(crate) fn send(self, value: T) {
        let waker = {
            let mut state = self.state.lock().expect("reply mutex poisoned");
            state.value = Some(value);
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
    type Output = T;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let mut state = self.state.lock().expect("reply mutex poisoned");
        if let Some(value) = state.value.take() {
            Poll::Ready(value)
        } else {
            state.waker = Some(cx.waker().clone());
            Poll::Pending
        }
    }
}

struct State<T> {
    value: Option<T>,
    waker: Option<Waker>,
}
