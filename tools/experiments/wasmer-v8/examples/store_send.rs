// Compile this example separately: a V8-only Store must stay on its owner thread.
fn require_send<T: Send>() {}

fn main() {
    require_send::<wasmer::Store>();
}
