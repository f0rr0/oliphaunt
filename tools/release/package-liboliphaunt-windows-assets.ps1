param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Root = git rev-parse --show-toplevel
if ($LASTEXITCODE -ne 0 -or -not $Root) {
    $Root = (Get-Location).Path
}
Set-Location $Root

function Fail($Message) {
    Write-Error "package-liboliphaunt-windows-assets.ps1: $Message"
    exit 1
}

function Assert-BaseRuntimeHasNoOptionalExtensions($CatalogFile, $RuntimeRoot) {
    $extensionDir = Join-Path $RuntimeRoot "share/postgresql/extension"
    $moduleDir = Join-Path $RuntimeRoot "lib/postgresql"
    $failures = New-Object System.Collections.Generic.List[string]
    $rows = Get-Content $CatalogFile | Select-Object -Skip 1
    foreach ($row in $rows) {
        if (-not $row) {
            continue
        }
        $columns = $row -split "`t", 12
        if ($columns.Count -lt 12) {
            Fail "malformed extension catalog row in $CatalogFile`: $row"
        }
        $sqlName = $columns[0]
        $stem = $columns[3]
        $dataFiles = $columns[10]
        if (Test-Path (Join-Path $extensionDir "$sqlName.control")) {
            $failures.Add("control:$sqlName") | Out-Null
        }
        if ($stem -and $stem -ne "-") {
            foreach ($suffix in @("dll", "so", "dylib")) {
                if (Test-Path (Join-Path $moduleDir "$stem.$suffix")) {
                    $failures.Add("module:$stem.$suffix") | Out-Null
                }
            }
        }
        if ($dataFiles -and $dataFiles -ne "-") {
            foreach ($dataFile in $dataFiles.Split(",")) {
                if ($dataFile -and (Test-Path (Join-Path (Join-Path $RuntimeRoot "share/postgresql") $dataFile))) {
                    $failures.Add("data:$dataFile") | Out-Null
                }
            }
        }
    }
    if ($failures.Count -gt 0) {
        $joined = [string]::Join(", ", $failures)
        Fail "base Windows liboliphaunt runtime contains optional extension artifact(s): $joined"
    }
}

if (-not $IsWindows) {
    Fail "Windows liboliphaunt release assets must be built on Windows"
}

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Fail "missing required command: bun"
}

if ($env:OLIPHAUNT_RELEASE_FETCH_ASSETS -ne "0") {
    Write-Output "==> Fetching pinned source assets"
    bun tools/policy/fetch-sources.mjs native-runtime *> "$env:TEMP\liboliphaunt-release-windows-assets-fetch.log"
    if ($LASTEXITCODE -ne 0) {
        Fail "failed to fetch pinned source assets"
    }
}

$Version = bun tools/release/product-version.mjs version liboliphaunt-native
if ($LASTEXITCODE -ne 0 -or -not $Version) {
    Fail "failed to read liboliphaunt version"
}
$Version = $Version.Trim()
$TargetId = "windows-x64-msvc"
$OutDir = if ($env:OLIPHAUNT_LIBOLIPHAUNT_RELEASE_ASSETS) {
    $env:OLIPHAUNT_LIBOLIPHAUNT_RELEASE_ASSETS
} else {
    Join-Path $Root "target/liboliphaunt/release-assets"
}
$StageRoot = Join-Path $Root "target/liboliphaunt/release-stage-$TargetId"
$CatalogFile = Join-Path $StageRoot "extension-catalog.tsv"
$WorkRoot = if ($env:OLIPHAUNT_WINDOWS_WORK_ROOT) {
    $env:OLIPHAUNT_WINDOWS_WORK_ROOT
} elseif ($env:OLIPHAUNT_WORK_ROOT) {
    $env:OLIPHAUNT_WORK_ROOT
} else {
    Join-Path $Root "target/liboliphaunt-pg18-$TargetId"
}
$HeadersDir = Join-Path $Root "src/runtimes/liboliphaunt/native/include"
$Dll = Join-Path $WorkRoot "out/bin/oliphaunt.dll"
$ImportLib = Join-Path $WorkRoot "out/lib/oliphaunt.lib"
$EmbeddedModules = Join-Path $WorkRoot "out/modules"
$Runtime = Join-Path $WorkRoot "install"
$Stage = Join-Path $StageRoot "liboliphaunt-$Version-$TargetId"
$Asset = "liboliphaunt-$Version-$TargetId.zip"
$ToolsStage = Join-Path $StageRoot "oliphaunt-tools-$Version-$TargetId"
$ToolsAsset = "oliphaunt-tools-$Version-$TargetId.zip"

Remove-Item -Recurse -Force $StageRoot -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $OutDir, (Join-Path $Stage "include"), (Join-Path $Stage "bin"), (Join-Path $Stage "lib"), (Join-Path $Stage "lib/modules"), (Join-Path $Stage "runtime"), (Join-Path $ToolsStage "runtime/bin") | Out-Null

