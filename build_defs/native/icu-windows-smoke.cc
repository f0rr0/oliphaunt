#include <cstdint>
#include <cstdio>

#include "unicode/uclean.h"
#include "unicode/ucol.h"
#include "unicode/uloc.h"
#include "unicode/unorm2.h"
#include "unicode/uversion.h"

extern "C" const unsigned char U_DATA_API U_ICUDATA_ENTRY_POINT[];

int main() {
    // The exported symbol must be the real, aligned common-data header. This
    // also makes the test link directly through the generated data import lib.
    if (reinterpret_cast<uintptr_t>(U_ICUDATA_ENTRY_POINT) % 16 != 0 ||
        U_ICUDATA_ENTRY_POINT[2] != 0xda || U_ICUDATA_ENTRY_POINT[3] != 0x27 ||
        U_ICUDATA_ENTRY_POINT[12] != 'C' || U_ICUDATA_ENTRY_POINT[13] != 'm')
        return 1;
    UVersionInfo version;
    u_getVersion(version);
    if (version[0] != U_ICU_VERSION_MAJOR_NUM) return 2;
    UErrorCode error = U_ZERO_ERROR;
    u_init(&error);
    if (U_FAILURE(error) || uloc_countAvailable() < 100) return 3;
    const UNormalizer2 *nfc = unorm2_getNFCInstance(&error);
    if (U_FAILURE(error) || !nfc) return 4;
    const UChar decomposed[] = {0x65, 0x301};
    UChar composed[8];
    const int32_t length = unorm2_normalize(nfc, decomposed, 2, composed, 8, &error);
    if (U_FAILURE(error) || length != 1 || composed[0] != 0xe9) return 4;
    UCollator *collator = ucol_open("de", &error);
    if (U_FAILURE(error) || !collator) return 5;
    const UChar a_umlaut[] = {0xe4};
    const UChar z[] = {0x7a};
    const bool ordered = ucol_strcoll(collator, a_umlaut, 1, z, 1) == UCOL_LESS;
    ucol_close(collator);
    u_cleanup();
    if (!ordered) return 6;
    std::puts("Actual ICU shared data, normalization and collation: PASS");
    return 0;
}
