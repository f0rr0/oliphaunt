pub(crate) type TerminalCloseResult = crate::Result<()>;

pub(crate) fn teardown_result(
    owner: &'static str,
    close: impl FnOnce() -> anyhow::Result<()>,
) -> TerminalCloseResult {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(close)) {
        Ok(result) => result.map_err(crate::Error::from_anyhow),
        Err(panic) => {
            let message = panic
                .downcast_ref::<String>()
                .map(String::as_str)
                .or_else(|| panic.downcast_ref::<&'static str>().copied())
                .unwrap_or("unknown panic payload");
            Err(crate::Error::from_anyhow(anyhow::anyhow!(
                "{owner} panicked during teardown: {message}"
            )))
        }
    }
}
