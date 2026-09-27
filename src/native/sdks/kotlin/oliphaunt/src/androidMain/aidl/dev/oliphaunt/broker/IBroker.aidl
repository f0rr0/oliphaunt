package dev.oliphaunt.broker;
import android.os.ParcelFileDescriptor;
import dev.oliphaunt.broker.IBrokerClient;

/** Internal, same-package control only. Bulk bytes use the transferred socket. */
oneway interface IBroker {
    void open(IBrokerClient owner, in ParcelFileDescriptor socket, @nullable String name,
        boolean legacyExists, boolean restore, in String[] gucNames, in String[] gucValues,
        @nullable String username, @nullable String database, in String[] extensions, long startupTimeoutMillis);
    void cancel(IBrokerClient owner, in byte[] generation, long request);
    void close(IBrokerClient owner, in @nullable byte[] generation);
}
