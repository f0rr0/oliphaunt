# JNI looks up this callback by name and signature during streamed queries.
-keep interface dev.oliphaunt.OliphauntAndroidProtocolStreamSink {
    public int onChunk(byte[]);
}
