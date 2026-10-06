(module
        (import "env" "memory" (memory 1 1 shared))
        (export "memory" (memory 0))
        (func (export "wait") (param i64) (result i32)
          i32.const 0 i32.const 0 local.get 0 memory.atomic.wait32))
