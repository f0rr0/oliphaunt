use std::fmt;

use anyhow::Result;

use crate::pglite::assets;

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

/// Runtime artifact family packaged with this pglite-oxide build.
///
/// This is separate from [`EngineKind`], which selects the direct embedded
/// backend used by [`Pglite`](crate::Pglite). PostgreSQL 18 server-core assets
/// intentionally expose only the local server path.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum PgliteRuntimeKind {
    /// Legacy WASIX dynamic-main runtime with direct and proxied server APIs.
    WasixDynamicMain,
    /// PostgreSQL WASIX server-core runtime, currently exposed through
    /// [`PgliteServer`](crate::PgliteServer).
    WasixPostgresServer,
    /// A runtime kind newer than this crate knows about.
    Other(String),
}

impl PgliteRuntimeKind {
    /// Return the manifest runtime-kind string.
    pub fn as_str(&self) -> &str {
        match self {
            Self::WasixDynamicMain => "wasix-dynamic-main",
            Self::WasixPostgresServer => "wasix-postgres-server",
            Self::Other(kind) => kind,
        }
    }

    /// Whether this runtime can be opened through the direct [`Pglite`] API.
    pub fn supports_direct_backend(&self) -> bool {
        matches!(self, Self::WasixDynamicMain)
    }

    /// Whether this runtime can back [`PgliteServer`](crate::PgliteServer).
    pub fn supports_server_backend(&self) -> bool {
        self.supports_server_tcp_endpoint() || self.supports_server_unix_socket_endpoint()
    }

    /// Whether this runtime can back a TCP [`PgliteServer`](crate::PgliteServer).
    pub fn supports_server_tcp_endpoint(&self) -> bool {
        matches!(self, Self::WasixDynamicMain | Self::WasixPostgresServer)
    }

    /// Whether this runtime can back a Unix-socket [`PgliteServer`](crate::PgliteServer).
    pub fn supports_server_unix_socket_endpoint(&self) -> bool {
        matches!(self, Self::WasixDynamicMain) && cfg!(unix)
    }

    /// Whether this runtime can preinstall bundled extensions before startup.
    pub fn supports_bundled_extension_preinstall(&self) -> bool {
        matches!(self, Self::WasixDynamicMain) && cfg!(feature = "extensions")
    }

    /// Whether server mode uses an external Wasmer/Postgres process.
    pub fn server_uses_external_process(&self) -> bool {
        matches!(self, Self::WasixPostgresServer)
    }

    /// Return a stable explanation when direct [`Pglite`](crate::Pglite) is unsupported.
    pub fn direct_unavailable_reason(&self) -> Option<&'static str> {
        match self {
            Self::WasixDynamicMain => None,
            Self::WasixPostgresServer => Some(
                "the PostgreSQL 18 WASIX server-core runtime exposes postgres as a server binary, not the legacy direct PGlite backend",
            ),
            Self::Other(_) => {
                Some("this packaged runtime kind is not known to support direct Pglite")
            }
        }
    }

    /// Whether this runtime is the PostgreSQL WASIX server-core lane.
    pub fn is_wasix_postgres_server(&self) -> bool {
        matches!(self, Self::WasixPostgresServer)
    }

    pub(crate) fn from_manifest_kind(kind: String) -> Self {
        match kind.as_str() {
            "wasix-dynamic-main" => Self::WasixDynamicMain,
            "wasix-postgres-server" => Self::WasixPostgresServer,
            _ => Self::Other(kind),
        }
    }
}

impl fmt::Display for PgliteRuntimeKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Capability summary for the packaged runtime assets in this crate build.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PgliteRuntimeCapabilities {
    kind: PgliteRuntimeKind,
}

impl PgliteRuntimeCapabilities {
    pub(crate) fn new(kind: PgliteRuntimeKind) -> Self {
        Self { kind }
    }

    /// Return the packaged runtime family these capabilities describe.
    pub fn kind(&self) -> &PgliteRuntimeKind {
        &self.kind
    }

