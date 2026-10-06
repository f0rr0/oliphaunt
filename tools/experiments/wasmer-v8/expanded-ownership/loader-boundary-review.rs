// ABI control for embed-dll.py's generated dispatcher, not a Windows DLL test.
use std::sync::OnceLock;

fn load() -> usize {
    panic!("injected engine preparation failure")
}

unsafe extern "C" fn c_dispatch() {
    static MODULE: OnceLock<usize> = OnceLock::new();
    let _ = MODULE.get_or_init(load);
}

unsafe fn rust_dispatch() {
    static MODULE: OnceLock<usize> = OnceLock::new();
    let _ = MODULE.get_or_init(load);
}

fn main() {
    let result = std::panic::catch_unwind(|| match std::env::args().nth(1).as_deref() {
        Some("c") => unsafe { c_dispatch() },
        Some("rust") => unsafe { rust_dispatch() },
        _ => panic!("choose c or rust ABI"),
    });
    assert!(result.is_err());
    println!("loader_boundary_review=caught");
}
