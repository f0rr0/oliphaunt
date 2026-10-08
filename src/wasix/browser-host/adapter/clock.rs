//! Fast browser clocks for the sealed, single-realm embedded PostgreSQL host.
//! WASIX remains the authority for clock adjustments and pending work.
use wasm_bindgen::{JsValue, prelude::wasm_bindgen};
use wasmer::{Extern, Function, Imports, Module, StoreMut, js::AsJs};
use wasmer_wasix::runtime::{InstantiationHook, InstantiationState};

#[wasm_bindgen(inline_js = r#"
const clockStates = new WeakMap();
function clockState(memory) {
    let state = clockStates.get(memory);
    if (state === undefined) {
        state = { canonical: false };
        clockStates.set(memory, state);
    }
    return state;
}
export function oliphauntDirectClockImport(memory, fallback) {
    const state = clockState(memory);
    const MAX_CANONICAL_INTERVAL_MILLIS = 16;
    // Coarsened or stalled clock sources must not suppress
    // canonical checkpoints forever.
    const MAX_DIRECT_READS_BETWEEN_FALLBACKS = 1024;
    const MAX_CANONICAL_NANOSECONDS = 9223372036854775807n;
    let lastRealtimeFallbackMillis;
    let lastMonotonicFallbackMillis;
    let realtimeDirectReadsSinceFallback = 0;
    let monotonicDirectReadsSinceFallback = 0;
    let monotonicAnchor;
    let buffer = memory.buffer;
    let view = new DataView(buffer);

    function sampleRealtimeMillis() {
        const millis = Date.now();
        return Number.isFinite(millis) && millis >= 0 ? millis : undefined;
    }

    function samplePerformanceMillis() {
        const performanceObject = globalThis.performance;
        if (performanceObject === undefined || typeof performanceObject.now !== "function") {
            return undefined;
        }
        const millis = performanceObject.now();
        return Number.isFinite(millis) && millis >= 0 ? millis : undefined;
    }

    function refreshView(timePointer) {
        let pointer;
        if (typeof timePointer === "bigint") {
            if (timePointer < 0n || timePointer > BigInt(Number.MAX_SAFE_INTEGER)) {
                return undefined;
            }
            pointer = Number(timePointer);
        } else if (typeof timePointer === "number" && Number.isInteger(timePointer)) {
            pointer = timePointer >>> 0;
        } else {
            return undefined;
        }

        if (buffer !== memory.buffer) {
            buffer = memory.buffer;
            view = new DataView(buffer);
        }
        return pointer <= buffer.byteLength - 8 ? pointer : undefined;
    }

    function callFallback(clockId, precision, timePointer) {
        const errno = fallback(clockId, precision, timePointer);
        if (clockId === 0) {
            realtimeDirectReadsSinceFallback = 0;
            lastRealtimeFallbackMillis =
                errno === 0 ? sampleRealtimeMillis() : undefined;
        } else if (clockId === 1) {
            monotonicDirectReadsSinceFallback = 0;
            const sampledMonotonicMillis =
                errno === 0 ? samplePerformanceMillis() : undefined;
            lastMonotonicFallbackMillis = sampledMonotonicMillis;
            const pointer = errno === 0 ? refreshView(timePointer) : undefined;
            monotonicAnchor =
                sampledMonotonicMillis !== undefined && pointer !== undefined
                    ? {
                        millis: sampledMonotonicMillis,
                        nanoseconds: view.getBigUint64(pointer, true),
                    }
                    : undefined;
        }
        return errno;
    }

    return function clock_time_get(clockId, precision, timePointer) {
        if (state.canonical) return fallback(clockId, precision, timePointer);
        let nanoseconds;
        if (clockId === 0) {
            const realtimeMillis = sampleRealtimeMillis();
            if (realtimeMillis === undefined ||
                lastRealtimeFallbackMillis === undefined ||
                realtimeMillis < lastRealtimeFallbackMillis ||
                realtimeDirectReadsSinceFallback >= MAX_DIRECT_READS_BETWEEN_FALLBACKS ||
                realtimeMillis - lastRealtimeFallbackMillis >= MAX_CANONICAL_INTERVAL_MILLIS) {
                return callFallback(clockId, precision, timePointer);
            }
            nanoseconds = BigInt(Math.trunc(realtimeMillis)) * 1000000n;
        } else if (clockId === 1) {
            const monotonicMillis = samplePerformanceMillis();
            if (monotonicMillis === undefined ||
                lastMonotonicFallbackMillis === undefined ||
                monotonicMillis < lastMonotonicFallbackMillis ||
                monotonicDirectReadsSinceFallback >= MAX_DIRECT_READS_BETWEEN_FALLBACKS ||
                monotonicMillis - lastMonotonicFallbackMillis >= MAX_CANONICAL_INTERVAL_MILLIS ||
                monotonicAnchor === undefined ||
                monotonicMillis < monotonicAnchor.millis) {
                return callFallback(clockId, precision, timePointer);
            }
            nanoseconds = monotonicAnchor.nanoseconds +
                BigInt(Math.trunc((monotonicMillis - monotonicAnchor.millis) * 1000000));
        } else {
            return callFallback(clockId, precision, timePointer);
        }

        if (nanoseconds > MAX_CANONICAL_NANOSECONDS) {
            return callFallback(clockId, precision, timePointer);
        }

        const pointer = refreshView(timePointer);
        if (pointer === undefined) {
            return callFallback(clockId, precision, timePointer);
        }
        view.setBigUint64(pointer, nanoseconds, true);
        if (clockId === 0) {
            realtimeDirectReadsSinceFallback += 1;
        } else {
            monotonicDirectReadsSinceFallback += 1;
        }
        return 0;
    };
}

