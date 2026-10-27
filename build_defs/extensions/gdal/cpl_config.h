/* Target configuration for the pinned, static GDAL library.
 * The selected toolchain defines the ABI and platform, including cross builds.
 * Optional drivers, host probes and checkout/install paths are not inputs.
 */
#ifndef CPL_CONFIG_H
#define CPL_CONFIG_H

#define SIZEOF_INT 4
#ifdef _WIN32
#define SIZEOF_UNSIGNED_LONG 4
#define SIZEOF_LONG_INT 4
#define SIZEOF_VOIDP 8
#define SIZEOF_SIZE_T 8
#define VSI_STAT64_T __stat64
#define VSI_STAT64 _stat64
#ifndef CPL_DISABLE_STDCALL
#define CPL_STDCALL __stdcall
#endif
#else
#define SIZEOF_UNSIGNED_LONG __SIZEOF_LONG__
#define SIZEOF_LONG_INT __SIZEOF_LONG__
#define SIZEOF_VOIDP __SIZEOF_POINTER__
#define SIZEOF_SIZE_T __SIZEOF_SIZE_T__
#define VSI_STAT64_T stat
#define USE_GCC_VISIBILITY_FLAG 1
#endif

#if defined(__FLT16_MANT_DIG__)
#define HAVE__FLOAT16 1
#endif

#ifdef GDAL_COMPILATION
#define HAVE_LOCALE_H 1
#define HAVE_VSNPRINTF 1
#define HAVE_SHARED_MUTEX 1
#define ICONV_CPP_CONST

#ifdef _WIN32
#define CPL_MULTIPROC_WIN32 1
#define HAVE_DIRECT_H 1
#define CPL_DISABLE_DLL 1
#else
#define CPL_MULTIPROC_PTHREAD 1
#define HAVE_PTHREAD_MUTEX_RECURSIVE 1
#define HAVE_GCC_ATOMIC_BUILTINS 1
#define HAVE_GETCWD 1
#define HAVE_SYS_TYPES_H 1
#define HAVE_UNISTD_H 1
#define HAVE_POSIX_MEMALIGN 1
#define HAVE_CTIME_R 1
#define HAVE_LOCALTIME_R 1
#define HAVE_GMTIME_R 1
#define HAVE_USELOCALE 1
#define UNIX_STDIO_64 1
#define VSI_OPEN64 open
#define VSI_FTRUNCATE64 ftruncate
#define VSI_LSEEK64 lseek
#define VSI_STAT64 stat
#if defined(__SIZEOF_INT128__)
#define HAVE_UINT128_T 1
#endif
#if !defined(__wasi__)
#define HAVE_DLFCN_H 1
#define HAVE_GETRLIMIT 1
#define HAVE_RLIMIT_AS 1
#define HAVE_MMAP 1
#define HAVE_SIGACTION 1
#define HAVE_STATVFS 1
#define HAVE_SC_PHYS_PAGES 1
#endif
#if defined(__linux__) && !defined(__ANDROID__)
#define VSI_NEED_LARGEFILE64_SOURCE 1
#define HAVE_PTHREAD_SPIN_LOCK 1
#define HAVE_PTHREAD_ATFORK 1
#define HAVE_PTHREAD_MUTEX_ADAPTIVE_NP 1
#define HAVE_SYS_RANDOM_H 1
#define HAVE_GETRANDOM 1
#define HAVE_DL_ITERATE_PHDR 1
#define HAVE_SCHED_GETAFFINITY 1
#endif
#endif
#endif /* GDAL_COMPILATION */
#endif /* CPL_CONFIG_H */
