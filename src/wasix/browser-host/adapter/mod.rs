//! Browser-only adapter for Oliphaunt's embedded PostgreSQL and frontend tools.
//! The SDK supplies WASIX and its worker scheduler; SQL never goes through a
//! command runner or a virtual socket.
mod caller_realm;
mod clock;
mod fs;
mod instance;
mod options;
mod postgres_direct;
mod protocol_contract;
mod run;
mod runtime;
mod streams;
mod tool_direct;
mod utils;
pub use fs::{Directory, DirectoryInit};
pub use instance::Instance;
pub use options::RunOptions;
pub use postgres_direct::{OliphauntDirectInstance, instantiate_oliphaunt_direct};
pub use run::run_wasix;
pub use tool_direct::{OliphauntPreparedTool, prepare_oliphaunt_tool, run_oliphaunt_tool_direct};
pub use utils::StringOrBytes;
