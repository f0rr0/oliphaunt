(module
  (func (export "target") (param i32) (result i32)
    local.get 0 i32.const 1 i32.add)
  (func (export "identity") (param funcref) (result funcref)
    local.get 0)
  (func (export "consume") (param funcref) (result i32)
    local.get 0 drop i32.const 7))
