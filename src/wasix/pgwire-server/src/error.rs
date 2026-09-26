pub(crate) fn public_result<T>(result: anyhow::Result<T>) -> crate::Result<T> {
    result.map_err(crate::Error::from_anyhow)
}

pub(crate) fn invalid_configuration(
    message: impl std::fmt::Display + Send + Sync + 'static,
) -> anyhow::Error {
    anyhow::Error::new(crate::Error::classified(
        crate::ErrorKind::InvalidConfiguration,
        message,
    ))
}
