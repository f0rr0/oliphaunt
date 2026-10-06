(module
  (import "env" "memory" (memory 1 1 shared))
  (func $start
    i32.const 0 i32.const 0 i32.load i32.const 1 i32.add i32.store)
  (start $start))
