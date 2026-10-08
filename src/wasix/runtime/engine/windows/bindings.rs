// Generated from Wasmer 7.5.0 third-party/wee8/wasm.h for Windows x64.
// Only the WebAssembly C ABI is retained; regenerate when the pinned header changes.
pub type byte_t = ::std::os::raw::c_char;
pub type float32_t = f32;
pub type float64_t = f64;
pub type wasm_byte_t = byte_t;
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct wasm_byte_vec_t {
    pub size: usize,
    pub data: *mut wasm_byte_t,
}
#[allow(clippy::unnecessary_operation, clippy::identity_op)]
const _: () = {
    ["Size of wasm_byte_vec_t"][::std::mem::size_of::<wasm_byte_vec_t>() - 16usize];
    ["Alignment of wasm_byte_vec_t"][::std::mem::align_of::<wasm_byte_vec_t>() - 8usize];
    ["Offset of field: wasm_byte_vec_t::size"]
        [::std::mem::offset_of!(wasm_byte_vec_t, size) - 0usize];
    ["Offset of field: wasm_byte_vec_t::data"]
        [::std::mem::offset_of!(wasm_byte_vec_t, data) - 8usize];
};
impl Default for wasm_byte_vec_t {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_byte_vec_new_empty"]
    pub fn wasm_byte_vec_new_empty(out: *mut wasm_byte_vec_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_byte_vec_new_uninitialized"]
    pub fn wasm_byte_vec_new_uninitialized(out: *mut wasm_byte_vec_t, arg1: usize);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_byte_vec_new"]
    pub fn wasm_byte_vec_new(out: *mut wasm_byte_vec_t, arg1: usize, arg2: *const wasm_byte_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_byte_vec_copy"]
    pub fn wasm_byte_vec_copy(out: *mut wasm_byte_vec_t, arg1: *const wasm_byte_vec_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_byte_vec_delete"]
    pub fn wasm_byte_vec_delete(arg1: *mut wasm_byte_vec_t);
}
pub type wasm_name_t = wasm_byte_vec_t;
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct wasm_config_t {
    _unused: [u8; 0],
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_config_delete"]
    pub fn wasm_config_delete(arg1: *mut wasm_config_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_config_new"]
    pub fn wasm_config_new() -> *mut wasm_config_t;
}
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct wasm_engine_t {
    _unused: [u8; 0],
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_engine_delete"]
    pub fn wasm_engine_delete(arg1: *mut wasm_engine_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_engine_new"]
    pub fn wasm_engine_new() -> *mut wasm_engine_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_engine_new_with_config"]
    pub fn wasm_engine_new_with_config(arg1: *mut wasm_config_t) -> *mut wasm_engine_t;
}
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct wasm_store_t {
    _unused: [u8; 0],
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_store_delete"]
    pub fn wasm_store_delete(arg1: *mut wasm_store_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_store_new"]
    pub fn wasm_store_new(arg1: *mut wasm_engine_t) -> *mut wasm_store_t;
}
pub type wasm_mutability_t = u8;
pub const wasm_mutability_enum_WASM_CONST: wasm_mutability_enum = 0;
pub const wasm_mutability_enum_WASM_VAR: wasm_mutability_enum = 1;
pub type wasm_mutability_enum = ::std::os::raw::c_int;
#[repr(C)]
#[derive(Debug, Default, Copy, Clone)]
pub struct wasm_limits_t {
    pub min: u32,
    pub max: u32,
    pub shared: bool,
}
#[allow(clippy::unnecessary_operation, clippy::identity_op)]
const _: () = {
    ["Size of wasm_limits_t"][::std::mem::size_of::<wasm_limits_t>() - 12usize];
    ["Alignment of wasm_limits_t"][::std::mem::align_of::<wasm_limits_t>() - 4usize];
    ["Offset of field: wasm_limits_t::min"][::std::mem::offset_of!(wasm_limits_t, min) - 0usize];
    ["Offset of field: wasm_limits_t::max"][::std::mem::offset_of!(wasm_limits_t, max) - 4usize];
    ["Offset of field: wasm_limits_t::shared"]
        [::std::mem::offset_of!(wasm_limits_t, shared) - 8usize];
};
pub const wasm_limits_max_default: u32 = 4294967295;
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct wasm_valtype_t {
    _unused: [u8; 0],
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_valtype_delete"]
    pub fn wasm_valtype_delete(arg1: *mut wasm_valtype_t);
}
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct wasm_valtype_vec_t {
    pub size: usize,
    pub data: *mut *mut wasm_valtype_t,
}
#[allow(clippy::unnecessary_operation, clippy::identity_op)]
const _: () = {
    ["Size of wasm_valtype_vec_t"][::std::mem::size_of::<wasm_valtype_vec_t>() - 16usize];
    ["Alignment of wasm_valtype_vec_t"][::std::mem::align_of::<wasm_valtype_vec_t>() - 8usize];
    ["Offset of field: wasm_valtype_vec_t::size"]
        [::std::mem::offset_of!(wasm_valtype_vec_t, size) - 0usize];
    ["Offset of field: wasm_valtype_vec_t::data"]
        [::std::mem::offset_of!(wasm_valtype_vec_t, data) - 8usize];
};
impl Default for wasm_valtype_vec_t {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_valtype_vec_new_empty"]
    pub fn wasm_valtype_vec_new_empty(out: *mut wasm_valtype_vec_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_valtype_vec_new_uninitialized"]
    pub fn wasm_valtype_vec_new_uninitialized(out: *mut wasm_valtype_vec_t, arg1: usize);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_valtype_vec_new"]
    pub fn wasm_valtype_vec_new(
        out: *mut wasm_valtype_vec_t,
        arg1: usize,
        arg2: *const *mut wasm_valtype_t,
    );
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_valtype_vec_copy"]
    pub fn wasm_valtype_vec_copy(out: *mut wasm_valtype_vec_t, arg1: *const wasm_valtype_vec_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_valtype_vec_delete"]
    pub fn wasm_valtype_vec_delete(arg1: *mut wasm_valtype_vec_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_valtype_copy"]
    pub fn wasm_valtype_copy(arg1: *const wasm_valtype_t) -> *mut wasm_valtype_t;
}
pub type wasm_valkind_t = u8;
pub const wasm_valkind_enum_WASM_I32: wasm_valkind_enum = 0;
pub const wasm_valkind_enum_WASM_I64: wasm_valkind_enum = 1;
pub const wasm_valkind_enum_WASM_F32: wasm_valkind_enum = 2;
pub const wasm_valkind_enum_WASM_F64: wasm_valkind_enum = 3;
pub const wasm_valkind_enum_WASM_V128: wasm_valkind_enum = 4;
pub const wasm_valkind_enum_WASM_EXTERNREF: wasm_valkind_enum = 128;
pub const wasm_valkind_enum_WASM_FUNCREF: wasm_valkind_enum = 129;
pub type wasm_valkind_enum = ::std::os::raw::c_int;
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_valtype_new"]
    pub fn wasm_valtype_new(arg1: wasm_valkind_t) -> *mut wasm_valtype_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_valtype_kind"]
    pub fn wasm_valtype_kind(arg1: *const wasm_valtype_t) -> wasm_valkind_t;
}
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct wasm_functype_t {
    _unused: [u8; 0],
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_functype_delete"]
    pub fn wasm_functype_delete(arg1: *mut wasm_functype_t);
}
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct wasm_functype_vec_t {
    pub size: usize,
    pub data: *mut *mut wasm_functype_t,
}
#[allow(clippy::unnecessary_operation, clippy::identity_op)]
const _: () = {
    ["Size of wasm_functype_vec_t"][::std::mem::size_of::<wasm_functype_vec_t>() - 16usize];
    ["Alignment of wasm_functype_vec_t"][::std::mem::align_of::<wasm_functype_vec_t>() - 8usize];
    ["Offset of field: wasm_functype_vec_t::size"]
        [::std::mem::offset_of!(wasm_functype_vec_t, size) - 0usize];
    ["Offset of field: wasm_functype_vec_t::data"]
        [::std::mem::offset_of!(wasm_functype_vec_t, data) - 8usize];
};
impl Default for wasm_functype_vec_t {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_functype_vec_new_empty"]
    pub fn wasm_functype_vec_new_empty(out: *mut wasm_functype_vec_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_functype_vec_new_uninitialized"]
    pub fn wasm_functype_vec_new_uninitialized(out: *mut wasm_functype_vec_t, arg1: usize);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_functype_vec_new"]
    pub fn wasm_functype_vec_new(
        out: *mut wasm_functype_vec_t,
        arg1: usize,
        arg2: *const *mut wasm_functype_t,
    );
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_functype_vec_copy"]
    pub fn wasm_functype_vec_copy(out: *mut wasm_functype_vec_t, arg1: *const wasm_functype_vec_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_functype_vec_delete"]
    pub fn wasm_functype_vec_delete(arg1: *mut wasm_functype_vec_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_functype_copy"]
    pub fn wasm_functype_copy(arg1: *const wasm_functype_t) -> *mut wasm_functype_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_functype_new"]
    pub fn wasm_functype_new(
        params: *mut wasm_valtype_vec_t,
        results: *mut wasm_valtype_vec_t,
    ) -> *mut wasm_functype_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_functype_params"]
    pub fn wasm_functype_params(arg1: *const wasm_functype_t) -> *const wasm_valtype_vec_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_functype_results"]
    pub fn wasm_functype_results(arg1: *const wasm_functype_t) -> *const wasm_valtype_vec_t;
}
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct wasm_globaltype_t {
    _unused: [u8; 0],
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_globaltype_delete"]
    pub fn wasm_globaltype_delete(arg1: *mut wasm_globaltype_t);
}
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct wasm_globaltype_vec_t {
    pub size: usize,
    pub data: *mut *mut wasm_globaltype_t,
}
#[allow(clippy::unnecessary_operation, clippy::identity_op)]
const _: () = {
    ["Size of wasm_globaltype_vec_t"][::std::mem::size_of::<wasm_globaltype_vec_t>() - 16usize];
    ["Alignment of wasm_globaltype_vec_t"]
        [::std::mem::align_of::<wasm_globaltype_vec_t>() - 8usize];
    ["Offset of field: wasm_globaltype_vec_t::size"]
        [::std::mem::offset_of!(wasm_globaltype_vec_t, size) - 0usize];
    ["Offset of field: wasm_globaltype_vec_t::data"]
        [::std::mem::offset_of!(wasm_globaltype_vec_t, data) - 8usize];
};
impl Default for wasm_globaltype_vec_t {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_globaltype_vec_new_empty"]
    pub fn wasm_globaltype_vec_new_empty(out: *mut wasm_globaltype_vec_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_globaltype_vec_new_uninitialized"]
    pub fn wasm_globaltype_vec_new_uninitialized(out: *mut wasm_globaltype_vec_t, arg1: usize);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_globaltype_vec_new"]
    pub fn wasm_globaltype_vec_new(
        out: *mut wasm_globaltype_vec_t,
        arg1: usize,
        arg2: *const *mut wasm_globaltype_t,
    );
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_globaltype_vec_copy"]
    pub fn wasm_globaltype_vec_copy(
        out: *mut wasm_globaltype_vec_t,
        arg1: *const wasm_globaltype_vec_t,
    );
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_globaltype_vec_delete"]
    pub fn wasm_globaltype_vec_delete(arg1: *mut wasm_globaltype_vec_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_globaltype_copy"]
    pub fn wasm_globaltype_copy(arg1: *const wasm_globaltype_t) -> *mut wasm_globaltype_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_globaltype_new"]
    pub fn wasm_globaltype_new(
        arg1: *mut wasm_valtype_t,
        arg2: wasm_mutability_t,
    ) -> *mut wasm_globaltype_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_globaltype_content"]
    pub fn wasm_globaltype_content(arg1: *const wasm_globaltype_t) -> *const wasm_valtype_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_globaltype_mutability"]
    pub fn wasm_globaltype_mutability(arg1: *const wasm_globaltype_t) -> wasm_mutability_t;
}
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct wasm_tagtype_t {
    _unused: [u8; 0],
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_tagtype_delete"]
    pub fn wasm_tagtype_delete(arg1: *mut wasm_tagtype_t);
}
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct wasm_tagtype_vec_t {
    pub size: usize,
    pub data: *mut *mut wasm_tagtype_t,
}
#[allow(clippy::unnecessary_operation, clippy::identity_op)]
const _: () = {
    ["Size of wasm_tagtype_vec_t"][::std::mem::size_of::<wasm_tagtype_vec_t>() - 16usize];
    ["Alignment of wasm_tagtype_vec_t"][::std::mem::align_of::<wasm_tagtype_vec_t>() - 8usize];
    ["Offset of field: wasm_tagtype_vec_t::size"]
        [::std::mem::offset_of!(wasm_tagtype_vec_t, size) - 0usize];
    ["Offset of field: wasm_tagtype_vec_t::data"]
        [::std::mem::offset_of!(wasm_tagtype_vec_t, data) - 8usize];
};
impl Default for wasm_tagtype_vec_t {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_tagtype_vec_new_empty"]
    pub fn wasm_tagtype_vec_new_empty(out: *mut wasm_tagtype_vec_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_tagtype_vec_new_uninitialized"]
    pub fn wasm_tagtype_vec_new_uninitialized(out: *mut wasm_tagtype_vec_t, arg1: usize);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_tagtype_vec_new"]
    pub fn wasm_tagtype_vec_new(
        out: *mut wasm_tagtype_vec_t,
        arg1: usize,
        arg2: *const *mut wasm_tagtype_t,
    );
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_tagtype_vec_copy"]
    pub fn wasm_tagtype_vec_copy(out: *mut wasm_tagtype_vec_t, arg1: *const wasm_tagtype_vec_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_tagtype_vec_delete"]
    pub fn wasm_tagtype_vec_delete(arg1: *mut wasm_tagtype_vec_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_tagtype_copy"]
    pub fn wasm_tagtype_copy(arg1: *const wasm_tagtype_t) -> *mut wasm_tagtype_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_tagtype_new"]
    pub fn wasm_tagtype_new(params: *mut wasm_valtype_vec_t) -> *mut wasm_tagtype_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_tagtype_params"]
    pub fn wasm_tagtype_params(arg1: *const wasm_tagtype_t) -> *const wasm_valtype_vec_t;
}
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct wasm_tabletype_t {
    _unused: [u8; 0],
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_tabletype_delete"]
    pub fn wasm_tabletype_delete(arg1: *mut wasm_tabletype_t);
}
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct wasm_tabletype_vec_t {
    pub size: usize,
    pub data: *mut *mut wasm_tabletype_t,
}
#[allow(clippy::unnecessary_operation, clippy::identity_op)]
const _: () = {
    ["Size of wasm_tabletype_vec_t"][::std::mem::size_of::<wasm_tabletype_vec_t>() - 16usize];
    ["Alignment of wasm_tabletype_vec_t"][::std::mem::align_of::<wasm_tabletype_vec_t>() - 8usize];
    ["Offset of field: wasm_tabletype_vec_t::size"]
        [::std::mem::offset_of!(wasm_tabletype_vec_t, size) - 0usize];
    ["Offset of field: wasm_tabletype_vec_t::data"]
        [::std::mem::offset_of!(wasm_tabletype_vec_t, data) - 8usize];
};
impl Default for wasm_tabletype_vec_t {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_tabletype_vec_new_empty"]
    pub fn wasm_tabletype_vec_new_empty(out: *mut wasm_tabletype_vec_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_tabletype_vec_new_uninitialized"]
    pub fn wasm_tabletype_vec_new_uninitialized(out: *mut wasm_tabletype_vec_t, arg1: usize);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_tabletype_vec_new"]
    pub fn wasm_tabletype_vec_new(
        out: *mut wasm_tabletype_vec_t,
        arg1: usize,
        arg2: *const *mut wasm_tabletype_t,
    );
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_tabletype_vec_copy"]
    pub fn wasm_tabletype_vec_copy(
        out: *mut wasm_tabletype_vec_t,
        arg1: *const wasm_tabletype_vec_t,
    );
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_tabletype_vec_delete"]
    pub fn wasm_tabletype_vec_delete(arg1: *mut wasm_tabletype_vec_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_tabletype_copy"]
    pub fn wasm_tabletype_copy(arg1: *const wasm_tabletype_t) -> *mut wasm_tabletype_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_tabletype_new"]
    pub fn wasm_tabletype_new(
        arg1: *mut wasm_valtype_t,
        arg2: *const wasm_limits_t,
    ) -> *mut wasm_tabletype_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_tabletype_element"]
    pub fn wasm_tabletype_element(arg1: *const wasm_tabletype_t) -> *const wasm_valtype_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_tabletype_limits"]
    pub fn wasm_tabletype_limits(arg1: *const wasm_tabletype_t) -> *const wasm_limits_t;
}
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct wasm_memorytype_t {
    _unused: [u8; 0],
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_memorytype_delete"]
    pub fn wasm_memorytype_delete(arg1: *mut wasm_memorytype_t);
}
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct wasm_memorytype_vec_t {
    pub size: usize,
    pub data: *mut *mut wasm_memorytype_t,
}
#[allow(clippy::unnecessary_operation, clippy::identity_op)]
const _: () = {
    ["Size of wasm_memorytype_vec_t"][::std::mem::size_of::<wasm_memorytype_vec_t>() - 16usize];
    ["Alignment of wasm_memorytype_vec_t"]
        [::std::mem::align_of::<wasm_memorytype_vec_t>() - 8usize];
    ["Offset of field: wasm_memorytype_vec_t::size"]
        [::std::mem::offset_of!(wasm_memorytype_vec_t, size) - 0usize];
    ["Offset of field: wasm_memorytype_vec_t::data"]
        [::std::mem::offset_of!(wasm_memorytype_vec_t, data) - 8usize];
};
impl Default for wasm_memorytype_vec_t {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_memorytype_vec_new_empty"]
    pub fn wasm_memorytype_vec_new_empty(out: *mut wasm_memorytype_vec_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_memorytype_vec_new_uninitialized"]
    pub fn wasm_memorytype_vec_new_uninitialized(out: *mut wasm_memorytype_vec_t, arg1: usize);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_memorytype_vec_new"]
    pub fn wasm_memorytype_vec_new(
        out: *mut wasm_memorytype_vec_t,
        arg1: usize,
        arg2: *const *mut wasm_memorytype_t,
    );
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_memorytype_vec_copy"]
    pub fn wasm_memorytype_vec_copy(
        out: *mut wasm_memorytype_vec_t,
        arg1: *const wasm_memorytype_vec_t,
    );
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_memorytype_vec_delete"]
    pub fn wasm_memorytype_vec_delete(arg1: *mut wasm_memorytype_vec_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_memorytype_copy"]
    pub fn wasm_memorytype_copy(arg1: *const wasm_memorytype_t) -> *mut wasm_memorytype_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_memorytype_new"]
    pub fn wasm_memorytype_new(arg1: *const wasm_limits_t) -> *mut wasm_memorytype_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_memorytype_limits"]
    pub fn wasm_memorytype_limits(arg1: *const wasm_memorytype_t) -> *const wasm_limits_t;
}
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct wasm_externtype_t {
    _unused: [u8; 0],
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_externtype_delete"]
    pub fn wasm_externtype_delete(arg1: *mut wasm_externtype_t);
}
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct wasm_externtype_vec_t {
    pub size: usize,
    pub data: *mut *mut wasm_externtype_t,
}
#[allow(clippy::unnecessary_operation, clippy::identity_op)]
const _: () = {
    ["Size of wasm_externtype_vec_t"][::std::mem::size_of::<wasm_externtype_vec_t>() - 16usize];
    ["Alignment of wasm_externtype_vec_t"]
        [::std::mem::align_of::<wasm_externtype_vec_t>() - 8usize];
    ["Offset of field: wasm_externtype_vec_t::size"]
        [::std::mem::offset_of!(wasm_externtype_vec_t, size) - 0usize];
    ["Offset of field: wasm_externtype_vec_t::data"]
        [::std::mem::offset_of!(wasm_externtype_vec_t, data) - 8usize];
};
impl Default for wasm_externtype_vec_t {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_externtype_vec_new_empty"]
    pub fn wasm_externtype_vec_new_empty(out: *mut wasm_externtype_vec_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_externtype_vec_new_uninitialized"]
    pub fn wasm_externtype_vec_new_uninitialized(out: *mut wasm_externtype_vec_t, arg1: usize);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_externtype_vec_new"]
    pub fn wasm_externtype_vec_new(
        out: *mut wasm_externtype_vec_t,
        arg1: usize,
        arg2: *const *mut wasm_externtype_t,
    );
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_externtype_vec_copy"]
    pub fn wasm_externtype_vec_copy(
        out: *mut wasm_externtype_vec_t,
        arg1: *const wasm_externtype_vec_t,
    );
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_externtype_vec_delete"]
    pub fn wasm_externtype_vec_delete(arg1: *mut wasm_externtype_vec_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_externtype_copy"]
    pub fn wasm_externtype_copy(arg1: *const wasm_externtype_t) -> *mut wasm_externtype_t;
}
pub type wasm_externkind_t = u8;
pub const wasm_externkind_enum_WASM_EXTERN_FUNC: wasm_externkind_enum = 0;
pub const wasm_externkind_enum_WASM_EXTERN_GLOBAL: wasm_externkind_enum = 1;
pub const wasm_externkind_enum_WASM_EXTERN_TABLE: wasm_externkind_enum = 2;
pub const wasm_externkind_enum_WASM_EXTERN_MEMORY: wasm_externkind_enum = 3;
pub const wasm_externkind_enum_WASM_EXTERN_TAG: wasm_externkind_enum = 4;
pub type wasm_externkind_enum = ::std::os::raw::c_int;
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_externtype_kind"]
    pub fn wasm_externtype_kind(arg1: *const wasm_externtype_t) -> wasm_externkind_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_functype_as_externtype"]
    pub fn wasm_functype_as_externtype(arg1: *mut wasm_functype_t) -> *mut wasm_externtype_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_globaltype_as_externtype"]
    pub fn wasm_globaltype_as_externtype(arg1: *mut wasm_globaltype_t) -> *mut wasm_externtype_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_tagtype_as_externtype"]
    pub fn wasm_tagtype_as_externtype(arg1: *mut wasm_tagtype_t) -> *mut wasm_externtype_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_tabletype_as_externtype"]
    pub fn wasm_tabletype_as_externtype(arg1: *mut wasm_tabletype_t) -> *mut wasm_externtype_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_memorytype_as_externtype"]
    pub fn wasm_memorytype_as_externtype(arg1: *mut wasm_memorytype_t) -> *mut wasm_externtype_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_externtype_as_functype"]
    pub fn wasm_externtype_as_functype(arg1: *mut wasm_externtype_t) -> *mut wasm_functype_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_externtype_as_globaltype"]
    pub fn wasm_externtype_as_globaltype(arg1: *mut wasm_externtype_t) -> *mut wasm_globaltype_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_externtype_as_tagtype"]
    pub fn wasm_externtype_as_tagtype(arg1: *mut wasm_externtype_t) -> *mut wasm_tagtype_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_externtype_as_tabletype"]
    pub fn wasm_externtype_as_tabletype(arg1: *mut wasm_externtype_t) -> *mut wasm_tabletype_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_externtype_as_memorytype"]
    pub fn wasm_externtype_as_memorytype(arg1: *mut wasm_externtype_t) -> *mut wasm_memorytype_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_functype_as_externtype_const"]
    pub fn wasm_functype_as_externtype_const(
        arg1: *const wasm_functype_t,
    ) -> *const wasm_externtype_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_globaltype_as_externtype_const"]
    pub fn wasm_globaltype_as_externtype_const(
        arg1: *const wasm_globaltype_t,
    ) -> *const wasm_externtype_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_tagtype_as_externtype_const"]
    pub fn wasm_tagtype_as_externtype_const(
        arg1: *const wasm_tagtype_t,
    ) -> *const wasm_externtype_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_tabletype_as_externtype_const"]
    pub fn wasm_tabletype_as_externtype_const(
        arg1: *const wasm_tabletype_t,
    ) -> *const wasm_externtype_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_memorytype_as_externtype_const"]
    pub fn wasm_memorytype_as_externtype_const(
        arg1: *const wasm_memorytype_t,
    ) -> *const wasm_externtype_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_externtype_as_functype_const"]
    pub fn wasm_externtype_as_functype_const(
        arg1: *const wasm_externtype_t,
    ) -> *const wasm_functype_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_externtype_as_globaltype_const"]
    pub fn wasm_externtype_as_globaltype_const(
        arg1: *const wasm_externtype_t,
    ) -> *const wasm_globaltype_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_externtype_as_tagtype_const"]
    pub fn wasm_externtype_as_tagtype_const(
        arg1: *const wasm_externtype_t,
    ) -> *const wasm_tagtype_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_externtype_as_tabletype_const"]
    pub fn wasm_externtype_as_tabletype_const(
        arg1: *const wasm_externtype_t,
    ) -> *const wasm_tabletype_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_externtype_as_memorytype_const"]
    pub fn wasm_externtype_as_memorytype_const(
        arg1: *const wasm_externtype_t,
    ) -> *const wasm_memorytype_t;
}
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct wasm_importtype_t {
    _unused: [u8; 0],
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_importtype_delete"]
    pub fn wasm_importtype_delete(arg1: *mut wasm_importtype_t);
}
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct wasm_importtype_vec_t {
    pub size: usize,
    pub data: *mut *mut wasm_importtype_t,
}
#[allow(clippy::unnecessary_operation, clippy::identity_op)]
const _: () = {
    ["Size of wasm_importtype_vec_t"][::std::mem::size_of::<wasm_importtype_vec_t>() - 16usize];
    ["Alignment of wasm_importtype_vec_t"]
        [::std::mem::align_of::<wasm_importtype_vec_t>() - 8usize];
    ["Offset of field: wasm_importtype_vec_t::size"]
        [::std::mem::offset_of!(wasm_importtype_vec_t, size) - 0usize];
    ["Offset of field: wasm_importtype_vec_t::data"]
        [::std::mem::offset_of!(wasm_importtype_vec_t, data) - 8usize];
};
impl Default for wasm_importtype_vec_t {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_importtype_vec_new_empty"]
    pub fn wasm_importtype_vec_new_empty(out: *mut wasm_importtype_vec_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_importtype_vec_new_uninitialized"]
    pub fn wasm_importtype_vec_new_uninitialized(out: *mut wasm_importtype_vec_t, arg1: usize);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_importtype_vec_new"]
    pub fn wasm_importtype_vec_new(
        out: *mut wasm_importtype_vec_t,
        arg1: usize,
        arg2: *const *mut wasm_importtype_t,
    );
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_importtype_vec_copy"]
    pub fn wasm_importtype_vec_copy(
        out: *mut wasm_importtype_vec_t,
        arg1: *const wasm_importtype_vec_t,
    );
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_importtype_vec_delete"]
    pub fn wasm_importtype_vec_delete(arg1: *mut wasm_importtype_vec_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_importtype_copy"]
    pub fn wasm_importtype_copy(arg1: *const wasm_importtype_t) -> *mut wasm_importtype_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_importtype_new"]
    pub fn wasm_importtype_new(
        module: *mut wasm_name_t,
        name: *mut wasm_name_t,
        arg1: *mut wasm_externtype_t,
    ) -> *mut wasm_importtype_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_importtype_module"]
    pub fn wasm_importtype_module(arg1: *const wasm_importtype_t) -> *const wasm_name_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_importtype_name"]
    pub fn wasm_importtype_name(arg1: *const wasm_importtype_t) -> *const wasm_name_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_importtype_type"]
    pub fn wasm_importtype_type(arg1: *const wasm_importtype_t) -> *const wasm_externtype_t;
}
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct wasm_exporttype_t {
    _unused: [u8; 0],
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_exporttype_delete"]
    pub fn wasm_exporttype_delete(arg1: *mut wasm_exporttype_t);
}
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct wasm_exporttype_vec_t {
    pub size: usize,
    pub data: *mut *mut wasm_exporttype_t,
}
#[allow(clippy::unnecessary_operation, clippy::identity_op)]
const _: () = {
    ["Size of wasm_exporttype_vec_t"][::std::mem::size_of::<wasm_exporttype_vec_t>() - 16usize];
    ["Alignment of wasm_exporttype_vec_t"]
        [::std::mem::align_of::<wasm_exporttype_vec_t>() - 8usize];
    ["Offset of field: wasm_exporttype_vec_t::size"]
        [::std::mem::offset_of!(wasm_exporttype_vec_t, size) - 0usize];
    ["Offset of field: wasm_exporttype_vec_t::data"]
        [::std::mem::offset_of!(wasm_exporttype_vec_t, data) - 8usize];
};
impl Default for wasm_exporttype_vec_t {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_exporttype_vec_new_empty"]
    pub fn wasm_exporttype_vec_new_empty(out: *mut wasm_exporttype_vec_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_exporttype_vec_new_uninitialized"]
    pub fn wasm_exporttype_vec_new_uninitialized(out: *mut wasm_exporttype_vec_t, arg1: usize);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_exporttype_vec_new"]
    pub fn wasm_exporttype_vec_new(
        out: *mut wasm_exporttype_vec_t,
        arg1: usize,
        arg2: *const *mut wasm_exporttype_t,
    );
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_exporttype_vec_copy"]
    pub fn wasm_exporttype_vec_copy(
        out: *mut wasm_exporttype_vec_t,
        arg1: *const wasm_exporttype_vec_t,
    );
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_exporttype_vec_delete"]
    pub fn wasm_exporttype_vec_delete(arg1: *mut wasm_exporttype_vec_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_exporttype_copy"]
    pub fn wasm_exporttype_copy(arg1: *const wasm_exporttype_t) -> *mut wasm_exporttype_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_exporttype_new"]
    pub fn wasm_exporttype_new(
        arg1: *mut wasm_name_t,
        arg2: *mut wasm_externtype_t,
    ) -> *mut wasm_exporttype_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_exporttype_name"]
    pub fn wasm_exporttype_name(arg1: *const wasm_exporttype_t) -> *const wasm_name_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_exporttype_type"]
    pub fn wasm_exporttype_type(arg1: *const wasm_exporttype_t) -> *const wasm_externtype_t;
}
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct wasm_ref_t {
    _unused: [u8; 0],
}
#[repr(C)]
#[derive(Debug, Default, Copy, Clone)]
pub struct wasm_v128_t {
    pub bytes: [u8; 16usize],
}
#[allow(clippy::unnecessary_operation, clippy::identity_op)]
const _: () = {
    ["Size of wasm_v128_t"][::std::mem::size_of::<wasm_v128_t>() - 16usize];
    ["Alignment of wasm_v128_t"][::std::mem::align_of::<wasm_v128_t>() - 1usize];
    ["Offset of field: wasm_v128_t::bytes"][::std::mem::offset_of!(wasm_v128_t, bytes) - 0usize];
};
#[repr(C)]
#[derive(Copy, Clone)]
pub struct wasm_val_t {
    pub kind: wasm_valkind_t,
    pub of: wasm_val_t__bindgen_ty_1,
}
#[repr(C)]
#[derive(Copy, Clone)]
pub union wasm_val_t__bindgen_ty_1 {
    pub i32_: i32,
    pub i64_: i64,
    pub f32_: float32_t,
    pub f64_: float64_t,
    pub v128: wasm_v128_t,
    pub ref_: *mut wasm_ref_t,
}
#[allow(clippy::unnecessary_operation, clippy::identity_op)]
const _: () = {
    ["Size of wasm_val_t__bindgen_ty_1"]
        [::std::mem::size_of::<wasm_val_t__bindgen_ty_1>() - 16usize];
    ["Alignment of wasm_val_t__bindgen_ty_1"]
        [::std::mem::align_of::<wasm_val_t__bindgen_ty_1>() - 8usize];
    ["Offset of field: wasm_val_t__bindgen_ty_1::i32_"]
        [::std::mem::offset_of!(wasm_val_t__bindgen_ty_1, i32_) - 0usize];
    ["Offset of field: wasm_val_t__bindgen_ty_1::i64_"]
        [::std::mem::offset_of!(wasm_val_t__bindgen_ty_1, i64_) - 0usize];
    ["Offset of field: wasm_val_t__bindgen_ty_1::f32_"]
        [::std::mem::offset_of!(wasm_val_t__bindgen_ty_1, f32_) - 0usize];
    ["Offset of field: wasm_val_t__bindgen_ty_1::f64_"]
        [::std::mem::offset_of!(wasm_val_t__bindgen_ty_1, f64_) - 0usize];
    ["Offset of field: wasm_val_t__bindgen_ty_1::v128"]
        [::std::mem::offset_of!(wasm_val_t__bindgen_ty_1, v128) - 0usize];
    ["Offset of field: wasm_val_t__bindgen_ty_1::ref_"]
        [::std::mem::offset_of!(wasm_val_t__bindgen_ty_1, ref_) - 0usize];
};
impl Default for wasm_val_t__bindgen_ty_1 {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
#[allow(clippy::unnecessary_operation, clippy::identity_op)]
const _: () = {
    ["Size of wasm_val_t"][::std::mem::size_of::<wasm_val_t>() - 24usize];
    ["Alignment of wasm_val_t"][::std::mem::align_of::<wasm_val_t>() - 8usize];
    ["Offset of field: wasm_val_t::kind"][::std::mem::offset_of!(wasm_val_t, kind) - 0usize];
    ["Offset of field: wasm_val_t::of"][::std::mem::offset_of!(wasm_val_t, of) - 8usize];
};
impl Default for wasm_val_t {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_val_delete"]
    pub fn wasm_val_delete(v: *mut wasm_val_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_val_copy"]
    pub fn wasm_val_copy(out: *mut wasm_val_t, arg1: *const wasm_val_t);
}
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct wasm_val_vec_t {
    pub size: usize,
    pub data: *mut wasm_val_t,
}
#[allow(clippy::unnecessary_operation, clippy::identity_op)]
const _: () = {
    ["Size of wasm_val_vec_t"][::std::mem::size_of::<wasm_val_vec_t>() - 16usize];
    ["Alignment of wasm_val_vec_t"][::std::mem::align_of::<wasm_val_vec_t>() - 8usize];
    ["Offset of field: wasm_val_vec_t::size"]
        [::std::mem::offset_of!(wasm_val_vec_t, size) - 0usize];
    ["Offset of field: wasm_val_vec_t::data"]
        [::std::mem::offset_of!(wasm_val_vec_t, data) - 8usize];
};
impl Default for wasm_val_vec_t {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_val_vec_new_empty"]
    pub fn wasm_val_vec_new_empty(out: *mut wasm_val_vec_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_val_vec_new_uninitialized"]
    pub fn wasm_val_vec_new_uninitialized(out: *mut wasm_val_vec_t, arg1: usize);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_val_vec_new"]
    pub fn wasm_val_vec_new(out: *mut wasm_val_vec_t, arg1: usize, arg2: *const wasm_val_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_val_vec_copy"]
    pub fn wasm_val_vec_copy(out: *mut wasm_val_vec_t, arg1: *const wasm_val_vec_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_val_vec_delete"]
    pub fn wasm_val_vec_delete(arg1: *mut wasm_val_vec_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_ref_delete"]
    pub fn wasm_ref_delete(arg1: *mut wasm_ref_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_ref_copy"]
    pub fn wasm_ref_copy(arg1: *const wasm_ref_t) -> *mut wasm_ref_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_ref_same"]
    pub fn wasm_ref_same(arg1: *const wasm_ref_t, arg2: *const wasm_ref_t) -> bool;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_ref_get_host_info"]
    pub fn wasm_ref_get_host_info(arg1: *const wasm_ref_t) -> *mut ::std::os::raw::c_void;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_ref_set_host_info"]
    pub fn wasm_ref_set_host_info(arg1: *mut wasm_ref_t, arg2: *mut ::std::os::raw::c_void);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_ref_set_host_info_with_finalizer"]
    pub fn wasm_ref_set_host_info_with_finalizer(
        arg1: *mut wasm_ref_t,
        arg2: *mut ::std::os::raw::c_void,
        arg3: ::std::option::Option<unsafe extern "C" fn(arg1: *mut ::std::os::raw::c_void)>,
    );
}
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct wasm_frame_t {
    _unused: [u8; 0],
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_frame_delete"]
    pub fn wasm_frame_delete(arg1: *mut wasm_frame_t);
}
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct wasm_frame_vec_t {
    pub size: usize,
    pub data: *mut *mut wasm_frame_t,
}
#[allow(clippy::unnecessary_operation, clippy::identity_op)]
const _: () = {
    ["Size of wasm_frame_vec_t"][::std::mem::size_of::<wasm_frame_vec_t>() - 16usize];
    ["Alignment of wasm_frame_vec_t"][::std::mem::align_of::<wasm_frame_vec_t>() - 8usize];
    ["Offset of field: wasm_frame_vec_t::size"]
        [::std::mem::offset_of!(wasm_frame_vec_t, size) - 0usize];
    ["Offset of field: wasm_frame_vec_t::data"]
        [::std::mem::offset_of!(wasm_frame_vec_t, data) - 8usize];
};
impl Default for wasm_frame_vec_t {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_frame_vec_new_empty"]
    pub fn wasm_frame_vec_new_empty(out: *mut wasm_frame_vec_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_frame_vec_new_uninitialized"]
    pub fn wasm_frame_vec_new_uninitialized(out: *mut wasm_frame_vec_t, arg1: usize);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_frame_vec_new"]
    pub fn wasm_frame_vec_new(
        out: *mut wasm_frame_vec_t,
        arg1: usize,
        arg2: *const *mut wasm_frame_t,
    );
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_frame_vec_copy"]
    pub fn wasm_frame_vec_copy(out: *mut wasm_frame_vec_t, arg1: *const wasm_frame_vec_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_frame_vec_delete"]
    pub fn wasm_frame_vec_delete(arg1: *mut wasm_frame_vec_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_frame_copy"]
    pub fn wasm_frame_copy(arg1: *const wasm_frame_t) -> *mut wasm_frame_t;
}
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct wasm_instance_t {
    _unused: [u8; 0],
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_frame_instance"]
    pub fn wasm_frame_instance(arg1: *const wasm_frame_t) -> *mut wasm_instance_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_frame_func_index"]
    pub fn wasm_frame_func_index(arg1: *const wasm_frame_t) -> u32;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_frame_func_offset"]
    pub fn wasm_frame_func_offset(arg1: *const wasm_frame_t) -> usize;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_frame_module_offset"]
    pub fn wasm_frame_module_offset(arg1: *const wasm_frame_t) -> usize;
}
pub type wasm_message_t = wasm_name_t;
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct wasm_trap_t {
    _unused: [u8; 0],
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_trap_delete"]
    pub fn wasm_trap_delete(arg1: *mut wasm_trap_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_trap_copy"]
    pub fn wasm_trap_copy(arg1: *const wasm_trap_t) -> *mut wasm_trap_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_trap_same"]
    pub fn wasm_trap_same(arg1: *const wasm_trap_t, arg2: *const wasm_trap_t) -> bool;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_trap_get_host_info"]
    pub fn wasm_trap_get_host_info(arg1: *const wasm_trap_t) -> *mut ::std::os::raw::c_void;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_trap_set_host_info"]
    pub fn wasm_trap_set_host_info(arg1: *mut wasm_trap_t, arg2: *mut ::std::os::raw::c_void);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_trap_set_host_info_with_finalizer"]
    pub fn wasm_trap_set_host_info_with_finalizer(
        arg1: *mut wasm_trap_t,
        arg2: *mut ::std::os::raw::c_void,
        arg3: ::std::option::Option<unsafe extern "C" fn(arg1: *mut ::std::os::raw::c_void)>,
    );
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_trap_as_ref"]
    pub fn wasm_trap_as_ref(arg1: *mut wasm_trap_t) -> *mut wasm_ref_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_ref_as_trap"]
    pub fn wasm_ref_as_trap(arg1: *mut wasm_ref_t) -> *mut wasm_trap_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_trap_as_ref_const"]
    pub fn wasm_trap_as_ref_const(arg1: *const wasm_trap_t) -> *const wasm_ref_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_ref_as_trap_const"]
    pub fn wasm_ref_as_trap_const(arg1: *const wasm_ref_t) -> *const wasm_trap_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_trap_new"]
    pub fn wasm_trap_new(store: *mut wasm_store_t, arg1: *const wasm_message_t)
    -> *mut wasm_trap_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_trap_message"]
    pub fn wasm_trap_message(arg1: *const wasm_trap_t, out: *mut wasm_message_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_trap_origin"]
    pub fn wasm_trap_origin(arg1: *const wasm_trap_t) -> *mut wasm_frame_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_trap_trace"]
    pub fn wasm_trap_trace(arg1: *const wasm_trap_t, out: *mut wasm_frame_vec_t);
}
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct wasm_foreign_t {
    _unused: [u8; 0],
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_foreign_delete"]
    pub fn wasm_foreign_delete(arg1: *mut wasm_foreign_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_foreign_copy"]
    pub fn wasm_foreign_copy(arg1: *const wasm_foreign_t) -> *mut wasm_foreign_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_foreign_same"]
    pub fn wasm_foreign_same(arg1: *const wasm_foreign_t, arg2: *const wasm_foreign_t) -> bool;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_foreign_get_host_info"]
    pub fn wasm_foreign_get_host_info(arg1: *const wasm_foreign_t) -> *mut ::std::os::raw::c_void;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_foreign_set_host_info"]
    pub fn wasm_foreign_set_host_info(arg1: *mut wasm_foreign_t, arg2: *mut ::std::os::raw::c_void);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_foreign_set_host_info_with_finalizer"]
    pub fn wasm_foreign_set_host_info_with_finalizer(
        arg1: *mut wasm_foreign_t,
        arg2: *mut ::std::os::raw::c_void,
        arg3: ::std::option::Option<unsafe extern "C" fn(arg1: *mut ::std::os::raw::c_void)>,
    );
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_foreign_as_ref"]
    pub fn wasm_foreign_as_ref(arg1: *mut wasm_foreign_t) -> *mut wasm_ref_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_ref_as_foreign"]
    pub fn wasm_ref_as_foreign(arg1: *mut wasm_ref_t) -> *mut wasm_foreign_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_foreign_as_ref_const"]
    pub fn wasm_foreign_as_ref_const(arg1: *const wasm_foreign_t) -> *const wasm_ref_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_ref_as_foreign_const"]
    pub fn wasm_ref_as_foreign_const(arg1: *const wasm_ref_t) -> *const wasm_foreign_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_foreign_new"]
    pub fn wasm_foreign_new(arg1: *mut wasm_store_t) -> *mut wasm_foreign_t;
}
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct wasm_module_t {
    _unused: [u8; 0],
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_module_delete"]
    pub fn wasm_module_delete(arg1: *mut wasm_module_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_module_copy"]
    pub fn wasm_module_copy(arg1: *const wasm_module_t) -> *mut wasm_module_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_module_same"]
    pub fn wasm_module_same(arg1: *const wasm_module_t, arg2: *const wasm_module_t) -> bool;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_module_get_host_info"]
    pub fn wasm_module_get_host_info(arg1: *const wasm_module_t) -> *mut ::std::os::raw::c_void;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_module_set_host_info"]
    pub fn wasm_module_set_host_info(arg1: *mut wasm_module_t, arg2: *mut ::std::os::raw::c_void);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_module_set_host_info_with_finalizer"]
    pub fn wasm_module_set_host_info_with_finalizer(
        arg1: *mut wasm_module_t,
        arg2: *mut ::std::os::raw::c_void,
        arg3: ::std::option::Option<unsafe extern "C" fn(arg1: *mut ::std::os::raw::c_void)>,
    );
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_module_as_ref"]
    pub fn wasm_module_as_ref(arg1: *mut wasm_module_t) -> *mut wasm_ref_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_ref_as_module"]
    pub fn wasm_ref_as_module(arg1: *mut wasm_ref_t) -> *mut wasm_module_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_module_as_ref_const"]
    pub fn wasm_module_as_ref_const(arg1: *const wasm_module_t) -> *const wasm_ref_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_ref_as_module_const"]
    pub fn wasm_ref_as_module_const(arg1: *const wasm_ref_t) -> *const wasm_module_t;
}
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct wasm_shared_module_t {
    _unused: [u8; 0],
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_shared_module_delete"]
    pub fn wasm_shared_module_delete(arg1: *mut wasm_shared_module_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_module_share"]
    pub fn wasm_module_share(arg1: *const wasm_module_t) -> *mut wasm_shared_module_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_module_obtain"]
    pub fn wasm_module_obtain(
        arg1: *mut wasm_store_t,
        arg2: *const wasm_shared_module_t,
    ) -> *mut wasm_module_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_module_new"]
    pub fn wasm_module_new(
        arg1: *mut wasm_store_t,
        binary: *const wasm_byte_vec_t,
    ) -> *mut wasm_module_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_module_validate"]
    pub fn wasm_module_validate(arg1: *mut wasm_store_t, binary: *const wasm_byte_vec_t) -> bool;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_module_imports"]
    pub fn wasm_module_imports(arg1: *const wasm_module_t, out: *mut wasm_importtype_vec_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_module_exports"]
    pub fn wasm_module_exports(arg1: *const wasm_module_t, out: *mut wasm_exporttype_vec_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_module_serialize"]
    pub fn wasm_module_serialize(arg1: *const wasm_module_t, out: *mut wasm_byte_vec_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_module_deserialize"]
    pub fn wasm_module_deserialize(
        arg1: *mut wasm_store_t,
        arg2: *const wasm_byte_vec_t,
    ) -> *mut wasm_module_t;
}
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct wasm_func_t {
    _unused: [u8; 0],
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_func_delete"]
    pub fn wasm_func_delete(arg1: *mut wasm_func_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_func_copy"]
    pub fn wasm_func_copy(arg1: *const wasm_func_t) -> *mut wasm_func_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_func_same"]
    pub fn wasm_func_same(arg1: *const wasm_func_t, arg2: *const wasm_func_t) -> bool;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_func_get_host_info"]
    pub fn wasm_func_get_host_info(arg1: *const wasm_func_t) -> *mut ::std::os::raw::c_void;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_func_set_host_info"]
    pub fn wasm_func_set_host_info(arg1: *mut wasm_func_t, arg2: *mut ::std::os::raw::c_void);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_func_set_host_info_with_finalizer"]
    pub fn wasm_func_set_host_info_with_finalizer(
        arg1: *mut wasm_func_t,
        arg2: *mut ::std::os::raw::c_void,
        arg3: ::std::option::Option<unsafe extern "C" fn(arg1: *mut ::std::os::raw::c_void)>,
    );
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_func_as_ref"]
    pub fn wasm_func_as_ref(arg1: *mut wasm_func_t) -> *mut wasm_ref_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_ref_as_func"]
    pub fn wasm_ref_as_func(arg1: *mut wasm_ref_t) -> *mut wasm_func_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_func_as_ref_const"]
    pub fn wasm_func_as_ref_const(arg1: *const wasm_func_t) -> *const wasm_ref_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_ref_as_func_const"]
    pub fn wasm_ref_as_func_const(arg1: *const wasm_ref_t) -> *const wasm_func_t;
}
pub type wasm_func_callback_t = ::std::option::Option<
    unsafe extern "C" fn(
        args: *const wasm_val_vec_t,
        results: *mut wasm_val_vec_t,
    ) -> *mut wasm_trap_t,
>;
pub type wasm_func_callback_with_env_t = ::std::option::Option<
    unsafe extern "C" fn(
        env: *mut ::std::os::raw::c_void,
        args: *const wasm_val_vec_t,
        results: *mut wasm_val_vec_t,
    ) -> *mut wasm_trap_t,
>;
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_func_new"]
    pub fn wasm_func_new(
        arg1: *mut wasm_store_t,
        arg2: *const wasm_functype_t,
        arg3: wasm_func_callback_t,
    ) -> *mut wasm_func_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_func_new_with_env"]
    pub fn wasm_func_new_with_env(
        arg1: *mut wasm_store_t,
        type_: *const wasm_functype_t,
        arg2: wasm_func_callback_with_env_t,
        env: *mut ::std::os::raw::c_void,
        finalizer: ::std::option::Option<unsafe extern "C" fn(arg1: *mut ::std::os::raw::c_void)>,
    ) -> *mut wasm_func_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_func_type"]
    pub fn wasm_func_type(arg1: *const wasm_func_t) -> *mut wasm_functype_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_func_param_arity"]
    pub fn wasm_func_param_arity(arg1: *const wasm_func_t) -> usize;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_func_result_arity"]
    pub fn wasm_func_result_arity(arg1: *const wasm_func_t) -> usize;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_func_call"]
    pub fn wasm_func_call(
        arg1: *const wasm_func_t,
        args: *const wasm_val_vec_t,
        results: *mut wasm_val_vec_t,
    ) -> *mut wasm_trap_t;
}
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct wasm_global_t {
    _unused: [u8; 0],
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_global_delete"]
    pub fn wasm_global_delete(arg1: *mut wasm_global_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_global_copy"]
    pub fn wasm_global_copy(arg1: *const wasm_global_t) -> *mut wasm_global_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_global_same"]
    pub fn wasm_global_same(arg1: *const wasm_global_t, arg2: *const wasm_global_t) -> bool;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_global_get_host_info"]
    pub fn wasm_global_get_host_info(arg1: *const wasm_global_t) -> *mut ::std::os::raw::c_void;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_global_set_host_info"]
    pub fn wasm_global_set_host_info(arg1: *mut wasm_global_t, arg2: *mut ::std::os::raw::c_void);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_global_set_host_info_with_finalizer"]
    pub fn wasm_global_set_host_info_with_finalizer(
        arg1: *mut wasm_global_t,
        arg2: *mut ::std::os::raw::c_void,
        arg3: ::std::option::Option<unsafe extern "C" fn(arg1: *mut ::std::os::raw::c_void)>,
    );
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_global_as_ref"]
    pub fn wasm_global_as_ref(arg1: *mut wasm_global_t) -> *mut wasm_ref_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_ref_as_global"]
    pub fn wasm_ref_as_global(arg1: *mut wasm_ref_t) -> *mut wasm_global_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_global_as_ref_const"]
    pub fn wasm_global_as_ref_const(arg1: *const wasm_global_t) -> *const wasm_ref_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_ref_as_global_const"]
    pub fn wasm_ref_as_global_const(arg1: *const wasm_ref_t) -> *const wasm_global_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_global_new"]
    pub fn wasm_global_new(
        arg1: *mut wasm_store_t,
        arg2: *const wasm_globaltype_t,
        arg3: *const wasm_val_t,
    ) -> *mut wasm_global_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_global_type"]
    pub fn wasm_global_type(arg1: *const wasm_global_t) -> *mut wasm_globaltype_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_global_get"]
    pub fn wasm_global_get(arg1: *const wasm_global_t, out: *mut wasm_val_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_global_set"]
    pub fn wasm_global_set(arg1: *mut wasm_global_t, arg2: *const wasm_val_t);
}
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct wasm_tag_t {
    _unused: [u8; 0],
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_tag_delete"]
    pub fn wasm_tag_delete(arg1: *mut wasm_tag_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_tag_copy"]
    pub fn wasm_tag_copy(arg1: *const wasm_tag_t) -> *mut wasm_tag_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_tag_same"]
    pub fn wasm_tag_same(arg1: *const wasm_tag_t, arg2: *const wasm_tag_t) -> bool;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_tag_get_host_info"]
    pub fn wasm_tag_get_host_info(arg1: *const wasm_tag_t) -> *mut ::std::os::raw::c_void;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_tag_set_host_info"]
    pub fn wasm_tag_set_host_info(arg1: *mut wasm_tag_t, arg2: *mut ::std::os::raw::c_void);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_tag_set_host_info_with_finalizer"]
    pub fn wasm_tag_set_host_info_with_finalizer(
        arg1: *mut wasm_tag_t,
        arg2: *mut ::std::os::raw::c_void,
        arg3: ::std::option::Option<unsafe extern "C" fn(arg1: *mut ::std::os::raw::c_void)>,
    );
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_tag_as_ref"]
    pub fn wasm_tag_as_ref(arg1: *mut wasm_tag_t) -> *mut wasm_ref_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_ref_as_tag"]
    pub fn wasm_ref_as_tag(arg1: *mut wasm_ref_t) -> *mut wasm_tag_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_tag_as_ref_const"]
    pub fn wasm_tag_as_ref_const(arg1: *const wasm_tag_t) -> *const wasm_ref_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_ref_as_tag_const"]
    pub fn wasm_ref_as_tag_const(arg1: *const wasm_ref_t) -> *const wasm_tag_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_tag_new"]
    pub fn wasm_tag_new(arg1: *mut wasm_store_t, arg2: *const wasm_tagtype_t) -> *mut wasm_tag_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_tag_type"]
    pub fn wasm_tag_type(arg1: *const wasm_tag_t) -> *mut wasm_tagtype_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_tag_get"]
    pub fn wasm_tag_get(arg1: *const wasm_tag_t, out: *mut wasm_val_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_tag_set"]
    pub fn wasm_tag_set(arg1: *mut wasm_tag_t, arg2: *const wasm_val_t);
}
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct wasm_table_t {
    _unused: [u8; 0],
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_table_delete"]
    pub fn wasm_table_delete(arg1: *mut wasm_table_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_table_copy"]
    pub fn wasm_table_copy(arg1: *const wasm_table_t) -> *mut wasm_table_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_table_same"]
    pub fn wasm_table_same(arg1: *const wasm_table_t, arg2: *const wasm_table_t) -> bool;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_table_get_host_info"]
    pub fn wasm_table_get_host_info(arg1: *const wasm_table_t) -> *mut ::std::os::raw::c_void;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_table_set_host_info"]
    pub fn wasm_table_set_host_info(arg1: *mut wasm_table_t, arg2: *mut ::std::os::raw::c_void);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_table_set_host_info_with_finalizer"]
    pub fn wasm_table_set_host_info_with_finalizer(
        arg1: *mut wasm_table_t,
        arg2: *mut ::std::os::raw::c_void,
        arg3: ::std::option::Option<unsafe extern "C" fn(arg1: *mut ::std::os::raw::c_void)>,
    );
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_table_as_ref"]
    pub fn wasm_table_as_ref(arg1: *mut wasm_table_t) -> *mut wasm_ref_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_ref_as_table"]
    pub fn wasm_ref_as_table(arg1: *mut wasm_ref_t) -> *mut wasm_table_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_table_as_ref_const"]
    pub fn wasm_table_as_ref_const(arg1: *const wasm_table_t) -> *const wasm_ref_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_ref_as_table_const"]
    pub fn wasm_ref_as_table_const(arg1: *const wasm_ref_t) -> *const wasm_table_t;
}
pub type wasm_table_size_t = u32;
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_table_new"]
    pub fn wasm_table_new(
        arg1: *mut wasm_store_t,
        arg2: *const wasm_tabletype_t,
        init: *mut wasm_ref_t,
    ) -> *mut wasm_table_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_table_type"]
    pub fn wasm_table_type(arg1: *const wasm_table_t) -> *mut wasm_tabletype_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_table_get"]
    pub fn wasm_table_get(arg1: *const wasm_table_t, index: wasm_table_size_t) -> *mut wasm_ref_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_table_set"]
    pub fn wasm_table_set(
        arg1: *mut wasm_table_t,
        index: wasm_table_size_t,
        arg2: *mut wasm_ref_t,
    ) -> bool;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_table_size"]
    pub fn wasm_table_size(arg1: *const wasm_table_t) -> wasm_table_size_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_table_grow"]
    pub fn wasm_table_grow(
        arg1: *mut wasm_table_t,
        delta: wasm_table_size_t,
        init: *mut wasm_ref_t,
    ) -> bool;
}
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct wasm_memory_t {
    _unused: [u8; 0],
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_memory_delete"]
    pub fn wasm_memory_delete(arg1: *mut wasm_memory_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_memory_copy"]
    pub fn wasm_memory_copy(arg1: *const wasm_memory_t) -> *mut wasm_memory_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_memory_same"]
    pub fn wasm_memory_same(arg1: *const wasm_memory_t, arg2: *const wasm_memory_t) -> bool;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_memory_get_host_info"]
    pub fn wasm_memory_get_host_info(arg1: *const wasm_memory_t) -> *mut ::std::os::raw::c_void;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_memory_set_host_info"]
    pub fn wasm_memory_set_host_info(arg1: *mut wasm_memory_t, arg2: *mut ::std::os::raw::c_void);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_memory_set_host_info_with_finalizer"]
    pub fn wasm_memory_set_host_info_with_finalizer(
        arg1: *mut wasm_memory_t,
        arg2: *mut ::std::os::raw::c_void,
        arg3: ::std::option::Option<unsafe extern "C" fn(arg1: *mut ::std::os::raw::c_void)>,
    );
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_memory_as_ref"]
    pub fn wasm_memory_as_ref(arg1: *mut wasm_memory_t) -> *mut wasm_ref_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_ref_as_memory"]
    pub fn wasm_ref_as_memory(arg1: *mut wasm_ref_t) -> *mut wasm_memory_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_memory_as_ref_const"]
    pub fn wasm_memory_as_ref_const(arg1: *const wasm_memory_t) -> *const wasm_ref_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_ref_as_memory_const"]
    pub fn wasm_ref_as_memory_const(arg1: *const wasm_ref_t) -> *const wasm_memory_t;
}
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct wasm_shared_memory_t {
    _unused: [u8; 0],
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_shared_memory_delete"]
    pub fn wasm_shared_memory_delete(arg1: *mut wasm_shared_memory_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_memory_share"]
    pub fn wasm_memory_share(arg1: *const wasm_memory_t) -> *mut wasm_shared_memory_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_memory_obtain"]
    pub fn wasm_memory_obtain(
        arg1: *mut wasm_store_t,
        arg2: *const wasm_shared_memory_t,
    ) -> *mut wasm_memory_t;
}
pub type wasm_memory_pages_t = u32;
pub const MEMORY_PAGE_SIZE: usize = 65536;
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_memory_new"]
    pub fn wasm_memory_new(
        arg1: *mut wasm_store_t,
        arg2: *const wasm_memorytype_t,
    ) -> *mut wasm_memory_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_memory_type"]
    pub fn wasm_memory_type(arg1: *const wasm_memory_t) -> *mut wasm_memorytype_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_memory_data"]
    pub fn wasm_memory_data(arg1: *mut wasm_memory_t) -> *mut byte_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_memory_data_size"]
    pub fn wasm_memory_data_size(arg1: *const wasm_memory_t) -> usize;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_memory_size"]
    pub fn wasm_memory_size(arg1: *const wasm_memory_t) -> wasm_memory_pages_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_memory_grow"]
    pub fn wasm_memory_grow(arg1: *mut wasm_memory_t, delta: wasm_memory_pages_t) -> bool;
}
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct wasm_extern_t {
    _unused: [u8; 0],
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_extern_delete"]
    pub fn wasm_extern_delete(arg1: *mut wasm_extern_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_extern_copy"]
    pub fn wasm_extern_copy(arg1: *const wasm_extern_t) -> *mut wasm_extern_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_extern_same"]
    pub fn wasm_extern_same(arg1: *const wasm_extern_t, arg2: *const wasm_extern_t) -> bool;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_extern_get_host_info"]
    pub fn wasm_extern_get_host_info(arg1: *const wasm_extern_t) -> *mut ::std::os::raw::c_void;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_extern_set_host_info"]
    pub fn wasm_extern_set_host_info(arg1: *mut wasm_extern_t, arg2: *mut ::std::os::raw::c_void);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_extern_set_host_info_with_finalizer"]
    pub fn wasm_extern_set_host_info_with_finalizer(
        arg1: *mut wasm_extern_t,
        arg2: *mut ::std::os::raw::c_void,
        arg3: ::std::option::Option<unsafe extern "C" fn(arg1: *mut ::std::os::raw::c_void)>,
    );
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_extern_as_ref"]
    pub fn wasm_extern_as_ref(arg1: *mut wasm_extern_t) -> *mut wasm_ref_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_ref_as_extern"]
    pub fn wasm_ref_as_extern(arg1: *mut wasm_ref_t) -> *mut wasm_extern_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_extern_as_ref_const"]
    pub fn wasm_extern_as_ref_const(arg1: *const wasm_extern_t) -> *const wasm_ref_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_ref_as_extern_const"]
    pub fn wasm_ref_as_extern_const(arg1: *const wasm_ref_t) -> *const wasm_extern_t;
}
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct wasm_extern_vec_t {
    pub size: usize,
    pub data: *mut *mut wasm_extern_t,
}
#[allow(clippy::unnecessary_operation, clippy::identity_op)]
const _: () = {
    ["Size of wasm_extern_vec_t"][::std::mem::size_of::<wasm_extern_vec_t>() - 16usize];
    ["Alignment of wasm_extern_vec_t"][::std::mem::align_of::<wasm_extern_vec_t>() - 8usize];
    ["Offset of field: wasm_extern_vec_t::size"]
        [::std::mem::offset_of!(wasm_extern_vec_t, size) - 0usize];
    ["Offset of field: wasm_extern_vec_t::data"]
        [::std::mem::offset_of!(wasm_extern_vec_t, data) - 8usize];
};
impl Default for wasm_extern_vec_t {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_extern_vec_new_empty"]
    pub fn wasm_extern_vec_new_empty(out: *mut wasm_extern_vec_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_extern_vec_new_uninitialized"]
    pub fn wasm_extern_vec_new_uninitialized(out: *mut wasm_extern_vec_t, arg1: usize);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_extern_vec_new"]
    pub fn wasm_extern_vec_new(
        out: *mut wasm_extern_vec_t,
        arg1: usize,
        arg2: *const *mut wasm_extern_t,
    );
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_extern_vec_copy"]
    pub fn wasm_extern_vec_copy(out: *mut wasm_extern_vec_t, arg1: *const wasm_extern_vec_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_extern_vec_delete"]
    pub fn wasm_extern_vec_delete(arg1: *mut wasm_extern_vec_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_extern_kind"]
    pub fn wasm_extern_kind(arg1: *const wasm_extern_t) -> wasm_externkind_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_extern_type"]
    pub fn wasm_extern_type(arg1: *const wasm_extern_t) -> *mut wasm_externtype_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_func_as_extern"]
    pub fn wasm_func_as_extern(arg1: *mut wasm_func_t) -> *mut wasm_extern_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_global_as_extern"]
    pub fn wasm_global_as_extern(arg1: *mut wasm_global_t) -> *mut wasm_extern_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_tag_as_extern"]
    pub fn wasm_tag_as_extern(arg1: *mut wasm_tag_t) -> *mut wasm_extern_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_table_as_extern"]
    pub fn wasm_table_as_extern(arg1: *mut wasm_table_t) -> *mut wasm_extern_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_memory_as_extern"]
    pub fn wasm_memory_as_extern(arg1: *mut wasm_memory_t) -> *mut wasm_extern_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_extern_as_func"]
    pub fn wasm_extern_as_func(arg1: *mut wasm_extern_t) -> *mut wasm_func_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_extern_as_global"]
    pub fn wasm_extern_as_global(arg1: *mut wasm_extern_t) -> *mut wasm_global_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_extern_as_tag"]
    pub fn wasm_extern_as_tag(arg1: *mut wasm_extern_t) -> *mut wasm_tag_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_extern_as_table"]
    pub fn wasm_extern_as_table(arg1: *mut wasm_extern_t) -> *mut wasm_table_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_extern_as_memory"]
    pub fn wasm_extern_as_memory(arg1: *mut wasm_extern_t) -> *mut wasm_memory_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_func_as_extern_const"]
    pub fn wasm_func_as_extern_const(arg1: *const wasm_func_t) -> *const wasm_extern_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_global_as_extern_const"]
    pub fn wasm_global_as_extern_const(arg1: *const wasm_global_t) -> *const wasm_extern_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_tag_as_extern_const"]
    pub fn wasm_tag_as_extern_const(arg1: *const wasm_tag_t) -> *const wasm_extern_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_table_as_extern_const"]
    pub fn wasm_table_as_extern_const(arg1: *const wasm_table_t) -> *const wasm_extern_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_memory_as_extern_const"]
    pub fn wasm_memory_as_extern_const(arg1: *const wasm_memory_t) -> *const wasm_extern_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_extern_as_func_const"]
    pub fn wasm_extern_as_func_const(arg1: *const wasm_extern_t) -> *const wasm_func_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_extern_as_global_const"]
    pub fn wasm_extern_as_global_const(arg1: *const wasm_extern_t) -> *const wasm_global_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_extern_as_tag_const"]
    pub fn wasm_extern_as_tag_const(arg1: *const wasm_extern_t) -> *const wasm_tag_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_extern_as_table_const"]
    pub fn wasm_extern_as_table_const(arg1: *const wasm_extern_t) -> *const wasm_table_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_extern_as_memory_const"]
    pub fn wasm_extern_as_memory_const(arg1: *const wasm_extern_t) -> *const wasm_memory_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_instance_delete"]
    pub fn wasm_instance_delete(arg1: *mut wasm_instance_t);
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_instance_copy"]
    pub fn wasm_instance_copy(arg1: *const wasm_instance_t) -> *mut wasm_instance_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_instance_same"]
    pub fn wasm_instance_same(arg1: *const wasm_instance_t, arg2: *const wasm_instance_t) -> bool;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_instance_get_host_info"]
    pub fn wasm_instance_get_host_info(arg1: *const wasm_instance_t)
    -> *mut ::std::os::raw::c_void;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_instance_set_host_info"]
    pub fn wasm_instance_set_host_info(
        arg1: *mut wasm_instance_t,
        arg2: *mut ::std::os::raw::c_void,
    );
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_instance_set_host_info_with_finalizer"]
    pub fn wasm_instance_set_host_info_with_finalizer(
        arg1: *mut wasm_instance_t,
        arg2: *mut ::std::os::raw::c_void,
        arg3: ::std::option::Option<unsafe extern "C" fn(arg1: *mut ::std::os::raw::c_void)>,
    );
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_instance_as_ref"]
    pub fn wasm_instance_as_ref(arg1: *mut wasm_instance_t) -> *mut wasm_ref_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_ref_as_instance"]
    pub fn wasm_ref_as_instance(arg1: *mut wasm_ref_t) -> *mut wasm_instance_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_instance_as_ref_const"]
    pub fn wasm_instance_as_ref_const(arg1: *const wasm_instance_t) -> *const wasm_ref_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_ref_as_instance_const"]
    pub fn wasm_ref_as_instance_const(arg1: *const wasm_ref_t) -> *const wasm_instance_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_instance_new"]
    pub fn wasm_instance_new(
        arg1: *mut wasm_store_t,
        arg2: *const wasm_module_t,
        imports: *const wasm_extern_vec_t,
        arg3: *mut *mut wasm_trap_t,
    ) -> *mut wasm_instance_t;
}
unsafe extern "C" {
    #[link_name = "\u{1}wee8_wasm_instance_exports"]
    pub fn wasm_instance_exports(arg1: *const wasm_instance_t, out: *mut wasm_extern_vec_t);
}
#[repr(C)]
#[derive(Debug, Default, Copy, Clone)]
pub struct __crt_locale_data {
    pub _address: u8,
}
#[repr(C)]
#[derive(Debug, Default, Copy, Clone)]
pub struct __crt_multibyte_data {
    pub _address: u8,
}
