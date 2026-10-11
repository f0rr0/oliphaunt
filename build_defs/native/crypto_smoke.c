#include <openssl/evp.h>
#include <openssl/opensslv.h>
#include <openssl/provider.h>
#include <openssl/crypto.h>
#include <stdio.h>
#include <string.h>

static int digest(const char *name, const char *provider, const unsigned char *expected, size_t expected_size)
{
    unsigned char output[EVP_MAX_MD_SIZE];
    unsigned int size = 0;
    EVP_MD *algorithm = EVP_MD_fetch(NULL, name, provider);
    int success = algorithm && EVP_Digest("abc", 3, output, &size, algorithm, NULL)
        && size == expected_size && memcmp(output, expected, size) == 0;
    EVP_MD_free(algorithm);
    return success;
}

int main(void)
{
    static const unsigned char sha256[] = {
        0xba, 0x78, 0x16, 0xbf, 0x8f, 0x01, 0xcf, 0xea,
        0x41, 0x41, 0x40, 0xde, 0x5d, 0xae, 0x22, 0x23,
        0xb0, 0x03, 0x61, 0xa3, 0x96, 0x17, 0x7a, 0x9c,
        0xb4, 0x10, 0xff, 0x61, 0xf2, 0x00, 0x15, 0xad,
    };
    static const unsigned char md4[] = {
        0xa4, 0x48, 0x01, 0x7a, 0xaf, 0x21, 0xd8, 0x52,
        0x5f, 0xc1, 0x0a, 0xe8, 0x7a, 0xa6, 0x72, 0x9d,
    };
    if (OpenSSL_version_num() != OPENSSL_VERSION_NUMBER) {
        fputs("OpenSSL headers and compiled source disagree\n", stderr);
        return 1;
    }
    OSSL_PROVIDER *default_provider = OSSL_PROVIDER_load(NULL, "default");
    OSSL_PROVIDER *legacy_provider = OSSL_PROVIDER_load(NULL, "legacy");
    int success = default_provider && legacy_provider
        && digest("SHA256", "provider=default", sha256, sizeof(sha256))
        && digest("MD4", "provider=legacy", md4, sizeof(md4));
    OSSL_PROVIDER_unload(legacy_provider);
    OSSL_PROVIDER_unload(default_provider);
    if (!success) {
        fputs("OpenSSL builtin default/legacy provider digest failed\n", stderr);
        return 1;
    }
    puts(OpenSSL_version(OPENSSL_VERSION));
    return 0;
}
