package dev.oliphaunt.broker;

oneway interface IBrokerClient {
    void ready(in byte[] generation, int abi, String runtimeVersion);
    void failed(String reason, String detail);
}
