(module
  (import "wasi_snapshot_preview1" "fd_prestat_get" (func $prestat (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_prestat_dir_name" (func $name (param i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_open" (func $open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_read" (func $read (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_sync" (func $sync (param i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_close" (func $close (param i32) (result i32)))
  (memory (export "memory") 1)
  (data (i32.const 128) "probe.bin")
  (data (i32.const 160) "V8OK")
  (func (export "_start"))
  (func (export "prestat") (param i32) (result i32) local.get 0 i32.const 32 call $prestat)
  (func (export "name") (param i32 i32) (result i32) local.get 0 i32.const 256 local.get 1 call $name)
  (func (export "open") (param i32 i32 i64) (result i32)
    local.get 0 i32.const 0 i32.const 128 i32.const 9 local.get 1
    local.get 2 i64.const 0 i32.const 0 i32.const 0 call $open)
  (func (export "write") (param i32) (result i32)
    i32.const 16 i32.const 160 i32.store
    i32.const 20 i32.const 4 i32.store
    local.get 0 i32.const 16 i32.const 1 i32.const 8 call $write)
  (func (export "read") (param i32) (result i32)
    i32.const 16 i32.const 192 i32.store
    i32.const 20 i32.const 4 i32.store
    local.get 0 i32.const 16 i32.const 1 i32.const 8 call $read)
  (func (export "sync") (param i32) (result i32) local.get 0 call $sync)
  (func (export "close") (param i32) (result i32) local.get 0 call $close))
