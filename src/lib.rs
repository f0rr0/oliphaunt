#![doc = include_str!("../README.md")]
#![deny(unsafe_code)]

mod pglite;
mod protocol;

#[cfg(feature = "extensions")]
pub use pglite::extensions;

pub use pglite::{
    DataTransferContainer, DescribeQueryParam, DescribeQueryResult, DescribeResultField, FieldInfo,
    GlobalListenerHandle, ListenerHandle, NoticeCallback, ParserMap, Pglite, PgliteBuilder,
    PgliteError, PgliteServer, PgliteServerBuilder, QueryOptions, QueryTemplate, Results, RowMode,
    Serializer, SerializerMap, TemplatedQuery, Transaction, TypeParser, format_query,
    quote_identifier,
};
pub use protocol::messages::{DatabaseError, NoticeMessage};

#[doc(hidden)]
pub use pglite::{
    DebugLevel, FsTraceSnapshot, InstallOptions, InstallOutcome, MountInfo, PgDataTemplate,
    PgDataTemplateManifest, PglitePaths, PgliteProxy, PhaseTiming, build_pgdata_template,
    capture_phase_timings, ensure_cluster, fs_trace_snapshot, install_and_init,
    install_and_init_in, install_default, install_extension_archive, install_extension_bytes,
    install_into, install_with_options, measure_phase, preload_runtime_module, record_phase_timing,
    reset_fs_trace,
};
