#include "profile.h"
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <intrin.h>

/* Producer-only Windows V8 cache control, linked without the CRT. */
typedef SIZE_T usize;
typedef struct {
    usize size;
    unsigned char *data;
} Vec;

#define IMP __declspec(dllimport)
IMP void oliphaunt_set_v8_flags(const char *, usize);
IMP void *wee8_wasm_engine_new(void);
IMP void *wee8_wasm_store_new(void *);
IMP void wee8_wasm_store_delete(void *);
IMP void wee8_wasm_engine_delete(void *);
IMP void wee8_wasm_byte_vec_new_uninitialized(Vec *, usize);
IMP void wee8_wasm_byte_vec_delete(Vec *);
IMP void *wee8_wasm_module_new(void *, const Vec *);
IMP void *wee8_wasm_module_deserialize(void *, const Vec *);
IMP void wee8_wasm_module_serialize(void *, Vec *);
IMP void wee8_wasm_module_delete(void *);

static void print(const char *text) {
    DWORD done;
    usize length = 0;
    while (text[length]) length++;
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), text, (DWORD)length, &done, NULL);
}

static void number(usize value, int hex) {
    char out[32];
    unsigned length = 0, base = hex ? 16 : 10;
    do {
        unsigned digit = value % base;
        out[length++] = (char)(digit < 10 ? '0' + digit : 'a' + digit - 10);
        value /= base;
    } while (value);
    if (hex) print("0x");
    for (unsigned i = 0; i < length / 2; i++) {
        char swap = out[i];
        out[i] = out[length - 1 - i];
        out[length - 1 - i] = swap;
    }
    out[length] = 0;
    print(out);
}

static DWORD word(const unsigned char *bytes) {
    DWORD value;
    CopyMemory(&value, bytes, sizeof(value));
    return value;
}

static void finish(DWORD code) {
    /* The Linux producer supervisor owns shutdown: Wine/QEMU can crash even
       during TerminateProcess. SDK applications do not use this helper. */
    print("producer_exit=");
    number(code, 0);
    print("\n");
    for (;;) Sleep(INFINITE);
}

static void fail(const char *message, DWORD code) {
    print(message);
    print("\n");
    finish(code);
}

static Vec read_bytes(const WCHAR *path) {
    HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
    LARGE_INTEGER size;
    DWORD got = 0;
    Vec bytes;
    if (file == INVALID_HANDLE_VALUE || !GetFileSizeEx(file, &size) ||
        size.QuadPart <= 0 || size.QuadPart > 0x7fffffff) {
        fail("read open/size failed", 10);
    }
    wee8_wasm_byte_vec_new_uninitialized(&bytes, (usize)size.QuadPart);
    if (!ReadFile(file, bytes.data, (DWORD)size.QuadPart, &got, NULL) || got != size.QuadPart) {
        fail("read bytes failed", 11);
    }
    CloseHandle(file);
    return bytes;
}

static void write_bytes(const WCHAR *path, const Vec *bytes) {
    HANDLE file = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, 0, NULL);
    DWORD done = 0;
    if (file == INVALID_HANDLE_VALUE ||
        !WriteFile(file, bytes->data, (DWORD)bytes->size, &done, NULL) || done != bytes->size) {
        fail("write failed", 12);
    }
    CloseHandle(file);
}

void mainCRTStartup(void) {
    int cpu[4];
    __cpuidex(cpu, 1, 0);
    print("cpuid_leaf1_ecx=");
    number((DWORD)cpu[2], 1);
    __cpuidex(cpu, 7, 0);
    print(" cpuid_leaf7_ecx=");
    number((DWORD)cpu[2], 1);
    print("\n");

    static const char flags[] = OLIPHAUNT_V8_FLAGS;
    oliphaunt_set_v8_flags(flags, sizeof(flags) - 1);
    int reader = 0;
    const WCHAR *command = GetCommandLineW();
    for (usize i = 0; command[i]; i++) {
        if (command[i] == ' ' && command[i + 1] == 'r' && command[i + 2] == 'e' &&
            command[i + 3] == 'a' && command[i + 4] == 'd') reader = 1;
    }
    print(reader ? "operation=read\n" : "operation=write\n");

    void *engine = wee8_wasm_engine_new();
    if (!engine) fail("engine failed", 20);
    void *store = wee8_wasm_store_new(engine);
    if (!store) fail("store failed", 20);
    Vec data = read_bytes(reader ? L"cache.bin" : L"guest.wasm");
    if (!reader) {
        void *module = wee8_wasm_module_new(store, &data);
        if (!module) fail("compile failed", 21);
        Vec cache;
        wee8_wasm_module_serialize(module, &cache);
        wee8_wasm_module_delete(module);
        wee8_wasm_byte_vec_delete(&data);
        data = cache;
        write_bytes(L"cache.bin", &data);
    }

    usize position = 0, wire = 0;
    unsigned shift = 0;
    do {
        if (position >= data.size || shift > 63) fail("invalid wire length", 22);
        unsigned byte = data.data[position++];
        wire |= (usize)(byte & 127) << shift;
        shift += 7;
        if (!(byte & 128)) break;
    } while (1);
    if (wire > data.size - position || data.size - position - wire < 20) {
        fail("missing native cache", 23);
    }
    usize offset = position + wire;
    print("native_bytes=");
    number(data.size - offset, 0);
    print(" cpu_mask=");
    number(word(data.data + offset + 8), 1);
    print(" flag_hash=");
    number(word(data.data + offset + 12), 1);
    print("\n");

    void *module = wee8_wasm_module_deserialize(store, &data);
    if (!module) fail("native_deserialize=REJECT", 24);
    print("native_deserialize=PASS (no compilation fallback)\n");
    wee8_wasm_module_delete(module);
    wee8_wasm_byte_vec_delete(&data);
    print("stage=module_deleted\n");
    wee8_wasm_store_delete(store);
    print("stage=store_deleted\n");
    wee8_wasm_engine_delete(engine);
    print("stage=engine_deleted\n");
    print("stage=emulated_producer_completed\n");
    finish(0);
}
