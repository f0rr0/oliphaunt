/* The maintained WASIX PostGIS dependency module lives for the process.
 * Its C++ objects have no separate thread-local destructor lifecycle.
 * Kept from src/extensions/external/postgis/tools/build_wasix.sh.
 */
__attribute__((visibility("hidden"))) void _ZTH5errno(void) {}

__attribute__((visibility("hidden"))) int __cxa_thread_atexit_impl(
    void (*destructor)(void *), void *object, void *dso_symbol)
{
    (void)destructor;
    (void)object;
    (void)dso_symbol;
    return 0;
}
