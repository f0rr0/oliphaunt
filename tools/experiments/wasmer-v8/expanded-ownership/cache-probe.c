/* Producer-only Windows V8 cache control. No CRT or Windows SDK needed. */
typedef unsigned long long usize;
typedef unsigned int DWORD;
typedef unsigned short WCHAR;
typedef void *HANDLE;
typedef struct { usize size; unsigned char *data; } Vec;
#define IMP __declspec(dllimport)
IMP HANDLE __stdcall GetStdHandle(DWORD);
IMP HANDLE __stdcall CreateFileW(const WCHAR *, DWORD, DWORD, void *, DWORD, DWORD, HANDLE);
IMP int __stdcall ReadFile(HANDLE, void *, DWORD, DWORD *, void *);
IMP int __stdcall WriteFile(HANDLE, const void *, DWORD, DWORD *, void *);
IMP int __stdcall GetFileSizeEx(HANDLE, long long *);
IMP int __stdcall CloseHandle(HANDLE);
IMP WCHAR *__stdcall GetCommandLineW(void);
IMP void __stdcall ExitProcess(DWORD);
IMP void research_set_v8_flags(const char *, usize);
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

static void print(const char *s) {
  DWORD done; usize n=0; while(s[n]) n++;
  WriteFile(GetStdHandle((DWORD)-11),s,(DWORD)n,&done,0);
}
static void number(usize value, int hex) {
  char out[32]; unsigned n=0, base=hex?16:10;
  do { unsigned d=value%base; out[n++]=(char)(d<10?'0'+d:'a'+d-10); value/=base; } while(value);
  if(hex) print("0x");
  for(unsigned i=0;i<n/2;i++) { char c=out[i]; out[i]=out[n-1-i]; out[n-1-i]=c; }
  out[n]=0; print(out);
}
static void fail(const char *s, DWORD code) { print(s); print("\n"); ExitProcess(code); }
static Vec read(const WCHAR *path) {
  HANDLE f=CreateFileW(path,0x80000000,1,0,3,0,0);
  long long size=0; DWORD got=0; Vec v;
  if(f==(HANDLE)-1 || !GetFileSizeEx(f,&size) || size<=0 || size>0x7fffffff) fail("read open/size failed",10);
  wee8_wasm_byte_vec_new_uninitialized(&v,(usize)size);
  if(!ReadFile(f,v.data,(DWORD)size,&got,0) || got!=size) fail("read bytes failed",11);
  CloseHandle(f); return v;
}
static void write(const WCHAR *path, const Vec *v) {
  HANDLE f=CreateFileW(path,0x40000000,0,0,2,0,0); DWORD done=0;
  if(f==(HANDLE)-1 || !WriteFile(f,v->data,(DWORD)v->size,&done,0) || done!=v->size) fail("write failed",12);
  CloseHandle(f);
}
void mainCRTStartup(void) {
  static const char flags[]="--mcpu=generic --no-enable-sse4-2 --no-enable-sahf --no-enable-avx --no-enable-avx2 --no-enable-avx-vnni --no-enable-avx-vnni-int8 --no-enable-fma3 --no-enable-f16c --no-enable-bmi1 --no-enable-bmi2 --no-enable-lzcnt --no-enable-popcnt --no-intel-jcc-erratum-mitigation";
  research_set_v8_flags(flags,sizeof(flags)-1);
  int reader=0; const WCHAR *cmd=GetCommandLineW();
  for(usize i=0;cmd[i];i++) if(cmd[i]==' ' && cmd[i+1]=='r' && cmd[i+2]=='e' && cmd[i+3]=='a' && cmd[i+4]=='d') reader=1;
  print(reader?"operation=read\n":"operation=write\n");
  void *engine=wee8_wasm_engine_new(), *store=wee8_wasm_store_new(engine);
  if(!engine || !store) fail("engine/store failed",20);
  Vec data=read(reader?(const WCHAR*)L"cache.bin":(const WCHAR*)L"guest.wasm");
  if(!reader) {
    void *m=wee8_wasm_module_new(store,&data);
    if(!m) fail("compile failed",21);
    Vec cache; wee8_wasm_module_serialize(m,&cache);
    wee8_wasm_module_delete(m); wee8_wasm_byte_vec_delete(&data);
    data=cache; write((const WCHAR*)L"cache.bin",&data);
  }
  usize p=0, wire=0; unsigned shift=0;
  do { if(p>=data.size || shift>63) fail("invalid wire length",22);
       unsigned c=data.data[p++]; wire|=(usize)(c&127)<<shift; shift+=7;
       if(!(c&128)) break; } while(1);
  if(wire>data.size-p || data.size-p-wire<20) fail("missing native cache",23);
  usize offset=p+wire;
  print("native_bytes="); number(data.size-offset,0);
  print(" cpu_mask="); number(*(DWORD*)(data.data+offset+8),1);
  print(" flag_hash="); number(*(DWORD*)(data.data+offset+12),1); print("\n");
  void *module=wee8_wasm_module_deserialize(store,&data);
  if(!module) fail("native_deserialize=REJECT",24);
  print("native_deserialize=PASS (no compilation fallback)\n");
  wee8_wasm_module_delete(module); wee8_wasm_byte_vec_delete(&data);
  wee8_wasm_store_delete(store); wee8_wasm_engine_delete(engine);
  ExitProcess(0);
}
