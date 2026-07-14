# oliphaunt-broker

`oliphaunt-broker` is the helper process used by broker mode. It owns one
native database root per process, serves the Oliphaunt broker IPC protocol, and
is packaged as platform-specific release assets for SDKs that need process
isolation.

Application developers should use their SDK's broker mode instead of invoking
this binary directly.
