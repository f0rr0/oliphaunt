/* Reject a mismatched device/simulator SDK before admitting mobile PG objects. */
#include <TargetConditionals.h>
#include "pg_config.h"

#if !TARGET_OS_IOS || !TARGET_CPU_ARM64 || TARGET_OS_MACCATALYST
#error "The native iOS profile requires an arm64 iOS SDK"
#endif

#ifndef OLIPHAUNT_EXPECT_IOS_SIMULATOR
#error "The iOS configuration must declare its device/simulator role"
#endif

#if TARGET_OS_SIMULATOR != OLIPHAUNT_EXPECT_IOS_SIMULATOR
#error "The native iOS profile selected the wrong device/simulator SDK"
#endif

#if !defined(USE_ICU) || USE_ICU != 1
#error "The native iOS PostgreSQL configuration requires ICU"
#endif
