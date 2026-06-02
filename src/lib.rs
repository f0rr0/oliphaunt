#![doc = include_str!("../README.md")]
#![deny(unsafe_code)]

mod pglite;
mod protocol;

#[cfg(feature = "extensions")]
pub use pglite::extensions;

pub use pglite::{
    DataDirArchiveFormat, DataTransferContainer, DescribeQueryParam, DescribeQueryResult,
    DescribeResultField, ExecProtocolOptions, ExecProtocolResult, FieldInfo, GlobalListenerHandle,
    ListenerHandle, NoticeCallback, ParserMap, Pglite, PgliteBuilder, PgliteError, PgliteServer,
    PgliteServerBuilder, PostgresConfig, QueryOptions, QueryTemplate, Results, RowMode, Serializer,
    SerializerMap, TemplatedQuery, Transaction, TypeParser, format_query, quote_identifier,
};
#[cfg(feature = "extensions")]
pub use pglite::{
    PgDumpOptions, install_extension_archive_with_aot, install_extension_bytes_with_aot,
    register_extension_aot_artifact,
};
pub use protocol::messages::{BackendMessage, DatabaseError, NoticeMessage};

#[doc(hidden)]
pub use pglite::{
    DebugLevel, FsTraceSnapshot, InstallOptions, InstallOutcome, MountInfo, PgDataTemplate,
    PgDataTemplateManifest, PglitePaths, PgliteProxy, PhaseTiming, ProtocolStatsSnapshot,
    build_pgdata_template, capture_phase_timings, disable_protocol_stats, ensure_cluster,
    fs_trace_snapshot, install_and_init, install_and_init_in, install_default,
    install_extension_archive, install_extension_bytes, install_into, install_with_options,
    measure_phase, preload_runtime_module, protocol_stats_snapshot, record_phase_timing,
    reset_fs_trace, reset_protocol_stats,
};
