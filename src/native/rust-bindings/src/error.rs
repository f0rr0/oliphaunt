pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    InvalidConfig(String),
    Engine(String),
    EngineStopped,
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidConfig(s) | Self::Engine(s) => f.write_str(s),
            Self::EngineStopped => f.write_str("native session is closed"),
        }
    }
}
impl std::error::Error for Error {}
