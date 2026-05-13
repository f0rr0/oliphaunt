set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

default:
    @just --list

fmt:
    cargo fmt --all

check:
    cargo check --workspace --locked

test-compile:
    cargo test --workspace --all-targets --locked --no-run

validate mode="dev":
    tools/scripts/validate.sh {{mode}}

native-build:
    libpglite/bin/build-postgres18-macos.sh

native-smoke:
    libpglite/bin/smoke-macos-happy-path.sh

wasix-assets-check:
    cargo run -p xtask -- assets verify-committed
