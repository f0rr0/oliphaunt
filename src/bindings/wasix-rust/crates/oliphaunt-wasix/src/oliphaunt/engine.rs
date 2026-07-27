/// Capabilities advertised by the packaged WASIX runtime.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineCapabilities {
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
            engine_name: "wasix-legacy",
            version: crate::oliphaunt::aot::engine_identity().to_owned(),
            multi_instance: true,
            protocol_raw: true,
            protocol_stream,
            server_mode: true,
            extensions: cfg!(feature = "extensions"),
        }
    }
}
