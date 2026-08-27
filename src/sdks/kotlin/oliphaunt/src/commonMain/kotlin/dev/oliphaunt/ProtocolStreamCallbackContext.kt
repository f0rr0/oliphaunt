package dev.oliphaunt

internal expect fun currentProtocolStreamCallbackOwner(): Any?

internal expect fun setCurrentProtocolStreamCallbackOwner(owner: Any?)

internal fun <T> withProtocolStreamCallbackContext(
    owner: Any,
    block: () -> T,
): T {
    val previous = currentProtocolStreamCallbackOwner()
    setCurrentProtocolStreamCallbackOwner(owner)
    return try {
        block()
    } finally {
        setCurrentProtocolStreamCallbackOwner(previous)
    }
}