export function oliphauntClockSetImport(memory, fallback) {
    const state = clockState(memory);
    return function clock_time_set(clockId, time) {
        // Disable every reader before entering WASIX: pending work can reenter
        // another module. Even a failed attempt conservatively stays canonical.
        state.canonical = true;
        return fallback(clockId, time);
    };
}
"#)]
extern "C" {
    #[wasm_bindgen(js_name = oliphauntDirectClockImport)]
    fn direct_clock(memory: &JsValue, fallback: &JsValue) -> js_sys::Function;
    #[wasm_bindgen(js_name = oliphauntClockSetImport)]
    fn clock_set(memory: &JsValue, fallback: &JsValue) -> js_sys::Function;
}

/// Registered only by the direct PostgreSQL constructor, never command/tools
/// runtimes, journaling or guest-controlled threads. Functions remain local to
/// their own stores; only a mode bit is shared by modules using the same memory.
#[derive(Debug)]
pub(crate) struct DirectClockHook;

impl InstantiationHook for DirectClockHook {
    fn prepare_imports(
        &self,
        module: &Module,
        store: &mut StoreMut,
        imports: &mut Imports,
    ) -> anyhow::Result<InstantiationState> {
        let Some(Extern::Memory(memory)) = imports.get_export("env", "memory") else {
            // Modules without an imported memory retain ordinary WASIX clocks.
            return Ok(InstantiationState::empty());
        };
        let raw_memory = memory.as_jsvalue(store);
        for import in module.imports().filter(|import| {
            matches!(
                import.module(),
                "wasi_snapshot_preview1" | "wasi_unstable" | "wasix_32v1" | "wasix_64v1"
            ) && matches!(import.name(), "clock_time_get" | "clock_time_set")
        }) {
            let Some(Extern::Function(fallback)) =
                imports.get_export(import.module(), import.name())
            else {
                continue;
            };
            let function_type = fallback.ty(store);
            let raw_fallback = fallback.as_jsvalue(store);
            let wrapper = if import.name() == "clock_time_set" {
                clock_set(&raw_memory, &raw_fallback)
            } else {
                direct_clock(&raw_memory, &raw_fallback)
            };
            let function = Function::from_jsvalue(store, &function_type, wrapper.as_ref())
                .map_err(|error| {
                    anyhow::anyhow!("install {}.{}: {error:?}", import.module(), import.name())
                })?;
            imports.define(import.module(), import.name(), function);
        }
        Ok(InstantiationState::empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use wasmer::{Memory, Store};
    use wasmer_wasix::{Runtime, WasiEnvBuilder};

    // Import-only module: shared env.memory; get(i32,i64,i32)->i32 and
    // set(i32,i64)->i32, re-exported along with the memory. No guest compiler.
    fn clock_module() -> Vec<u8> {
        fn string(bytes: &mut Vec<u8>, value: &str) {
            bytes.push(value.len() as u8);
            bytes.extend_from_slice(value.as_bytes());
        }
        fn section(bytes: &mut Vec<u8>, id: u8, contents: &[u8]) {
            bytes.extend_from_slice(&[id, contents.len() as u8]);
            bytes.extend_from_slice(contents);
        }
        let mut bytes = b"\0asm\x01\0\0\0".to_vec();
        section(
            &mut bytes,
            1,
            &[
                2, 0x60, 3, 0x7f, 0x7e, 0x7f, 1, 0x7f, 0x60, 2, 0x7f, 0x7e, 1, 0x7f,
            ],
        );
        let mut imports = vec![3];
        string(&mut imports, "env");
        string(&mut imports, "memory");
        imports.extend_from_slice(&[2, 3, 16, 16]);
        for (namespace, name, ty) in [
            ("wasi_snapshot_preview1", "clock_time_get", 0),
            ("wasix_32v1", "clock_time_set", 1),
        ] {
            string(&mut imports, namespace);
            string(&mut imports, name);
            imports.extend_from_slice(&[0, ty]);
        }
        section(&mut bytes, 2, &imports);
        let mut exports = vec![3];
        for (name, kind, index) in [("memory", 2, 0), ("get", 0, 0), ("set", 0, 1)] {
            string(&mut exports, name);
            exports.extend_from_slice(&[kind, index]);
        }
        section(&mut bytes, 7, &exports);
        bytes
    }

    fn read_time(memory: &Memory, store: &Store) -> u64 {
        let mut bytes = [0; 8];
        memory.view(store).read(0, &mut bytes).unwrap();
        u64::from_le_bytes(bytes)
    }

    #[wasm_bindgen_test::wasm_bindgen_test]
    async fn real_wasix_clock_adjustments_remain_visible() {
        let mut runtime = super::super::runtime::runtime(Arc::new(
            super::super::caller_realm::CallerRealmTaskManager,
        ))
        .unwrap();
        runtime.with_instantiation_hook(DirectClockHook);
        let runtime = Arc::new(runtime);
        let mut store = Store::new(runtime.engine());
        let module = Module::new(&store, clock_module()).unwrap();
        let (instance, _env) = WasiEnvBuilder::new("clock-test")
            .runtime(runtime)
            .instantiate_async(module, &mut store)
            .await
            .unwrap();
        let get = instance
            .exports
            .get_typed_function::<(u32, u64, u32), u32>(&store, "get")
            .unwrap();
        let set = instance
            .exports
            .get_typed_function::<(u32, u64), u32>(&store, "set")
            .unwrap();
        let memory = instance.exports.get_memory("memory").unwrap();
        for clock_id in [0, 1] {
            assert_eq!(get.call(&mut store, clock_id, 0, 0).unwrap(), 0);
            let target = read_time(memory, &store) + 5_000_000_000;
            assert_eq!(set.call(&mut store, clock_id, target).unwrap(), 0);
            for _ in 0..8 {
                assert_eq!(get.call(&mut store, clock_id, 0, 0).unwrap(), 0);
                let observed = read_time(memory, &store);
                assert!(observed >= target && observed < target + 1_000_000_000);
            }
        }
    }
}
