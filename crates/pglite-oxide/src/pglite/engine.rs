use std::fmt;

/// Runtime engine used by [`Pglite`](crate::Pglite).
///
/// The default remains [`WasixLegacy`](Self::WasixLegacy). The native
/// `libpglite` path is an explicit happy-path spike until it passes the same
/// release gates as the WASIX runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum EngineKind {
    /// Keep today's packaged WASIX/Wasmer runtime.
    #[default]
    WasixLegacy,
    /// Load a native `libpglite` C ABI from `PGLITE_OXIDE_NATIVE_LIBPGLITE`.
    NativeLibPglite,
}

impl fmt::Display for EngineKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::WasixLegacy => f.write_str("wasix-legacy"),
            Self::NativeLibPglite => f.write_str("native-libpglite"),
        }
    }
}

/// Capabilities advertised by the active embedded engine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineCapabilities {
    pub kind: EngineKind,
    pub engine_name: &'static str,
    pub version: String,
    pub multi_instance: bool,
    pub protocol_raw: bool,
    pub protocol_stream: bool,
    pub server_mode: bool,
    pub extensions: bool,
}

impl EngineCapabilities {
    pub(crate) fn wasix_legacy(protocol_stream: bool) -> Self {
        Self {
            kind: EngineKind::WasixLegacy,
            engine_name: "wasix-legacy",
            version: crate::pglite::aot::engine_identity().to_owned(),
            multi_instance: true,
            protocol_raw: true,
            protocol_stream,
            server_mode: true,
            extensions: cfg!(feature = "extensions"),
        }
    }

    pub(crate) fn native_libpglite(version: String, flags: u64) -> Self {
        Self {
            kind: EngineKind::NativeLibPglite,
            engine_name: "native-libpglite",
            version,
            multi_instance: flags & native_flags::MULTI_INSTANCE != 0,
            protocol_raw: flags & native_flags::PROTOCOL_RAW != 0,
            protocol_stream: flags & native_flags::PROTOCOL_STREAM != 0,
            server_mode: flags & native_flags::SERVER_MODE != 0,
            extensions: flags & native_flags::EXTENSIONS != 0,
        }
    }
}

pub(crate) mod native_flags {
    pub const PROTOCOL_RAW: u64 = 1 << 0;
    pub const PROTOCOL_STREAM: u64 = 1 << 1;
    pub const MULTI_INSTANCE: u64 = 1 << 2;
    pub const SERVER_MODE: u64 = 1 << 3;
    pub const EXTENSIONS: u64 = 1 << 4;
}