    /// Whether this runtime can be opened through the direct [`Pglite`](crate::Pglite) API.
    pub fn supports_direct_backend(&self) -> bool {
        self.kind.supports_direct_backend()
    }

    /// Whether this runtime can back any [`PgliteServer`](crate::PgliteServer) endpoint.
    pub fn supports_server_backend(&self) -> bool {
        self.kind.supports_server_backend()
    }

    /// Whether this runtime can back a TCP [`PgliteServer`](crate::PgliteServer).
    pub fn supports_server_tcp_endpoint(&self) -> bool {
        self.kind.supports_server_tcp_endpoint()
    }

    /// Whether this runtime can back a Unix-socket [`PgliteServer`](crate::PgliteServer).
    pub fn supports_server_unix_socket_endpoint(&self) -> bool {
        self.kind.supports_server_unix_socket_endpoint()
    }

    /// Whether this runtime can preinstall bundled extensions before startup.
    pub fn supports_bundled_extension_preinstall(&self) -> bool {
        self.kind.supports_bundled_extension_preinstall()
    }

    /// Whether server mode uses an external Wasmer/Postgres process.
    pub fn server_uses_external_process(&self) -> bool {
        self.kind.server_uses_external_process()
    }

    /// Return a stable explanation when direct [`Pglite`](crate::Pglite) is unsupported.
    pub fn direct_unavailable_reason(&self) -> Option<&'static str> {
        self.kind.direct_unavailable_reason()
    }
}

/// Return the packaged runtime kind, if this build includes runtime assets.
pub fn packaged_runtime_kind() -> Result<Option<PgliteRuntimeKind>> {
    Ok(assets::runtime_kind()?.map(PgliteRuntimeKind::from_manifest_kind))
}

/// Return packaged runtime capabilities, if this build includes runtime assets.
pub fn packaged_runtime_capabilities() -> Result<Option<PgliteRuntimeCapabilities>> {
    Ok(packaged_runtime_kind()?.map(PgliteRuntimeCapabilities::new))
}

/// Return true when the packaged runtime is PostgreSQL WASIX server-core.
pub fn using_wasix_postgres_server_core_assets() -> Result<bool> {
    Ok(packaged_runtime_kind()?
        .as_ref()
        .is_some_and(PgliteRuntimeKind::is_wasix_postgres_server))
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

#[cfg(test)]
mod tests {
    use super::{PgliteRuntimeCapabilities, PgliteRuntimeKind};

    #[test]
    fn runtime_kind_models_direct_and_server_core_capabilities() {
        let direct = PgliteRuntimeKind::from_manifest_kind("wasix-dynamic-main".to_owned());
        assert_eq!(direct.as_str(), "wasix-dynamic-main");
        assert!(direct.supports_direct_backend());
        assert!(direct.supports_server_backend());
        assert!(direct.supports_server_tcp_endpoint());
        assert_eq!(direct.supports_server_unix_socket_endpoint(), cfg!(unix));
        assert!(!direct.is_wasix_postgres_server());
        assert!(!direct.server_uses_external_process());
        assert_eq!(direct.direct_unavailable_reason(), None);

        let server = PgliteRuntimeKind::from_manifest_kind("wasix-postgres-server".to_owned());
        assert_eq!(server.as_str(), "wasix-postgres-server");
        assert!(!server.supports_direct_backend());
        assert!(server.supports_server_backend());
        assert!(server.supports_server_tcp_endpoint());
        assert!(!server.supports_server_unix_socket_endpoint());
        assert!(server.is_wasix_postgres_server());
        assert!(server.server_uses_external_process());
        assert!(
            server
                .direct_unavailable_reason()
                .is_some_and(|reason| reason.contains("server-core runtime exposes postgres"))
        );

        let capabilities = PgliteRuntimeCapabilities::new(server);
        assert!(!capabilities.supports_direct_backend());
        assert!(capabilities.supports_server_tcp_endpoint());
        assert!(!capabilities.supports_bundled_extension_preinstall());
    }
}
