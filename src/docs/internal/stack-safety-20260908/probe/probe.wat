(module
  (import "env" "headroom" (func $headroom (result i64)))
  (tag $error (param i32))
  (func $unchecked (param $n i32) (result i32)
    local.get $n
    i32.eqz
    if
      i32.const 42
      throw $error
    end
    local.get $n
    i32.const 1
    i32.sub
    call $unchecked
    i32.const 1
    i32.add)
  (func $descend (param $extra i32) (result i32)
    call $headroom
    i64.const 98304
    i64.lt_u
    if (result i32)
      local.get $extra
      call $unchecked
    else
      local.get $extra
      call $descend
      i32.const 1
      i32.add
    end)
  (func (export "run") (param $extra i32) (result i32)
    block $caught (result i32)
      try_table (result i32) (catch $error $caught)
        local.get $extra
        call $descend
      end
      return
    end)
  (func (export "rethrow") (result i32)
    block $caught (result i32)
      try_table (result i32) (catch $error $caught)
        block $reference (result i32 exnref)
          try_table (catch_ref $error $reference)
            i32.const 42
            throw $error
          end
          unreachable
        end
        throw_ref
      end
      return
    end))
