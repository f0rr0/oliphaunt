//! Execute a relinked Windows engine directly, without compiling the Cargo SDK.
use std::{ffi::c_void, os::windows::ffi::OsStrExt, ptr};

type Object = *mut c_void;

#[link(name = "kernel32")]
unsafe extern "system" {
    fn LoadLibraryExW(path: *const u16, file: Object, flags: u32) -> Object;
    fn GetProcAddress(module: Object, name: *const u8) -> Object;
}

#[repr(C)]
struct CVector<T> {
    size: usize,
    data: *mut T,
}

// The pinned wasm.h includes v128. Its value is 24 bytes, not the older 16.
#[repr(C)]
#[allow(dead_code)]
union Payload {
    i32: i32,
    i64: i64,
    f32: f32,
    f64: f64,
    v128: [u8; 16],
    reference: Object,
}

#[repr(C)]
struct Value {
    kind: u8,
    payload: Payload,
}

const _: () = {
    assert!(size_of::<Value>() == 24);
    assert!(align_of::<Value>() == 8);
    assert!(std::mem::offset_of!(Value, payload) == 8);
};

struct Owned(Object, unsafe extern "C" fn(Object));
impl Owned {
    fn new(pointer: Object, delete: unsafe extern "C" fn(Object), name: &str) -> Self {
        assert!(!pointer.is_null(), "{name} creation failed");
        Self(pointer, delete)
    }
}
impl Drop for Owned {
    fn drop(&mut self) {
        unsafe { (self.1)(self.0) };
    }
}

fn symbol(library: Object, name: &[u8]) -> Object {
    let pointer = unsafe { GetProcAddress(library, name.as_ptr()) };
    assert!(
        !pointer.is_null(),
        "missing {}: {}",
        String::from_utf8_lossy(&name[..name.len() - 1]),
        std::io::Error::last_os_error()
    );
    pointer
}

fn main() {
    let arguments: Vec<_> = std::env::args_os().skip(1).collect();
    assert_eq!(arguments.len(), 1, "usage: relink-loader DLL");
    let dll = std::fs::canonicalize(&arguments[0]).expect("locate relinked DLL");
    let wide: Vec<_> = dll.as_os_str().encode_wide().chain(Some(0)).collect();
    let library = unsafe { LoadLibraryExW(wide.as_ptr(), ptr::null_mut(), 0x100 | 0x800) };
    assert!(
        !library.is_null(),
        "load '{}': {}",
        dll.display(),
        std::io::Error::last_os_error()
    );
    // Match production: initialized V8 stays loaded for the process lifetime.
    macro_rules! load {
        ($name:ident($($argument:ty),*) $(-> $result:ty)?) => {
            let $name: unsafe extern "C" fn($($argument),*) $(-> $result)? = std::mem::transmute(symbol(
                library,
                concat!("wee8_", stringify!($name), "\0").as_bytes(),
            ));
        };
    }
    unsafe {
        load!(wasm_engine_new() -> Object);
        load!(wasm_engine_delete(Object));
        load!(wasm_store_new(Object) -> Object);
        load!(wasm_store_delete(Object));
        load!(wasm_module_new(Object, *const CVector<u8>) -> Object);
        load!(wasm_module_delete(Object));
        load!(wasm_instance_new(Object, Object, *const CVector<Object>, *mut Object) -> Object);
        load!(wasm_instance_delete(Object));
        load!(wasm_instance_exports(Object, *mut CVector<Object>));
        load!(wasm_extern_as_func(Object) -> Object);
        load!(wasm_extern_vec_delete(*mut CVector<Object>));
        load!(wasm_val_vec_new_uninitialized(*mut CVector<Value>, usize));
        load!(wasm_val_vec_delete(*mut CVector<Value>));
        load!(wasm_func_call(Object, *const CVector<Value>, *mut CVector<Value>) -> Object);
        load!(wasm_trap_delete(Object));

        // (module (func (export "answer") (param i32) (result i32)
        //   local.get 0 i32.const 1 i32.add))
        const WASM: &[u8] = &[
            0, 97, 115, 109, 1, 0, 0, 0, 1, 6, 1, 96, 1, 127, 1, 127, 3, 2, 1, 0, 7, 10, 1, 6, 97,
            110, 115, 119, 101, 114, 0, 0, 10, 9, 1, 7, 0, 32, 0, 65, 1, 106, 11,
        ];
        let engine = Owned::new(wasm_engine_new(), wasm_engine_delete, "engine");
        let store = Owned::new(wasm_store_new(engine.0), wasm_store_delete, "store");
        let binary = CVector {
            size: WASM.len(),
            data: WASM.as_ptr().cast_mut(),
        };
        let module = Owned::new(
            wasm_module_new(store.0, &binary),
            wasm_module_delete,
            "module",
        );
        let imports = CVector {
            size: 0,
            data: ptr::null_mut(),
        };
        let mut trap = ptr::null_mut();
        let instance = wasm_instance_new(store.0, module.0, &imports, &mut trap);
        if !trap.is_null() {
            wasm_trap_delete(trap);
        }
        assert!(trap.is_null(), "instantiation trapped");
        let instance = Owned::new(instance, wasm_instance_delete, "instance");
        let mut exports = CVector {
            size: 0,
            data: ptr::null_mut(),
        };
        wasm_instance_exports(instance.0, &mut exports);
        assert_eq!(exports.size, 1, "expected one function export");
        assert!(!exports.data.is_null(), "missing exported function");
        let function = wasm_extern_as_func(*exports.data);
        assert!(!function.is_null(), "answer is not a function");
        let mut argument = Value {
            kind: 0,
            payload: Payload { i32: 41 },
        };
        let arguments = CVector {
            size: 1,
            data: &mut argument,
        };
        let mut results = CVector {
            size: 0,
            data: ptr::null_mut(),
        };
        wasm_val_vec_new_uninitialized(&mut results, 1);
        let mut correct = true;
        // Reuse borrowed stack arguments to exercise the ownership bridge too.
        for _ in 0..2 {
            let trap = wasm_func_call(function, &arguments, &mut results);
            if !trap.is_null() {
                wasm_trap_delete(trap);
                correct = false;
                break;
            }
            correct &= results.size == 1
                && !results.data.is_null()
                && (*results.data).kind == 0
                && (*results.data).payload.i32 == 42;
        }
        wasm_val_vec_delete(&mut results);
        wasm_extern_vec_delete(&mut exports);
        assert!(
            correct,
            "relinked engine did not return i32 42 on both calls"
        );
    }
    println!("relinked Windows engine executed answer(41) = 42 twice");
}
