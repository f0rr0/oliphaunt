pub(crate) mod aot;
pub(crate) mod assets;
pub(crate) mod base;
pub(crate) mod builder;
pub(crate) mod client;
pub(crate) mod errors;
#[cfg(feature = "extensions")]
pub mod extensions;
pub(crate) mod interface;
pub(crate) mod parse;
#[cfg(all(test, feature = "extensions"))]
pub(crate) mod pg_dump;
pub(crate) mod postgres_mod;
pub(crate) mod proxy;
pub(crate) mod server;
pub(crate) mod sync_host_fs;
pub(crate) mod templating;
pub(crate) mod timing;
pub(crate) mod transport;
pub(crate) mod types;

pub use base::{
    InstallOptions, InstallOutcome, MountInfo, PgDataTemplate, PgDataTemplateManifest, PglitePaths,
    build_pgdata_template, ensure_cluster, install_and_init, install_and_init_in, install_default,
    install_extension_archive, install_extension_bytes, install_into, install_with_options,
    preload_runtime_module,
};
pub use builder::PgliteBuilder;
pub use client::{GlobalListenerHandle, ListenerHandle, Pglite, Transaction};
pub use errors::PgliteError;
pub use interface::{
    DataTransferContainer, DebugLevel, DescribeQueryParam, DescribeQueryResult,
    DescribeResultField, FieldInfo, NoticeCallback, ParserMap, QueryOptions, Results, RowMode,
    Serializer, SerializerMap, TypeParser,
};
#[doc(hidden)]
pub use postgres_mod::{FsTraceSnapshot, fs_trace_snapshot, reset_fs_trace};
pub use proxy::PgliteProxy;
pub use server::{PgliteServer, PgliteServerBuilder};
pub use templating::{QueryTemplate, TemplatedQuery, format_query, quote_identifier};
pub use timing::{PhaseTiming, capture_phase_timings, measure_phase, record_phase_timing};
