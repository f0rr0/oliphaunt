package dev.oliphaunt

private val protocolStreamCallbackOwner = ThreadLocal<Any?>()

internal actual fun currentProtocolStreamCallbackOwner(): Any? = protocolStreamCallbackOwner.get()

internal actual fun setCurrentProtocolStreamCallbackOwner(owner: Any?) = protocolStreamCallbackOwner.set(owner)
