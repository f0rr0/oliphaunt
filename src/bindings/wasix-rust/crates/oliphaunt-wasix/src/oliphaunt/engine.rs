/// Capabilities advertised by the packaged WASIX runtime.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineCapabilities {
    pub engine_name: &'static str,
    pub version: String,
    pub multiple_instances: bool,
    pub same_instance_logical_reopen: bool,
    pub instance_switchable: bool,
    pub crash_restartable: bool,
    pub protocol_raw: bool,
    pub protocol_stream: bool,
    pub server_mode: bool,
    pub extensions: bool,
}

impl EngineCapabilities {
    pub(crate) fn wasix(protocol_stream: bool) -> Self {
        Self {
            engine_name: "wasix",
            version: crate::oliphaunt::aot::engine_identity().to_owned(),
            multiple_instances: true,
            same_instance_logical_reopen: false,
            instance_switchable: true,
            crash_restartable: false,
            protocol_raw: true,
            protocol_stream,
            server_mode: true,
            extensions: cfg!(feature = "extensions"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::EngineCapabilities;

    #[test]
    fn embedded_wasix_lifecycle_is_reported_honestly() {
        let capabilities = EngineCapabilities::wasix(true);
        assert!(capabilities.multiple_instances);
        assert!(!capabilities.same_instance_logical_reopen);
        assert!(capabilities.instance_switchable);
        assert!(!capabilities.crash_restartable);
    }
}
