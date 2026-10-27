#define LIBWASM_STATIC
#include "wasm.hh"
namespace wasm {
template <> class Shared<Memory> {
  friend class destroyer;
  void destroy();
protected:
  Shared() = default;
  ~Shared() = default;
};
}
extern "C" void research_store_delete(wasm::Store* p) {
  if (p) wasm::destroyer{}(p);
}
extern "C" void research_shared_memory_delete(wasm::Shared<wasm::Memory>* p) {
  if (p) wasm::destroyer{}(p);
}
extern "C" void research_shared_module_delete(wasm::Shared<wasm::Module>* p) {
  if (p) wasm::destroyer{}(p);
}
extern "C" void research_functype_delete(wasm::FuncType* p) {
  if (p) wasm::destroyer{}(p);
}
extern "C" void research_module_delete(wasm::Module* p) {
  if (p) wasm::destroyer{}(p);
}
extern "C" void research_ref_delete(wasm::Ref* p) {
  if (p) wasm::destroyer{}(p);
}
extern "C" void research_extern_delete(wasm::Extern* p) {
  if (p) wasm::destroyer{}(p);
}
extern "C" void research_valtype_delete(wasm::ValType* p) {
  if (p) wasm::destroyer{}(p);
}
extern "C" void research_memorytype_delete(wasm::MemoryType* p) {
  if (p) wasm::destroyer{}(p);
}
extern "C" void research_globaltype_delete(wasm::GlobalType* p) {
  if (p) wasm::destroyer{}(p);
}
extern "C" void research_tabletype_delete(wasm::TableType* p) {
  if (p) wasm::destroyer{}(p);
}
extern "C" void research_trap_delete(wasm::Trap* p) {
  if (p) wasm::destroyer{}(p);
}
extern "C" void research_externtype_delete(wasm::ExternType* p) {
  if (p) wasm::destroyer{}(p);
}
// Pinned V8's C wasm_func_call adopts and destroys its const argument array.
// Borrow it instead: Wasmer owns and reuses that array across WASIX reentry.
struct ResearchValues { size_t size; wasm::Val* data; };
struct ResearchBorrowedValues {
  wasm::vec<wasm::Val> values;
  ~ResearchBorrowedValues() { values.release(); }
};
extern "C" wasm::Trap* research_func_call(const wasm::Func* func,
    const ResearchValues* args, ResearchValues* results) {
  ResearchBorrowedValues borrowed{wasm::vec<wasm::Val>::adopt(args->size, args->data)};
  auto values = wasm::vec<wasm::Val>::adopt(results->size, results->data);
  auto trap = func->call(borrowed.values, values);
  *results = {values.size(), values.release()};
  return trap.release();
}
