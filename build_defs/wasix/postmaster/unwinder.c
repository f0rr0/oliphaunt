/* A statically linked LLVM unwinder can hide this symbol from dlsym. */
#if defined(__ELF__)
extern void __unw_add_dynamic_fde(unsigned long) __attribute__((weak));
#endif

int oliphaunt_wasmer_has_linked_libunwind(void)
{
#if defined(__ELF__)
    return __unw_add_dynamic_fde != 0;
#else
    return 0;
#endif
}
