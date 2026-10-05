/* Native Windows engine control. The WASIX signal-path adapter is tested
   separately in Rust. Capture an isolate through a host callback, then join
   the sender before releasing the Store; no private layout assumptions. */
typedef unsigned long long usize;
typedef unsigned int DWORD;
typedef unsigned short WCHAR;
typedef void *HANDLE;
typedef struct { usize size; void *data; } Vec;
#define IMP __declspec(dllimport)
IMP HANDLE __stdcall GetStdHandle(DWORD);
IMP int __stdcall WriteFile(HANDLE,const void*,DWORD,DWORD*,void*);
IMP void __stdcall ExitProcess(DWORD);
IMP void __stdcall Sleep(DWORD);
IMP usize __stdcall GetTickCount64(void);
IMP HANDLE __stdcall GetModuleHandleW(const WCHAR*);
IMP void *__stdcall GetProcAddress(HANDLE,const char*);
IMP HANDLE __stdcall CreateThread(void*,usize,DWORD(__stdcall*)(void*),void*,DWORD,DWORD*);
IMP DWORD __stdcall WaitForSingleObject(HANDLE,DWORD);
IMP int __stdcall CloseHandle(HANDLE);
IMP void *wee8_wasm_engine_new(void);
IMP void *wee8_wasm_store_new(void*);
IMP void wee8_wasm_store_delete(void*);
IMP void *wee8_wasm_functype_new(Vec*,Vec*);
IMP void wee8_wasm_functype_delete(void*);
IMP void *wee8_wasm_func_new(void*,const void*,void*(*)(const Vec*,Vec*));
IMP void *wee8_wasm_func_as_extern(void*);
IMP void *wee8_wasm_module_new(void*,const Vec*);
IMP void wee8_wasm_module_delete(void*);
IMP void *wee8_wasm_instance_new(void*,const void*,const Vec*,void**);
IMP void wee8_wasm_instance_exports(const void*,Vec*);
IMP void *wee8_wasm_extern_as_func(void*);
IMP void wee8_wasm_val_vec_new_uninitialized(Vec*,usize);
IMP void wee8_wasm_val_vec_delete(Vec*);
IMP void *wee8_wasm_func_call(const void*,const Vec*,Vec*);
IMP void wee8_wasm_trap_delete(void*);

static void print(const char *s) {
  DWORD done; usize n=0; while(s[n]) n++;
  WriteFile(GetStdHandle((DWORD)-11),s,(DWORD)n,&done,0);
}
static void number(usize value) {
  char out[32]; unsigned n=0;
  do { out[n++]=(char)('0'+value%10); value/=10; } while(value);
  for(unsigned i=0;i<n/2;i++) { char c=out[i]; out[i]=out[n-1-i]; out[n-1-i]=c; }
  out[n]=0; print(out);
}
static void fail(const char *s) { print(s); print("\n"); ExitProcess(10); }
static void *(*current_isolate)(void);
static void (*interrupt_isolate)(void*);
static void *volatile captured_isolate;
static void *capture(const Vec *args,Vec *results) {
  (void)args; (void)results;
  captured_isolate=current_isolate();
  if(!captured_isolate) fail("callback has no current isolate");
  return 0;
}
static DWORD __stdcall sender(void *unused) {
  (void)unused; usize start=GetTickCount64();
  while(!captured_isolate) {
    if(GetTickCount64()-start>2000) fail("isolate capture timed out");
    Sleep(1);
  }
  Sleep(250);
  interrupt_isolate(captured_isolate);
  return 0;
}
/* (module (import "env" "capture" (func)) (memory (export "memory") 1 1 shared)
   (func (export "wait") (result i32) call 0
     i32.const 0 i32.const 0 i64.const -1 memory.atomic.wait32)) */
static unsigned char guest[]={
  0,97,115,109,1,0,0,0,
  1,8,2,96,0,0,96,0,1,127,
  2,15,1,3,101,110,118,7,99,97,112,116,117,114,101,0,0,
  3,2,1,1,
  5,4,1,3,1,1,
  7,17,2,6,109,101,109,111,114,121,2,0,4,119,97,105,116,0,1,
  10,16,1,14,0,16,0,65,0,65,0,66,127,254,1,2,0,11
};
void mainCRTStartup(void) {
  HANDLE dll=GetModuleHandleW((const WCHAR*)L"oliphaunt_wee8.dll");
  if(!dll) fail("engine DLL missing");
  current_isolate=(void*(*)(void))GetProcAddress(dll,"?GetCurrent@Isolate@v8@@SAPEAV12@XZ");
  interrupt_isolate=(void(*)(void*))GetProcAddress(dll,"?TerminateExecution@Isolate@v8@@QEAAXXZ");
  if(!current_isolate || !interrupt_isolate) fail("pinned public V8 methods missing");
  void *engine=wee8_wasm_engine_new();
  if(!engine) fail("engine creation failed");
  for(unsigned cycle=1;cycle<=20;cycle++) {
    void *store=wee8_wasm_store_new(engine);
    if(!store) fail("store creation failed");
    Vec none={0,0}, code={sizeof(guest),guest};
    void *type=wee8_wasm_functype_new(&none,&none);
    void *host=wee8_wasm_func_new(store,type,capture);
    wee8_wasm_functype_delete(type);
    void *module=wee8_wasm_module_new(store,&code);
    if(!host || !module) fail("host function or module failed");
    void *external=wee8_wasm_func_as_extern(host), *trap=0;
    Vec imports={1,&external};
    void *instance=wee8_wasm_instance_new(store,module,&imports,&trap);
    if(!instance || trap) fail("instance creation failed");
    Vec exports; wee8_wasm_instance_exports(instance,&exports);
    if(exports.size!=2) fail("incorrect exports");
    void *wait=wee8_wasm_extern_as_func(((void**)exports.data)[1]);
    Vec results; wee8_wasm_val_vec_new_uninitialized(&results,1);
    captured_isolate=0;
    HANDLE thread=CreateThread(0,0,sender,0,0,0);
    if(!thread) fail("sender creation failed");
    usize start=GetTickCount64();
    trap=wee8_wasm_func_call(wait,&none,&results);
    usize elapsed=GetTickCount64()-start;
    if(WaitForSingleObject(thread,2000)!=0) fail("sender join failed");
    CloseHandle(thread);
    if(!trap || elapsed>2000) fail("indefinite wait was not interrupted promptly");
    wee8_wasm_trap_delete(trap);
    wee8_wasm_val_vec_delete(&results);
    wee8_wasm_module_delete(module);
    captured_isolate=0;
    /* C entity handles here are Store-rooted and their raw C alias owners are
       not part of the Rust ownership regression. This control tests interruption. */
    wee8_wasm_store_delete(store);
    print("native_wait_cycle="); number(cycle);
    print(" elapsed_ms="); number(elapsed); print(" store_dropped=PASS\n");
  }
  print("native_indefinite_wait_interruption=PASS cycles=20\n");
  ExitProcess(0);
}
