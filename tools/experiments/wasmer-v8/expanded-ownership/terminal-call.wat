(module
  (import "env" "memory" (memory 1 1 shared))
  (func (export "wait") (param i64) (result i32)
    i32.const 0 i32.const 0 local.get 0 memory.atomic.wait32)
  (func (export "bump")
    i32.const 0 i32.const 0 i32.load i32.const 1 i32.add i32.store))