Write-Output "==> Building liboliphaunt $TargetId"
pwsh -NoProfile -ExecutionPolicy Bypass -File src/runtimes/liboliphaunt/native/bin/build-postgres18-windows.ps1 *> "$env:TEMP\liboliphaunt-release-$TargetId.log"
if ($LASTEXITCODE -ne 0) {
    Get-Content "$env:TEMP\liboliphaunt-release-$TargetId.log" -Tail 160 | Write-Error
    Fail "failed to build liboliphaunt $TargetId"
}

if (-not (Test-Path $Dll)) {
    Fail "missing Windows liboliphaunt DLL at $Dll"
}
if (-not (Test-Path $ImportLib)) {
    Fail "missing Windows liboliphaunt import library at $ImportLib"
}
if (-not (Test-Path (Join-Path $EmbeddedModules "plpgsql.dll"))) {
    Fail "missing Windows embedded plpgsql module at $(Join-Path $EmbeddedModules "plpgsql.dll")"
}
foreach ($Tool in @("initdb.exe", "pg_ctl.exe", "pg_dump.exe", "postgres.exe", "psql.exe")) {
    $ToolPath = Join-Path (Join-Path $Runtime "bin") $Tool
    if (-not (Test-Path $ToolPath)) {
        Fail "missing Windows $Tool at $ToolPath"
    }
}

Write-Output "==> Verifying base liboliphaunt $TargetId runtime is extension-clean"
cargo run -p oliphaunt --bin oliphaunt-resources --locked -- --list-extensions > $CatalogFile
if ($LASTEXITCODE -ne 0) {
    Fail "failed to read exact extension catalog"
}
Assert-BaseRuntimeHasNoOptionalExtensions $CatalogFile $Runtime

Copy-Item -Recurse -Force (Join-Path $HeadersDir "*") (Join-Path $Stage "include")
Copy-Item -Force $Dll (Join-Path $Stage "bin")
Copy-Item -Force $ImportLib (Join-Path $Stage "lib")
Copy-Item -Recurse -Force (Join-Path $EmbeddedModules "*") (Join-Path $Stage "lib/modules")
Copy-Item -Recurse -Force (Join-Path $Runtime "*") (Join-Path $Stage "runtime")
foreach ($Tool in @("pg_dump.exe", "psql.exe")) {
    Copy-Item -Force (Join-Path (Join-Path $Runtime "bin") $Tool) (Join-Path (Join-Path $ToolsStage "runtime/bin") $Tool)
}
$StagedIcu = Join-Path $Stage "runtime/share/icu"
if (Test-Path $StagedIcu) {
    Remove-Item -Recurse -Force $StagedIcu
}

Write-Output "==> Optimizing staged liboliphaunt $TargetId release payload"
bun tools/release/optimize_native_runtime_payload.mjs $Stage --target $TargetId --tool-set runtime
if ($LASTEXITCODE -ne 0) {
    Fail "failed to optimize staged Windows liboliphaunt release payload"
}

Write-Output "==> Optimizing staged oliphaunt-tools $TargetId release payload"
bun tools/release/optimize_native_runtime_payload.mjs $ToolsStage --target $TargetId --tool-set tools
if ($LASTEXITCODE -ne 0) {
    Fail "failed to optimize staged Windows oliphaunt-tools release payload"
}

Write-Output "==> Smoke testing staged liboliphaunt $TargetId release layout"
$SmokeRoot = Join-Path $env:TEMP "liboliphaunt-release-smoke-$TargetId"
Remove-Item -Recurse -Force $SmokeRoot -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $SmokeRoot | Out-Null
$env:OLIPHAUNT_WORK_ROOT = $WorkRoot
$env:LIBOLIPHAUNT_PATH = Join-Path $Stage "bin/oliphaunt.dll"
$env:OLIPHAUNT_INSTALL_DIR = Join-Path $Stage "runtime"
$env:OLIPHAUNT_SMOKE_BIN_DIR = Join-Path $StageRoot "smoke-bin-$TargetId"
$env:OLIPHAUNT_SMOKE_ROOT = $SmokeRoot
node src/runtimes/liboliphaunt/native/tools/run-host-c-smoke.mjs
if ($LASTEXITCODE -ne 0) {
    Fail "staged Windows liboliphaunt release smoke failed"
}

bun tools/release/archive_dir.mjs $Stage (Join-Path $OutDir $Asset)
if ($LASTEXITCODE -ne 0) {
    Fail "failed to archive Windows liboliphaunt asset"
}
bun tools/release/archive_dir.mjs $ToolsStage (Join-Path $OutDir $ToolsAsset)
if ($LASTEXITCODE -ne 0) {
    Fail "failed to archive Windows oliphaunt-tools asset"
}
Write-Output "liboliphauntWindowsReleaseAsset=$(Join-Path $OutDir $Asset)"
Write-Output "oliphauntToolsWindowsReleaseAsset=$(Join-Path $OutDir $ToolsAsset)"
