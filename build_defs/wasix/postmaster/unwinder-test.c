int oliphaunt_wasmer_has_linked_libunwind(void);

#ifdef TEST_LINKED_LIBUNWIND
__attribute__((visibility("hidden")))
void __unw_add_dynamic_fde(unsigned long address) { (void)address; }
#endif

int main(void) {
#ifdef TEST_LINKED_LIBUNWIND
    return oliphaunt_wasmer_has_linked_libunwind() == 1 ? 0 : 1;
#else
    return oliphaunt_wasmer_has_linked_libunwind() == 0 ? 0 : 1;
#endif
}
