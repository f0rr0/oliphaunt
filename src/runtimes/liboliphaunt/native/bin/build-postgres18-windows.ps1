param(
    [Alias("check-current")]
    [switch]$CheckCurrent
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = $null
try {
    $RepoRoot = & git -C $ScriptDir rev-parse --show-toplevel 2>$null
} catch {
    $RepoRoot = $null
}
if (-not $RepoRoot) {
    $RepoRoot = (Resolve-Path (Join-Path $ScriptDir "../../../../..")).Path
} else {
    $RepoRoot = (Resolve-Path $RepoRoot).Path
}
$PgVersion = "18.4"
$PgSha256 = "81a81ec695fb0c7901407defaa1d2f7973617154cf27ba74e3a7ab8e64436094"
$PgUrl = "https://ftp.postgresql.org/pub/source/v$PgVersion/postgresql-$PgVersion.tar.bz2"
$PgUrls = @(
    $PgUrl,
    "https://fossies.org/linux/misc/postgresql-$PgVersion.tar.bz2"
)
$SourceManifest = Join-Path $RepoRoot "src/runtimes/liboliphaunt/native/postgres18/source.toml"
$PatchDir = Join-Path $RepoRoot "src/runtimes/liboliphaunt/native/patches/postgresql-$PgVersion"
$TargetId = "windows-x64-msvc"
$WorkRoot = if ($env:OLIPHAUNT_WINDOWS_WORK_ROOT) {
    $env:OLIPHAUNT_WINDOWS_WORK_ROOT
} elseif ($env:OLIPHAUNT_WORK_ROOT) {
    $env:OLIPHAUNT_WORK_ROOT
} else {
    Join-Path $RepoRoot "target/liboliphaunt-pg18-$TargetId"
}
$SourceCache = Join-Path $WorkRoot "source"
$Tarball = Join-Path $SourceCache "postgresql-$PgVersion.tar.bz2"
$BuildDir = Join-Path $WorkRoot "postgresql-$PgVersion"
$RuntimeBuildDir = Join-Path $WorkRoot "meson-runtime"
$EmbeddedBuildDir = Join-Path $WorkRoot "meson-embedded"
$RuntimeNativeFile = Join-Path $WorkRoot "meson-runtime-native.ini"
$EmbeddedNativeFile = Join-Path $WorkRoot "meson-embedded-native.ini"
$InstallDir = Join-Path $WorkRoot "install"
$OutDir = Join-Path $WorkRoot "out"
$ObjDir = Join-Path $OutDir "obj"
$DllOut = Join-Path $OutDir "bin/oliphaunt.dll"
$ImportLibOut = Join-Path $OutDir "lib/oliphaunt.lib"
$EmbeddedModulesDir = Join-Path $OutDir "modules"
$EmbeddedPlpgsqlDllOut = Join-Path $EmbeddedModulesDir "plpgsql.dll"
$VcRuntimeClosureTool = Join-Path $RepoRoot "tools/release/windows-vc-runtime-closure.mjs"
$Stamp = Join-Path $OutDir "oliphaunt-windows.inputs.sha256"
$ExternalCheckoutRoot = Join-Path $RepoRoot "target/oliphaunt-sources/checkouts"
$OpenSslSourceManifest = Join-Path $RepoRoot "src/sources/third-party/shared/openssl.toml"
$PgxsBuildPlan = Join-Path $RepoRoot "src/extensions/generated/pgxs-build.tsv"
$PortableUuidDir = Join-Path $RepoRoot "src/runtimes/liboliphaunt/native/portable-uuid"
$PortableUuidIncludeDir = Join-Path $PortableUuidDir "include"
$OpenSslDependencyPrefix = Join-Path $WorkRoot "windows-dependencies/openssl"
$PostgisDependencyPrefix = Join-Path $WorkRoot "windows-dependencies/postgis"
$OliphauntContribDir = Join-Path $BuildDir "contrib/oliphaunt_external"
$BuildExtensions = if ($env:OLIPHAUNT_BUILD_EXTENSIONS) { $env:OLIPHAUNT_BUILD_EXTENSIONS } else { "0" }
$NativeExtensionSqlNames = if ($env:OLIPHAUNT_NATIVE_EXTENSION_SQL_NAMES) {
    $env:OLIPHAUNT_NATIVE_EXTENSION_SQL_NAMES
} elseif ($env:OLIPHAUNT_EXTENSION_SQL_NAMES) {
    $env:OLIPHAUNT_EXTENSION_SQL_NAMES
} else {
    ""
}
$SelectedNativeExtensionSqlNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
foreach ($name in ($NativeExtensionSqlNames -split ",")) {
    $trimmed = $name.Trim()
    if ($trimmed) {
        [void]$SelectedNativeExtensionSqlNames.Add($trimmed)
    }
}
$ExactExtensionCatalogRows = $null

$LiboliphauntSources = @(
    "src/runtimes/liboliphaunt/native/src/liboliphaunt_native.c",
    "src/runtimes/liboliphaunt/native/src/liboliphaunt_runtime.c",
    "src/runtimes/liboliphaunt/native/src/liboliphaunt_protocol.c",
    "src/runtimes/liboliphaunt/native/src/liboliphaunt_bootstrap.c",
    "src/runtimes/liboliphaunt/native/src/liboliphaunt_process.c",
    "src/runtimes/liboliphaunt/native/src/liboliphaunt_trace.c",
    "src/runtimes/liboliphaunt/native/src/liboliphaunt_fs.c",
    "src/runtimes/liboliphaunt/native/src/liboliphaunt_archive.c",
    "src/runtimes/liboliphaunt/native/src/liboliphaunt_archive_tar.c",
    "src/runtimes/liboliphaunt/native/src/liboliphaunt_static_extensions.c",
    "src/runtimes/liboliphaunt/native/src/liboliphaunt_builtin_extensions.c"
) | ForEach-Object { Join-Path $RepoRoot $_ }

function Fail($Message) {
    Write-Error "build-postgres18-windows.ps1: $Message"
    exit 1
}

function Require-Command($Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        Fail "missing required command: $Name"
    }
}

function Normalize-PathEntry([string]$PathEntry) {
    $trimmed = $PathEntry.Trim().TrimEnd([char[]]@('\', '/'))
    if (-not $trimmed) {
        return ""
    }
    try {
        [System.IO.Path]::GetFullPath($trimmed).TrimEnd([char[]]@('\', '/')).ToLowerInvariant()
    } catch {
        $trimmed.ToLowerInvariant()
    }
}

function Set-ProcessPath([string[]]$Entries) {
    $seen = @{}
    $clean = New-Object System.Collections.Generic.List[string]
    foreach ($entry in $Entries) {
        if ([string]::IsNullOrWhiteSpace($entry)) {
            continue
        }
        $trimmed = $entry.Trim()
        $key = Normalize-PathEntry $trimmed
        if ($key -and -not $seen.ContainsKey($key)) {
            $seen[$key] = $true
            $clean.Add($trimmed) | Out-Null
        }
    }
    Set-Item -Path Env:Path -Value ([string]::Join(";", $clean))
}

function Prepend-ProcessPath([string[]]$Entries) {
    Set-ProcessPath (@($Entries) + @($env:Path -split ";"))
}

function Is-MsysToolPath([string]$PathEntry) {
    $normalized = Normalize-PathEntry $PathEntry
    return $normalized -match '\\git\\usr\\bin$' -or
        $normalized -match '\\git\\mingw64\\bin$' -or
        $normalized -match '\\mingw64\\bin$'
}

function Resolve-ApplicationPath([string]$Name) {
    $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $command) {
        Fail "missing required command: $Name"
    }
    $command.Source
}

function Get-PythonCommand {
    $python = Get-Command python -ErrorAction SilentlyContinue
    if ($python) {
        return [PSCustomObject]@{
            Command = $python.Source
            Arguments = @()
        }
    }
    $py = Get-Command py -ErrorAction SilentlyContinue
    if ($py) {
        return [PSCustomObject]@{
            Command = $py.Source
            Arguments = @("-3")
        }
    }
    Fail "missing required command: python"
}

function Invoke-Python([string[]]$Arguments) {
    $python = Get-PythonCommand
    & $python.Command @($python.Arguments) @Arguments
    if ($LASTEXITCODE -ne 0) {
        Fail "python command failed: $($Arguments -join ' ')"
    }
}

function Add-PythonUserScriptsToPath {
    $python = Get-PythonCommand
    $script = @"
import os
import site
import sysconfig

paths = []
for scheme in (None, "nt_user"):
    try:
        path = sysconfig.get_path("scripts", scheme=scheme) if scheme else sysconfig.get_path("scripts")
    except Exception:
        path = None
    if path:
        paths.append(path)
user_base = getattr(site, "USER_BASE", None)
if user_base:
    paths.append(os.path.join(user_base, "Scripts"))
seen = set()
for path in paths:
    normalized = os.path.normcase(os.path.normpath(path))
    if normalized not in seen:
        seen.add(normalized)
        print(path)
"@
    $scriptPaths = & $python.Command @($python.Arguments) -c $script
    foreach ($scripts in $scriptPaths) {
        if ($scripts -and (Test-Path $scripts)) {
            Prepend-ProcessPath @($scripts)
        }
    }
}

function Ensure-MesonTools {
    Add-PythonUserScriptsToPath
    if (-not (Get-Command meson -ErrorAction SilentlyContinue) -or -not (Get-Command ninja -ErrorAction SilentlyContinue)) {
        Invoke-Python @("-m", "pip", "install", "--user", "meson==1.10.0", "ninja==1.13.0")
        Add-PythonUserScriptsToPath
    }
    Require-Command meson
    Require-Command ninja
}

function Import-MsvcEnvironment {
    if (Get-Command cl.exe -ErrorAction SilentlyContinue) {
        return
    }
    $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio/Installer/vswhere.exe"
    if (-not (Test-Path $vswhere)) {
        Fail "vswhere.exe was not found; install Visual Studio Build Tools with MSVC x64 tools"
    }
    $vsRoot = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $vsRoot) {
        Fail "Visual Studio Build Tools with MSVC x64 tools were not found"
    }
    $vsDevCmd = Join-Path $vsRoot "Common7/Tools/VsDevCmd.bat"
    if (-not (Test-Path $vsDevCmd)) {
        Fail "VsDevCmd.bat was not found at $vsDevCmd"
    }
    cmd.exe /s /c "`"$vsDevCmd`" -arch=x64 -host_arch=x64 >nul && set" |
        ForEach-Object {
            if ($_ -match "^(.*?)=(.*)$") {
                Set-Item -Path "Env:$($Matches[1])" -Value $Matches[2]
            }
        }
    Require-Command cl.exe
    Require-Command link.exe
    Require-Command dumpbin.exe
}

function Configure-MsvcToolchainPath {
    if (-not $env:VCToolsInstallDir) {
        Fail "VCToolsInstallDir is not set; run from an MSVC developer environment"
    }
    $msvcBin = Join-Path $env:VCToolsInstallDir "bin/HostX64/x64"
    $requiredTools = @("cl.exe", "link.exe", "lib.exe", "dumpbin.exe")
    foreach ($tool in $requiredTools) {
        $toolPath = Join-Path $msvcBin $tool
        if (-not (Test-Path $toolPath)) {
            Fail "MSVC tool was not found at $toolPath"
        }
    }

    $filteredPath = @($env:Path -split ";") | Where-Object { -not (Is-MsysToolPath $_) }
    Set-ProcessPath (@($msvcBin) + $filteredPath)

    foreach ($tool in $requiredTools) {
        $resolved = Resolve-ApplicationPath $tool
        if (-not $resolved.StartsWith($msvcBin, [System.StringComparison]::OrdinalIgnoreCase)) {
            Fail "$tool resolved to $resolved instead of the MSVC tool directory $msvcBin"
        }
    }

    $env:CC = "cl.exe"
    $env:CXX = "cl.exe"
    $env:AR = "lib.exe"
    Write-Host "Using MSVC tools from $msvcBin"
}

function Prefer-NativePerl {
    $candidateDirs = @(
        "C:\Strawberry\perl\bin",
        "C:\Perl64\bin"
    )
    foreach ($dir in $candidateDirs) {
        if (Test-Path (Join-Path $dir "perl.exe")) {
            Prepend-ProcessPath @($dir)
            break
        }
    }
    $perl = Get-Command perl.exe -ErrorAction SilentlyContinue
    if (-not $perl) {
        Fail "missing required command: perl.exe"
    }
    if ($perl.Source -like "*\Git\usr\bin\perl.exe") {
        Fail "Git/MSYS Perl cannot drive PostgreSQL's MSVC build because it rewrites native tool arguments; install Strawberry Perl or another native Windows Perl"
    }
}

function Get-FileSha256($Path) {
    (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLowerInvariant()
}

function Invoke-VcRuntimeClosure([string[]]$Arguments) {
    & bun $VcRuntimeClosureTool @Arguments
    if ($LASTEXITCODE -ne 0) {
        Fail "Windows x64 app-local VC runtime closure failed: $($Arguments -join ' ')"
    }
}

function Stage-VcRuntimeClosure {
    Invoke-VcRuntimeClosure @(
        "stage",
        "--root", $InstallDir,
        "--profile", "provider",
        "--destination", (Join-Path $InstallDir "bin")
    )
    Invoke-VcRuntimeClosure @(
        "stage",
        "--root", $OutDir,
        "--profile", "provider",
        "--destination", (Join-Path $OutDir "bin")
    )
    Invoke-VcRuntimeClosure @(
        "verify",
        "--root", $InstallDir,
        "--profile", "provider",
        "--search-root", (Join-Path $InstallDir "bin")
    )
    Invoke-VcRuntimeClosure @(
        "verify",
        "--root", $OutDir,
        "--profile", "provider",
        "--search-root", (Join-Path $OutDir "bin")
    )
}

function Test-VcRuntimeClosure {
    & bun $VcRuntimeClosureTool verify `
        --root $InstallDir `
        --profile provider `
        --search-root (Join-Path $InstallDir "bin") *> $null
    if ($LASTEXITCODE -ne 0) {
        return $false
    }
    & bun $VcRuntimeClosureTool verify `
        --root $OutDir `
        --profile provider `
        --search-root (Join-Path $OutDir "bin") *> $null
    $LASTEXITCODE -eq 0
}

function Test-PostgresSourceArchive([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $false
    }
    (Get-FileSha256 $Path) -eq $PgSha256
}

function Download-PostgresSourceArchive {
    $partial = "$Tarball.partial.$PID.$([Guid]::NewGuid().ToString('N'))"
    try {
        foreach ($url in $PgUrls) {
            Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
            $curlExit = 1
            try {
                # Schannel can report transient revocation-service outages as curl
                # error 35. Keep certificate and hostname validation, and still
                # reject certificates that are known to be revoked, while allowing
                # a download to proceed when only the revocation distribution point
                # is offline. Retries and the independent pinned mirror cover the
                # remaining bounded transport failures.
                $curlArgs = @(
                    "--location", "--fail", "--silent", "--show-error",
                    "--retry", "4", "--retry-all-errors", "--retry-delay", "3",
                    "--retry-max-time", "90", "--connect-timeout", "20", "--max-time", "60",
                    "--max-filesize", "67108864",
                    "--ssl-revoke-best-effort",
                    "--proto", "=https", "--proto-redir", "=https", "--remove-on-error",
                    "--output", $partial, $url
                )
                & curl.exe @curlArgs
                $curlExit = $LASTEXITCODE
            } catch {
                Write-Warning "curl failed while downloading PostgreSQL $PgVersion from ${url}: $($_.Exception.Message)"
            }

            if ($curlExit -eq 0 -and (Test-PostgresSourceArchive $partial)) {
                Move-Item -LiteralPath $partial -Destination $Tarball -Force
                return
            }
            if ($curlExit -eq 0 -and (Test-Path -LiteralPath $partial -PathType Leaf)) {
                $actual = Get-FileSha256 $partial
                Write-Warning "discarding PostgreSQL $PgVersion from $url with checksum $actual instead of $PgSha256"
            } else {
                Write-Warning "PostgreSQL $PgVersion download from $url failed after bounded retries (curl exit $curlExit)"
            }
        }
        Fail "failed to download verified PostgreSQL $PgVersion source from every pinned HTTPS location"
    } finally {
        Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
    }
}

function NativeExtension-Selected([string]$SqlName) {
    if ($BuildExtensions -eq "0") {
        return $false
    }
    if ($SelectedNativeExtensionSqlNames.Count -eq 0) {
        return $true
    }
    $SelectedNativeExtensionSqlNames.Contains($SqlName)
}

function Assert-WindowsNativeExtensionSelectionSupported {
}

function Meson-Quote([string]$Value) {
    "'" + $Value.Replace("\", "/").Replace("'", "\'") + "'"
}

function Meson-Path([string]$Path) {
    ([System.IO.Path]::GetFullPath($Path)).Replace("\", "/")
}

function Meson-List([string[]]$Values, [string]$Indent = "  ") {
    if ($Values.Count -eq 0) {
        return ""
    }
    (($Values | ForEach-Object { "$Indent$(Meson-Quote $_)" }) -join ",`n")
}

function Meson-DataInstall([string[]]$Files) {
    $fileList = Meson-List $Files
@"
install_data(
$fileList,
  kwargs: contrib_data_args,
)
"@
}

function Copy-SourceTree([string]$Source, [string]$Destination) {
    if (-not (Test-Path $Source)) {
        Fail "missing source checkout: $Source"
    }
    Remove-Item -Recurse -Force $Destination -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    Copy-Item -Path (Join-Path $Source "*") -Destination $Destination -Recurse -Force
    Remove-Item -Recurse -Force (Join-Path $Destination ".git") -ErrorAction SilentlyContinue
}

function External-Checkout([string]$CheckoutName) {
    Join-Path $ExternalCheckoutRoot $CheckoutName
}

function Get-PatchSeries {
    $inSeries = $false
    foreach ($line in Get-Content $SourceManifest) {
        if ($line -match "series\s*=\s*\[") {
            $inSeries = $true
            continue
        }
        if ($inSeries -and $line -match "\]") {
            break
        }
        if ($inSeries -and $line -match '"([^"]+\.patch)"') {
            $Matches[1]
        }
    }
}

function Get-DesiredHash {
    $parts = New-Object System.Collections.Generic.List[string]
    $parts.Add("pg_version=$PgVersion")
    $parts.Add("pg_sha256=$PgSha256")
    $parts.Add("target_id=$TargetId")
    $parts.Add("build_extensions=$BuildExtensions")
    $parts.Add("native_extension_sql_names=$NativeExtensionSqlNames")
    $parts.Add("script=$(Get-FileSha256 $PSCommandPath)")
    $parts.Add("source_manifest=$(Get-FileSha256 $SourceManifest)")
    foreach ($patch in Get-PatchSeries) {
        $parts.Add("patch:$patch=$(Get-FileSha256 (Join-Path $PatchDir $patch))")
    }
    foreach ($source in $LiboliphauntSources) {
        $parts.Add("source:$source=$(Get-FileSha256 $source)")
    }
    foreach ($source in @(
        $OpenSslSourceManifest,
        $PgxsBuildPlan,
        (Join-Path $PortableUuidDir "portable_uuid.c"),
        (Join-Path $PortableUuidIncludeDir "uuid/uuid.h"),
        (Join-Path $RepoRoot "src/extensions/external/pg_hashids/source.toml"),
        (Join-Path $RepoRoot "src/extensions/external/pg_ivm/source.toml"),
        (Join-Path $RepoRoot "src/extensions/external/pg_textsearch/source.toml"),
        (Join-Path $RepoRoot "src/extensions/external/pg_uuidv7/source.toml"),
        (Join-Path $RepoRoot "src/extensions/external/postgis/source.toml"),
        (Join-Path $RepoRoot "src/extensions/external/postgis/deps.toml"),
        (Join-Path $RepoRoot "src/extensions/external/postgis/dependencies/geos/source.toml"),
        (Join-Path $RepoRoot "src/extensions/external/postgis/dependencies/json-c/source.toml"),
        (Join-Path $RepoRoot "src/extensions/external/postgis/dependencies/libxml2/source.toml"),
        (Join-Path $RepoRoot "src/extensions/external/postgis/dependencies/proj/source.toml"),
        (Join-Path $RepoRoot "src/extensions/external/postgis/dependencies/sqlite/source.toml"),
        (Join-Path $RepoRoot "src/extensions/external/pgtap/source.toml"),
        (Join-Path $RepoRoot "src/extensions/external/vector/source.toml")
    )) {
        if (Test-Path $source) {
            $parts.Add("source-input:$source=$(Get-FileSha256 $source)")
        }
    }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes(($parts -join "`n") + "`n")
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        (($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString("x2") }) -join "")
    } finally {
        $sha.Dispose()
    }
}

function Invoke-Logged([string]$LogName, [scriptblock]$Block) {
    $log = Join-Path $WorkRoot $LogName
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $log) | Out-Null
    $global:LASTEXITCODE = 0
    & $Block *> $log
    if ($LASTEXITCODE -ne 0) {
        [Console]::Error.WriteLine("==== $LogName tail ====")
        if (Test-Path $log) {
            Get-Content $log -Tail 160 | ForEach-Object { [Console]::Error.WriteLine($_) }
        } else {
            [Console]::Error.WriteLine("(log file was not created: $log)")
        }
        [Console]::Error.WriteLine("==== end $LogName tail ====")
        Fail "$LogName failed; see $log"
    }
}

function Expand-PostgresSourceArchive {
    $script = @'
import sys
import tarfile
from pathlib import Path

archive = Path(sys.argv[1])
destination = Path(sys.argv[2]).resolve()
with tarfile.open(archive, "r:bz2") as source:
    members = source.getmembers()
    for member in members:
        target = (destination / member.name).resolve()
        if target != destination and destination not in target.parents:
            raise SystemExit(f"archive member escapes extraction root: {member.name}")
    try:
        source.extractall(destination, members=members, filter="data")
    except TypeError:
        source.extractall(destination, members=members)
'@
    Invoke-Python @("-c", $script, $Tarball, $WorkRoot)
}

function Prepare-Source([string]$DesiredHash) {
    New-Item -ItemType Directory -Force -Path $SourceCache, $WorkRoot, $OutDir, $ObjDir | Out-Null
    if ((Test-Path -LiteralPath $Tarball -PathType Leaf) -and -not (Test-PostgresSourceArchive $Tarball)) {
        $actual = Get-FileSha256 $Tarball
        Write-Warning "discarding cached PostgreSQL $PgVersion source with checksum $actual instead of $PgSha256"
        Remove-Item -LiteralPath $Tarball -Force
    }
    if (-not (Test-Path -LiteralPath $Tarball -PathType Leaf)) {
        Download-PostgresSourceArchive
    }
    $actual = Get-FileSha256 $Tarball
    if ($actual -ne $PgSha256) {
        Fail "PostgreSQL source checksum mismatch: expected $PgSha256, got $actual"
    }
    $current = if (Test-Path $Stamp) { (Get-Content $Stamp -Raw).Trim() } else { "" }
    if ((Test-Path $BuildDir) -and $current -ne $DesiredHash) {
        Remove-Item -Recurse -Force $BuildDir, $RuntimeBuildDir, $EmbeddedBuildDir, $InstallDir, $OutDir -ErrorAction SilentlyContinue
        New-Item -ItemType Directory -Force -Path $OutDir, $ObjDir | Out-Null
    }
    if (-not (Test-Path $BuildDir)) {
        Expand-PostgresSourceArchive
        Push-Location $BuildDir
        try {
            git init -q
            foreach ($patch in Get-PatchSeries) {
                git apply --whitespace=error-all (Join-Path $PatchDir $patch)
                if ($LASTEXITCODE -ne 0) {
                    Fail "failed to apply PostgreSQL patch $patch"
                }
            }
        } finally {
            Pop-Location
        }
    }
    Assert-PatchedSource
}

function Assert-FileContains([string]$Path, [string]$Needle) {
    if (-not (Test-Path $Path)) {
        Fail "missing patched PostgreSQL source file $Path"
    }
    $text = Get-Content -Raw -Path $Path
    if (-not $text.Contains($Needle)) {
        Fail "patched PostgreSQL source file $Path does not contain required marker $Needle"
    }
}

function Assert-PatchedSource {
    Assert-FileContains (Join-Path $BuildDir "src/include/libpq/libpq-be.h") "OliphauntEmbeddedIO"
    Assert-FileContains (Join-Path $BuildDir "src/backend/tcop/postgres.c") "oliphaunt_embedded_main"
    Assert-FileContains (Join-Path $BuildDir "src/port/pqsignal.c") "oliphaunt_embedded_kill"
    Assert-FileContains (Join-Path $BuildDir "src/port/pqsignal.c") "oliphaunt_embedded_raise"
    Assert-FileContains (Join-Path $BuildDir "src/bin/initdb/initdb.c") 'getenv("ICU_DATA")'
    Assert-FileContains (Join-Path $BuildDir "meson_options.txt") "oliphaunt_embedded"
    Assert-FileContains (Join-Path $BuildDir "meson_options.txt") "oliphaunt_embedded_module_provider"
    Assert-FileContains (Join-Path $BuildDir "meson.build") "OLIPHAUNT_EMBEDDED"
    Assert-FileContains (Join-Path $BuildDir "src/backend/meson.build") "oliphaunt_embedded_module_provider"
}

function Append-OliphauntContribSubdir([string]$Subdir) {
    $contribMeson = Join-Path $BuildDir "contrib/meson.build"
    $line = "subdir('oliphaunt_external/$Subdir')"
    $text = Get-Content -Raw -Path $contribMeson
    if (-not $text.Contains($line)) {
        Add-Content -Path $contribMeson -Value $line
    }
}

function Write-OliphauntMesonModule(
    [string]$Subdir,
    [string]$ModuleName,
    [string[]]$Sources,
    [string[]]$DataFiles,
    [string[]]$CArgs = @(),
    [string[]]$LinkArgs = @(),
    [string[]]$LocalIncludeDirs = @()
) {
    $destination = Join-Path $OliphauntContribDir $Subdir
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    $variable = $Subdir.Replace("-", "_")
    $sourceList = Meson-List $Sources
    $extraKwargs = New-Object System.Collections.Generic.List[string]
    if ($CArgs.Count -gt 0) {
        $extraKwargs.Add("'c_args': [`n$(Meson-List $CArgs "    ")`n  ]")
    }
    if ($LinkArgs.Count -gt 0) {
        $extraKwargs.Add("'link_args': [`n$(Meson-List $LinkArgs "    ")`n  ]")
    }
    $extraKwargsText = ""
    if ($extraKwargs.Count -gt 0) {
        $extraKwargsText = " + {`n  $($extraKwargs -join ",`n  ")`n}"
    }
    $includeText = ""
    if ($LocalIncludeDirs.Count -gt 0) {
        $includeText = "  include_directories: [$((($LocalIncludeDirs | ForEach-Object { "include_directories($(Meson-Quote $_))" }) -join ', '))],`n"
    }
    $dataInstall = Meson-DataInstall $DataFiles
    $meson = @"
$variable = shared_module(
  $(Meson-Quote $ModuleName),
  files(
$sourceList,
  ),
  c_pch: pch_postgres_h,
$includeText  kwargs: contrib_mod_args$extraKwargsText,
)
contrib_targets += $variable

$dataInstall
"@
    Set-Content -Path (Join-Path $destination "meson.build") -Value $meson -Encoding UTF8
    Append-OliphauntContribSubdir $Subdir
}

function Build-WindowsOpenSslDependency {
    if (-not (NativeExtension-Selected "pgcrypto")) {
        return
    }
    $includeDir = Join-Path $OpenSslDependencyPrefix "include/openssl"
    $libCrypto = Join-Path $OpenSslDependencyPrefix "lib/libcrypto.lib"
    if ((Test-Path $includeDir) -and (Test-Path $libCrypto)) {
        return
    }
    Require-Command nmake.exe
    $sourceDir = External-Checkout "openssl"
    if (-not (Test-Path (Join-Path $sourceDir "Configure"))) {
        Fail "missing OpenSSL checkout for pgcrypto: $sourceDir"
    }
    $buildRoot = Join-Path $WorkRoot "openssl-windows-build"
    Remove-Item -Recurse -Force $buildRoot, $OpenSslDependencyPrefix -ErrorAction SilentlyContinue
    Copy-SourceTree $sourceDir $buildRoot
    Invoke-Logged "openssl-windows-build.log" {
        Push-Location $buildRoot
        try {
            & perl Configure VC-WIN64A no-shared no-tests no-apps no-module no-asm `
                "--prefix=$OpenSslDependencyPrefix" `
                "--openssldir=$(Join-Path $OpenSslDependencyPrefix "ssl")"
            if ($LASTEXITCODE -ne 0) { return }
            & nmake.exe /nologo build_generated libcrypto.lib
            if ($LASTEXITCODE -ne 0) { return }
            & nmake.exe /nologo install_sw
        } finally {
            Pop-Location
        }
    }
    if (-not (Test-Path $includeDir) -or -not (Test-Path $libCrypto)) {
        Fail "OpenSSL Windows build did not produce include/openssl and lib/libcrypto.lib under $OpenSslDependencyPrefix"
    }
}

function Find-FirstFileOrNull([string]$Root, [string[]]$Filters) {
    if (-not (Test-Path $Root)) {
        return $null
    }
    foreach ($filter in $Filters) {
        $item = Get-ChildItem -Path $Root -Recurse -Filter $filter -File -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($item) {
            return $item.FullName
        }
    }
    $null
}

function Invoke-CmakeInstall(
    [string]$Name,
    [string]$SourceDir,
    [string]$BuildRoot,
    [string]$Prefix,
    [string[]]$ConfigureArgs = @()
) {
    Require-Command cmake
    Require-Command ninja
    Remove-Item -Recurse -Force $BuildRoot, $Prefix -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $BuildRoot, $Prefix | Out-Null
    $cmakeArgs = @(
        "-S", $SourceDir,
        "-B", $BuildRoot,
        "-G", "Ninja",
        "-DCMAKE_BUILD_TYPE=Release",
        "-DCMAKE_INSTALL_PREFIX=$Prefix",
        "-DCMAKE_C_COMPILER=cl.exe",
        "-DCMAKE_CXX_COMPILER=cl.exe",
        "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreadedDLL"
    ) + $ConfigureArgs
    Invoke-Logged "postgis-$Name-cmake-configure.log" { cmake @cmakeArgs }
    Invoke-Logged "postgis-$Name-cmake-install.log" { cmake --build $BuildRoot --config Release --target install }
}

function Build-WindowsPostgisJsonCDependency {
    if (-not (NativeExtension-Selected "postgis")) {
        return
    }
    $prefix = Join-Path $PostgisDependencyPrefix "json-c"
    $archive = Find-FirstFileOrNull $prefix @("json-c.lib", "json-c-static.lib")
    if ((Test-Path (Join-Path $prefix "include/json-c")) -and $archive) {
        return
    }
    $sourceDir = External-Checkout "json-c"
    if (-not (Test-Path (Join-Path $sourceDir "CMakeLists.txt"))) {
        Fail "missing JSON-C checkout for PostGIS: $sourceDir"
    }
    Invoke-CmakeInstall "json-c" $sourceDir (Join-Path $WorkRoot "json-c-windows-build") $prefix @(
        "-DCMAKE_POLICY_VERSION_MINIMUM=3.5",
        "-DBUILD_SHARED_LIBS=OFF",
        "-DBUILD_STATIC_LIBS=ON",
        "-DBUILD_APPS=OFF",
        "-DBUILD_TESTING=OFF",
        "-DDISABLE_WERROR=ON"
    )
    [void](First-File $prefix @("json-c.lib", "json-c-static.lib"))
}

function Build-WindowsPostgisSqliteDependency {
    if (-not (NativeExtension-Selected "postgis")) {
        return
    }
    $prefix = Join-Path $PostgisDependencyPrefix "sqlite"
    $archive = Join-Path $prefix "lib/sqlite3.lib"
    $shell = Join-Path $prefix "bin/sqlite3.exe"
    if ((Test-Path $archive) -and (Test-Path $shell) -and (Test-Path (Join-Path $prefix "include/sqlite3.h"))) {
        return
    }
    Require-Command nmake.exe
    $sourceDir = External-Checkout "sqlite"
    if (-not (Test-Path (Join-Path $sourceDir "Makefile.msc"))) {
        Fail "missing SQLite checkout for PostGIS: $sourceDir"
    }
    $buildRoot = Join-Path $WorkRoot "sqlite-windows-build"
    Remove-Item -Recurse -Force $buildRoot, $prefix -ErrorAction SilentlyContinue
    Copy-SourceTree $sourceDir $buildRoot
    Invoke-Logged "postgis-sqlite-windows-build.log" {
        Push-Location $buildRoot
        try {
            # SQLite's MSVC makefile still injects /NODEFAULTLIB:msvcrt into
            # host-tool links. Let the runner's MSVC/UCRT defaults resolve CRT
            # symbols instead, and skip TCL artifacts that PostGIS does not use.
            & nmake.exe /nologo /f Makefile.msc libsqlite3.lib sqlite3.exe `
                USE_CRT_DLL=1 NO_TCL=1 LDFLAGS= `
                OPTS="-DSQLITE_THREADSAFE=0 -DSQLITE_OMIT_LOAD_EXTENSION"
        } finally {
            Pop-Location
        }
    }
    New-Item -ItemType Directory -Force -Path (Join-Path $prefix "include"), (Join-Path $prefix "lib"), (Join-Path $prefix "bin") | Out-Null
    Copy-Item -Force (Join-Path $buildRoot "libsqlite3.lib") $archive
    Copy-Item -Force (Join-Path $buildRoot "sqlite3.exe") $shell
    Copy-Item -Force (Join-Path $buildRoot "sqlite3.h"), (Join-Path $buildRoot "sqlite3ext.h") (Join-Path $prefix "include")
    if (-not (Test-Path $archive) -or -not (Test-Path $shell) -or -not (Test-Path (Join-Path $prefix "include/sqlite3.h"))) {
        Fail "SQLite Windows build did not produce sqlite3.lib, sqlite3.exe, and headers under $prefix"
    }
}

function Build-WindowsPostgisGeosDependency {
    if (-not (NativeExtension-Selected "postgis")) {
        return
    }
    $prefix = Join-Path $PostgisDependencyPrefix "geos"
    if ((Test-Path (Join-Path $prefix "include/geos_c.h")) -and
        (Find-FirstFileOrNull $prefix @("geos_c.lib")) -and
        (Find-FirstFileOrNull $prefix @("geos.lib"))) {
        return
    }
    $sourceDir = External-Checkout "geos"
    if (-not (Test-Path (Join-Path $sourceDir "CMakeLists.txt"))) {
        Fail "missing GEOS checkout for PostGIS: $sourceDir"
    }
    Invoke-CmakeInstall "geos" $sourceDir (Join-Path $WorkRoot "geos-windows-build") $prefix @(
        "-DBUILD_SHARED_LIBS=OFF",
        "-DBUILD_TESTING=OFF",
        "-DBUILD_BENCHMARKS=OFF",
        "-DBUILD_GEOSOP=OFF",
        "-DGEOS_BUILD_DEVELOPER=OFF"
    )
    [void](First-File $prefix @("geos_c.lib"))
    [void](First-File $prefix @("geos.lib"))
}

function Build-WindowsPostgisLibxml2Dependency {
    if (-not (NativeExtension-Selected "postgis")) {
        return
    }
    $prefix = Join-Path $PostgisDependencyPrefix "libxml2"
    if ((Test-Path (Join-Path $prefix "include/libxml2/libxml/parser.h")) -and
        (Find-FirstFileOrNull $prefix @("libxml2s.lib", "libxml2.lib", "xml2.lib"))) {
        return
    }
    $sourceDir = External-Checkout "libxml2"
    if (-not (Test-Path (Join-Path $sourceDir "CMakeLists.txt"))) {
        Fail "missing libxml2 checkout for PostGIS: $sourceDir"
    }
    Invoke-CmakeInstall "libxml2" $sourceDir (Join-Path $WorkRoot "libxml2-windows-build") $prefix @(
        "-DBUILD_SHARED_LIBS=OFF",
        "-DLIBXML2_WITH_PROGRAMS=OFF",
        "-DLIBXML2_WITH_TESTS=OFF",
        "-DLIBXML2_WITH_PYTHON=OFF",
        "-DLIBXML2_WITH_THREADS=OFF",
        "-DLIBXML2_WITH_MODULES=OFF",
        "-DLIBXML2_WITH_ICONV=OFF",
        "-DLIBXML2_WITH_ZLIB=OFF",
        "-DLIBXML2_WITH_LZMA=OFF",
        "-DLIBXML2_WITH_HTTP=OFF"
    )
    [void](First-File $prefix @("libxml2s.lib", "libxml2.lib", "xml2.lib"))
}

function Build-WindowsPostgisProjDependency {
    if (-not (NativeExtension-Selected "postgis")) {
        return
    }
    Build-WindowsPostgisSqliteDependency
    $prefix = Join-Path $PostgisDependencyPrefix "proj"
    if ((Test-Path (Join-Path $prefix "include/proj.h")) -and
        (Test-Path (Join-Path $prefix "share/proj/proj.db")) -and
        (Find-FirstFileOrNull $prefix @("proj.lib", "libproj.lib"))) {
        return
    }
    $sourceDir = External-Checkout "proj"
    if (-not (Test-Path (Join-Path $sourceDir "CMakeLists.txt"))) {
        Fail "missing PROJ checkout for PostGIS: $sourceDir"
    }
    $sqlitePrefix = Join-Path $PostgisDependencyPrefix "sqlite"
    $sqliteInclude = Join-Path $sqlitePrefix "include"
    $sqliteLib = Join-Path $sqlitePrefix "lib/sqlite3.lib"
    $sqliteExe = Join-Path $sqlitePrefix "bin/sqlite3.exe"
    $buildRoot = Join-Path $WorkRoot "proj-windows-build"
    Invoke-CmakeInstall "proj" $sourceDir $buildRoot $prefix @(
        "-DBUILD_SHARED_LIBS=OFF",
        "-DSQLite3_INCLUDE_DIR=$sqliteInclude",
        "-DSQLite3_LIBRARY=$sqliteLib",
        "-DEXE_SQLITE3=$sqliteExe",
        "-DENABLE_TIFF=OFF",
        "-DENABLE_CURL=OFF",
        "-DENABLE_EMSCRIPTEN_FETCH=OFF",
        "-DHAVE_LIBDL=OFF",
        "-DBUILD_APPS=OFF",
        "-DBUILD_TESTING=OFF",
        "-DBUILD_EXAMPLES=OFF",
        "-DEMBED_RESOURCE_FILES=ON",
        "-DUSE_ONLY_EMBEDDED_RESOURCE_FILES=ON"
    )
    $projDb = Join-Path $prefix "share/proj/proj.db"
    if (-not (Test-Path $projDb) -and (Test-Path (Join-Path $buildRoot "data/proj.db"))) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $projDb) | Out-Null
        Copy-Item -Force (Join-Path $buildRoot "data/proj.db") $projDb
    }
    [void](First-File $prefix @("proj.lib", "libproj.lib"))
    if (-not (Test-Path $projDb)) {
        Fail "PROJ Windows build did not produce proj.db under $prefix"
    }
}

function Build-WindowsPostgisDependencies {
    if (-not (NativeExtension-Selected "postgis")) {
        return
    }
    Build-WindowsPostgisSqliteDependency
    Build-WindowsPostgisJsonCDependency
    Build-WindowsPostgisGeosDependency
    Build-WindowsPostgisLibxml2Dependency
    Build-WindowsPostgisProjDependency
}

function Read-PostgisVersionConfig([string]$PostgisSourceDir) {
    $versionPath = Join-Path $PostgisSourceDir "Version.config"
    if (-not (Test-Path $versionPath)) {
        Fail "missing PostGIS Version.config: $versionPath"
    }
    $values = @{}
    foreach ($line in Get-Content $versionPath) {
        if ($line -match "^([A-Z0-9_]+)=(.*)$") {
            $values[$Matches[1]] = $Matches[2].Trim()
        }
    }
    foreach ($key in @("POSTGIS_MAJOR_VERSION", "POSTGIS_MINOR_VERSION", "POSTGIS_MICRO_VERSION")) {
        if (-not $values.ContainsKey($key)) {
            Fail "PostGIS Version.config does not define $key"
        }
    }
    [PSCustomObject]@{
        Major = $values["POSTGIS_MAJOR_VERSION"]
        Minor = $values["POSTGIS_MINOR_VERSION"]
        Micro = $values["POSTGIS_MICRO_VERSION"]
        Version = "$($values["POSTGIS_MAJOR_VERSION"]).$($values["POSTGIS_MINOR_VERSION"]).$($values["POSTGIS_MICRO_VERSION"])"
        MajorMinor = "$($values["POSTGIS_MAJOR_VERSION"]).$($values["POSTGIS_MINOR_VERSION"])"
    }
}

function Get-PostgisSourceRevision([string]$PostgisSourceDir, [string]$FallbackVersion) {
    $revision = ""
    try {
        $revision = (& git -C $PostgisSourceDir describe --always --dirty=never 2>$null | Select-Object -First 1).Trim()
    } catch {
        $revision = ""
    }
    if (-not $revision) {
        $revision = $FallbackVersion
    }
    $revision
}

function Get-PostgisSourceDateEpoch {
    $manifest = Join-Path $RepoRoot "src/extensions/external/postgis/source.toml"
    if (-not (Test-Path -PathType Leaf $manifest)) {
        Fail "missing canonical PostGIS source manifest: $manifest"
    }
    $keyLines = @(Select-String -Path $manifest -Pattern '^source_date_epoch\s*=')
    if ($keyLines.Count -ne 1) {
        Fail "$manifest must declare exactly one canonical source_date_epoch integer"
    }
    $match = [regex]::Match($keyLines[0].Line, '^source_date_epoch = ([1-9][0-9]{0,17})$')
    if (-not $match.Success) {
        Fail "$manifest source_date_epoch must be one canonical positive integer"
    }
    try {
        $epoch = [Int64]::Parse($match.Groups[1].Value, [Globalization.CultureInfo]::InvariantCulture)
    } catch {
        Fail "$manifest source_date_epoch exceeds the signed 64-bit range"
    }
    if ($epoch -gt 253402300799) {
        Fail "$manifest source_date_epoch exceeds the portable UTC range"
    }
    $epoch
}

function Format-PostgisSourceDate([Int64]$Epoch) {
    [DateTimeOffset]::FromUnixTimeSeconds($Epoch).UtcDateTime.ToString(
        "yyyy-MM-dd HH:mm:ss",
        [Globalization.CultureInfo]::InvariantCulture
    )
}

function Expand-PostgisTemplate([string]$InputPath, [string]$OutputPath, [hashtable]$Values) {
    $text = Get-Content -Raw -Path $InputPath
    foreach ($key in $Values.Keys) {
        $text = $text.Replace("@$key@", [string]$Values[$key])
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath) | Out-Null
    Set-Content -Path $OutputPath -Encoding UTF8 -Value $text
}

function Initialize-WindowsPostgisGeneratedSource([string]$PostgisDir, [string]$OriginalSourceDir) {
    $version = Read-PostgisVersionConfig $PostgisDir
    $revision = Get-PostgisSourceRevision $OriginalSourceDir $version.Version
    $sourceDateEpoch = Get-PostgisSourceDateEpoch
    if ($env:SOURCE_DATE_EPOCH -ne [string]$sourceDateEpoch) {
        Fail "Windows PostGIS generation must run under the canonical SOURCE_DATE_EPOCH"
    }
    $buildDate = Format-PostgisSourceDate $sourceDateEpoch
    $geosVersionNumber = "31401"
    $projVersionNumber = "90801"
    $libXmlVersion = "2.14.6"
    $postgisVersion = "$($version.Major).$($version.Minor) USE_GEOS=1 USE_PROJ=1 USE_STATS=1"
    $localeDir = (Meson-Path (Join-Path $InstallDir "share/locale"))

    Set-Content -Path (Join-Path $PostgisDir "postgis_revision.h") -Encoding UTF8 -Value "#define POSTGIS_REVISION $revision"
    Set-Content -Path (Join-Path $PostgisDir "postgis_config.h") -Encoding UTF8 -Value @"
/* postgis_config.h. Generated by Oliphaunt's Windows native producer. */
#ifndef POSTGIS_CONFIG_H
#define POSTGIS_CONFIG_H 1

#include "postgis_revision.h"

#define POSTGIS_DEBUG_LEVEL 0
/* #undef ENABLE_NLS */
/* #undef HAVE_GETTEXT */
/* #undef WORDS_BIGENDIAN */
/* #undef HAVE_ICONV */
/* #undef HAVE_ICONVCTL */
#define HAVE_IEEEFP_H 0
#define HAVE_LIBGEOS_C 1
/* #undef HAVE_LIBICONVCTL */
/* #undef HAVE_LIBPROTOBUF */
/* #undef LIBPROTOBUF_VERSION */
#define HAVE_LIBJSON 1
#define HAVE_LIBPQ 1
#define HAVE_LIBPROJ 1
#define HAVE_LIBXML2 1
#define HAVE_LIBXML_PARSER_H 1
#define HAVE_LIBXML_TREE_H 1
#define HAVE_LIBXML_XPATHINTERNALS_H 1
#define HAVE_LIBXML_XPATH_H 1
/* #undef HAVE_UNISTD_H */
/* #undef HAVE_SFCGAL */
#define LT_OBJDIR ".libs/"
#define PGSQL_LOCALEDIR "$localeDir"
#define POSTGIS_BUILD_DATE "$buildDate"
/* #undef POSTGIS_SFCGAL_VERSION */
/* #undef POSTGIS_GDAL_VERSION */
#define POSTGIS_GEOS_VERSION $geosVersionNumber
#define POSTGIS_LIBXML2_VERSION "$libXmlVersion"
#define POSTGIS_LIB_VERSION "$($version.Version)"
#define POSTGIS_MAJOR_VERSION "$($version.Major)"
#define POSTGIS_MINOR_VERSION "$($version.Minor)"
#define POSTGIS_MICRO_VERSION "$($version.Micro)"
#define POSTGIS_PGSQL_VERSION 180
#define POSTGIS_PROJ_VERSION $projVersionNumber
/* #undef POSTGIS_RASTER_WARN_ON_TRUNCATION */
#define POSTGIS_SCRIPTS_VERSION "$($version.Version)"
#define POSTGIS_VERSION "$postgisVersion"
#define STDC_HEADERS 1
#define YYTEXT_POINTER 1

#endif /* POSTGIS_CONFIG_H */
"@

    $templateValues = @{
        POSTGIS_PGSQL_VERSION = "180"
        POSTGIS_PGSQL_HR_VERSION = "18.0"
        POSTGIS_GEOS_VERSION = $geosVersionNumber
        POSTGIS_PROJ_VERSION = $projVersionNumber
        POSTGIS_LIB_VERSION = $version.Version
        POSTGIS_LIBXML2_VERSION = $libXmlVersion
        POSTGIS_SFCGAL_VERSION = "0"
        POSTGIS_VERSION = $postgisVersion
        POSTGIS_BUILD_DATE = $buildDate
        POSTGIS_SCRIPTS_VERSION = $version.Version
        SRID_MAX = "999999"
        SRID_USR_MAX = "998999"
        POSTGIS_MAJOR_VERSION = $version.Major
        POSTGIS_MINOR_VERSION = $version.Minor
    }
    Expand-PostgisTemplate (Join-Path $PostgisDir "postgis/sqldefines.h.in") (Join-Path $PostgisDir "postgis/sqldefines.h") $templateValues
    Expand-PostgisTemplate (Join-Path $PostgisDir "liblwgeom/liblwgeom.h.in") (Join-Path $PostgisDir "liblwgeom/liblwgeom.h") $templateValues
    Expand-PostgisTemplate (Join-Path $PostgisDir "extensions/postgis/postgis.control.in") (Join-Path $PostgisDir "extensions/postgis/postgis.control") @{
        EXTVERSION = $version.Version
        EXTENSION = "postgis"
        MODULEPATH = '$libdir/postgis-3'
    }
    $version
}

function Invoke-PostgisSqlPreprocessor([string]$InputPath, [string]$OutputPath, [string[]]$IncludeDirs) {
    $script = @'
import pathlib
import re
import sys

source = pathlib.Path(sys.argv[1]).resolve()
output = pathlib.Path(sys.argv[2]).resolve()
include_dirs = [pathlib.Path(p).resolve() for p in sys.argv[3:]]
macros = {}
result = []
include_stack = []
token_re = re.compile(r"\b[A-Za-z_][A-Za-z0-9_]*\b")

def expand_macros(text):
    for _ in range(16):
        changed = False
        def repl(match):
            nonlocal changed
            name = match.group(0)
            if name in macros:
                changed = True
                return macros[name]
            return name
        expanded = token_re.sub(repl, text)
        text = expanded
        if not changed:
            break
    return text

def eval_expr(expr):
    expr = expand_macros(expr)
    expr = token_re.sub("0", expr)
    expr = expr.replace("&&", " and ").replace("||", " or ")
    if not re.match(r"^[0-9\s<>=!&|()+*/%.\-andor]+$", expr):
        return False
    try:
        return bool(eval(expr, {"__builtins__": {}}, {}))
    except Exception:
        return False

def find_include(name, current):
    candidates = [current.parent] + include_dirs
    for directory in candidates:
        path = directory / name
        if path.exists():
            return path.resolve()
    raise SystemExit(f"could not resolve SQL include {name} from {current}")

def in_block_comment_after_line(line, in_block_comment):
    offset = 0
    while True:
        if in_block_comment:
            end = line.find("*/", offset)
            if end == -1:
                return True
            in_block_comment = False
            offset = end + 2
            continue
        start = line.find("/*", offset)
        if start == -1:
            return False
        end = line.find("*/", start + 2)
        if end == -1:
            return True
        offset = end + 2

def process(path):
    path = path.resolve()
    if path in include_stack:
        cycle = include_stack[include_stack.index(path):] + [path]
        raise SystemExit("recursive SQL include: " + " -> ".join(str(item) for item in cycle))
    include_stack.append(path)
    active = True
    stack = []
    in_block_comment = False
    try:
        for raw in path.read_text(encoding="utf-8").splitlines(True):
            stripped = raw.lstrip()
            directive = None if in_block_comment or not stripped.startswith("#") else stripped[1:].strip()
            if directive is None:
                if active:
                    result.append(expand_macros(raw))
                in_block_comment = in_block_comment_after_line(raw, in_block_comment)
                continue

            if directive.startswith("include"):
                if active:
                    match = re.match(r'include\s+"([^"]+)"', directive)
                    if not match:
                        raise SystemExit(f"unsupported include directive in {path}: {raw.rstrip()}")
                    process(find_include(match.group(1), path))
                continue
            if directive.startswith("define"):
                if active:
                    match = re.match(r"define\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+(.*?))?\s*$", directive)
                    if match:
                        macros[match.group(1)] = match.group(2) if match.group(2) is not None else "1"
                continue
            if directive.startswith("undef"):
                if active:
                    parts = directive.split()
                    if len(parts) > 1:
                        macros.pop(parts[1], None)
                continue
            if directive.startswith("ifdef"):
                name = directive.split(None, 1)[1].strip()
                cond = name in macros
                stack.append([active, cond])
                active = active and cond
                continue
            if directive.startswith("ifndef"):
                name = directive.split(None, 1)[1].strip()
                cond = name not in macros
                stack.append([active, cond])
                active = active and cond
                continue
            if directive.startswith("if"):
                cond = eval_expr(directive[2:].strip()) if active else False
                stack.append([active, cond])
                active = active and cond
                continue
            if directive.startswith("elif"):
                if not stack:
                    raise SystemExit(f"orphan #elif in {path}")
                parent, taken = stack[-1]
                cond = (not taken) and eval_expr(directive[4:].strip()) if parent else False
                stack[-1][1] = taken or cond
                active = parent and cond
                continue
            if directive.startswith("else"):
                if not stack:
                    raise SystemExit(f"orphan #else in {path}")
                parent, taken = stack[-1]
                active = parent and not taken
                stack[-1][1] = True
                continue
            if directive.startswith("endif"):
                if not stack:
                    raise SystemExit(f"orphan #endif in {path}")
                parent, _ = stack.pop()
                active = parent
                continue

            if active:
                result.append(raw)
    finally:
        include_stack.pop()

process(source)
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text("".join(result), encoding="utf-8")
'@
    $args = @("-c", $script, $InputPath, $OutputPath) + $IncludeDirs
    Invoke-Python $args
}

function New-PostgisSqlFromTemplate(
    [string]$InputPath,
    [string]$OutputPath,
    [string[]]$IncludeDirs,
    [string]$ModulePath,
    [bool]$StripTransactionBlocks,
    [bool]$RemoveExtschemaPrefix
) {
    $tmp = "$OutputPath.tmp"
    Invoke-PostgisSqlPreprocessor $InputPath $tmp $IncludeDirs
    $text = Get-Content -Raw -Path $tmp
    Remove-Item -Force $tmp
    $text = $text.Replace("MODULE_PATHNAME", $ModulePath)
    if ($StripTransactionBlocks) {
        $text = $text.Replace("BEGIN;", "").Replace("COMMIT;", "")
    }
    if ($RemoveExtschemaPrefix) {
        $text = $text.Replace("@extschema@.", "")
    }
    Set-Content -Path $OutputPath -Encoding UTF8 -Value $text
}

function Invoke-PerlToFile([string[]]$Arguments, [string]$OutputPath) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath) | Out-Null
    $global:LASTEXITCODE = 0
    & perl @Arguments > $OutputPath
    if ($LASTEXITCODE -ne 0) {
        Fail "perl command failed: $($Arguments -join ' ')"
    }
}

function Invoke-PerlFromInputFile([string]$InputPath, [string[]]$Arguments, [string]$OutputPath) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath) | Out-Null
    $global:LASTEXITCODE = 0
    Get-Content -Raw -Path $InputPath | & perl @Arguments > $OutputPath
    if ($LASTEXITCODE -ne 0) {
        Fail "perl command failed: $($Arguments -join ' ')"
    }
}

function Join-TextFiles([string]$OutputPath, [string[]]$InputPaths, [string]$Prefix = "", [string]$Suffix = "") {
    $builder = [System.Text.StringBuilder]::new()
    if ($Prefix) {
        [void]$builder.Append($Prefix)
        if (-not $Prefix.EndsWith("`n")) {
            [void]$builder.Append("`n")
        }
    }
    foreach ($path in $InputPaths) {
        [void]$builder.Append((Get-Content -Raw -Path $path))
        if (-not $builder.ToString().EndsWith("`n")) {
            [void]$builder.Append("`n")
        }
    }
    if ($Suffix) {
        [void]$builder.Append($Suffix)
        if (-not $Suffix.EndsWith("`n")) {
            [void]$builder.Append("`n")
        }
    }
    Set-Content -Path $OutputPath -Encoding UTF8 -Value $builder.ToString()
}

function New-PostgisRasterUnpackageSql([string]$PostgisDir, [string]$SqlDir, [string[]]$RasterDropSqlFiles) {
    $template = Join-Path $PostgisDir "extensions/postgis/unpackage_raster_if_needed.sql"
    $prefix = [System.Text.StringBuilder]::new()
    $suffix = [System.Text.StringBuilder]::new()
    $pastMarker = $false
    foreach ($line in Get-Content $template) {
        if (-not $pastMarker) {
            [void]$prefix.AppendLine($line)
            if ($line.Contains("UNPACKAGE_CODE")) {
                $pastMarker = $true
            }
        } else {
            [void]$suffix.AppendLine($line)
        }
    }
    $dropSql = Join-Path $SqlDir "raster_drop_all.sql"
    Join-TextFiles $dropSql $RasterDropSqlFiles
    $unpackageBody = Join-Path $SqlDir "raster_unpackage_body.sql"
    Invoke-PerlFromInputFile $dropSql @((Join-Path $PostgisDir "utils/create_extension_unpackage.pl"), "postgis") $unpackageBody
    $body = Get-Content -Raw -Path $unpackageBody
    Set-Content -Path (Join-Path $SqlDir "raster_unpackage.sql") -Encoding UTF8 -Value ($prefix.ToString() + $body + $suffix.ToString())
}

function Convert-PostgisExtensionDropGuards([string]$InputPath, [string]$OutputPath) {
    $text = (Get-Content -Raw -Path $InputPath).Replace("BEGIN;", "").Replace("COMMIT;", "")
    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($line in ($text -split "`r?`n")) {
        if ($line -match "^(DROP .*)\;") {
            $drop = $Matches[1]
            $lines.Add("SELECT @extschema@.postgis_extension_drop_if_exists('postgis', '$drop');")
        }
        $lines.Add($line)
    }
    Set-Content -Path $OutputPath -Encoding UTF8 -Value ($lines -join "`n")
}

function Build-WindowsPostgisSql([string]$PostgisDir, [pscustomobject]$Version) {
    $sourceDateEpoch = Get-PostgisSourceDateEpoch
    if ($env:SOURCE_DATE_EPOCH -ne [string]$sourceDateEpoch) {
        Fail "Windows PostGIS SQL generation must run under the canonical SOURCE_DATE_EPOCH"
    }
    $buildDate = Format-PostgisSourceDate $sourceDateEpoch
    $postgisSqlDir = Join-Path $PostgisDir "postgis"
    $extensionDir = Join-Path $PostgisDir "extensions/postgis"
    $extensionSqlDir = Join-Path $extensionDir "sql"
    New-Item -ItemType Directory -Force -Path $extensionSqlDir | Out-Null
    $includeDirs = @($postgisSqlDir)
    $modulePath = '$libdir/postgis-3'

    New-PostgisSqlFromTemplate (Join-Path $PostgisDir "extensions/postgis_extension_helper.sql.in") (Join-Path $PostgisDir "extensions/postgis_extension_helper.sql") @($PostgisDir, $postgisSqlDir) "" $false $false
    New-PostgisSqlFromTemplate (Join-Path $postgisSqlDir "postgis.sql.in") (Join-Path $postgisSqlDir "postgis.sql") $includeDirs $modulePath $false $true
    New-PostgisSqlFromTemplate (Join-Path $postgisSqlDir "legacy_minimal.sql.in") (Join-Path $postgisSqlDir "legacy_minimal.sql") $includeDirs $modulePath $false $true
    New-PostgisSqlFromTemplate (Join-Path $postgisSqlDir "legacy.sql.in") (Join-Path $postgisSqlDir "legacy.sql") $includeDirs $modulePath $false $true
    New-PostgisSqlFromTemplate (Join-Path $postgisSqlDir "legacy_gist.sql.in") (Join-Path $postgisSqlDir "legacy_gist.sql") $includeDirs $modulePath $false $true

    Invoke-PerlToFile @((Join-Path $PostgisDir "utils/create_upgrade.pl"), (Join-Path $postgisSqlDir "postgis.sql")) (Join-Path $postgisSqlDir "postgis_upgrade.sql.in")
    Join-TextFiles (Join-Path $postgisSqlDir "postgis_upgrade.sql") @(
        (Join-Path $postgisSqlDir "common_before_upgrade.sql"),
        (Join-Path $postgisSqlDir "postgis_before_upgrade.sql"),
        (Join-Path $postgisSqlDir "postgis_upgrade.sql.in"),
        (Join-Path $postgisSqlDir "postgis_after_upgrade.sql"),
        (Join-Path $postgisSqlDir "common_after_upgrade.sql")
    ) "BEGIN;" "COMMIT;"
    Invoke-PerlToFile @((Join-Path $PostgisDir "utils/create_uninstall.pl"), (Join-Path $postgisSqlDir "postgis.sql"), "180") (Join-Path $postgisSqlDir "uninstall_postgis.sql")
    Invoke-PerlToFile @((Join-Path $PostgisDir "utils/create_uninstall.pl"), (Join-Path $postgisSqlDir "legacy.sql"), "180") (Join-Path $postgisSqlDir "uninstall_legacy.sql")

    New-PostgisSqlFromTemplate (Join-Path $postgisSqlDir "postgis.sql.in") (Join-Path $extensionSqlDir "postgis_for_extension.sql") $includeDirs $modulePath $true $false
    $spatialRefExtension = Join-Path $extensionSqlDir "spatial_ref_sys.sql"
    $spatialRefText = (Get-Content -Raw -Path (Join-Path $PostgisDir "spatial_ref_sys.sql")).Replace("BEGIN;", "").Replace("COMMIT;", "")
    Set-Content -Path $spatialRefExtension -Encoding UTF8 -Value $spatialRefText
    Invoke-PerlToFile @((Join-Path $PostgisDir "utils/create_spatial_ref_sys_config_dump.pl"), (Join-Path $PostgisDir "spatial_ref_sys.sql")) (Join-Path $extensionSqlDir "spatial_ref_sys_config_dump.sql")
    Invoke-PerlToFile @((Join-Path $PostgisDir "utils/create_upgrade.pl"), (Join-Path $extensionSqlDir "postgis_for_extension.sql")) (Join-Path $extensionSqlDir "postgis_upgrade_for_extension.sql.in")
    Join-TextFiles (Join-Path $extensionSqlDir "postgis_upgrade_for_extension.sql") @(
        (Join-Path $postgisSqlDir "common_before_upgrade.sql"),
        (Join-Path $postgisSqlDir "postgis_before_upgrade.sql"),
        (Join-Path $extensionSqlDir "postgis_upgrade_for_extension.sql.in"),
        (Join-Path $postgisSqlDir "postgis_after_upgrade.sql"),
        (Join-Path $postgisSqlDir "common_after_upgrade.sql")
    )
    $upgradeForExtensionText = (Get-Content -Raw -Path (Join-Path $extensionSqlDir "postgis_upgrade_for_extension.sql")).Replace("BEGIN;", "").Replace("COMMIT;", "")
    Set-Content -Path (Join-Path $extensionSqlDir "postgis_upgrade_for_extension.sql") -Encoding UTF8 -Value $upgradeForExtensionText
    Convert-PostgisExtensionDropGuards (Join-Path $extensionSqlDir "postgis_upgrade_for_extension.sql") (Join-Path $extensionSqlDir "postgis_upgrade.sql")

    $rasterDir = Join-Path $PostgisDir "raster/rt_pg"
    $rasterIncludeDirs = @($postgisSqlDir, $rasterDir)
    $rasterBaseSql = Join-Path $rasterDir "rtpostgis.sql"
    New-PostgisSqlFromTemplate (Join-Path $rasterDir "rtpostgis.sql.in") $rasterBaseSql $rasterIncludeDirs '$libdir/rtpostgis-3' $false $true
    $rasterDropSql = @()
    foreach ($name in @("rtpostgis_upgrade_cleanup", "rtpostgis_drop")) {
        $output = Join-Path $rasterDir "$name.sql"
        New-PostgisSqlFromTemplate (Join-Path $rasterDir "$name.sql.in") $output $rasterIncludeDirs '$libdir/rtpostgis-3' $false $true
        $rasterDropSql += $output
    }
    $rasterUninstallSql = Join-Path $rasterDir "uninstall_rtpostgis.sql"
    Invoke-PerlToFile @((Join-Path $PostgisDir "utils/create_uninstall.pl"), $rasterBaseSql, "180") $rasterUninstallSql
    $rasterDropSql += $rasterUninstallSql
    New-PostgisRasterUnpackageSql $PostgisDir $extensionSqlDir $rasterDropSql

    $installSql = Join-Path $extensionSqlDir "postgis--$($Version.Version).sql"
    Join-TextFiles $installSql @(
        (Join-Path $extensionSqlDir "postgis_for_extension.sql"),
        (Join-Path $extensionSqlDir "spatial_ref_sys_config_dump.sql"),
        (Join-Path $extensionSqlDir "spatial_ref_sys.sql")
    ) '\echo Use "CREATE EXTENSION postgis" to load this file. \quit'

    $anyUpgradeSql = Join-Path $extensionSqlDir "postgis--ANY--$($Version.Version).sql"
    Join-TextFiles $anyUpgradeSql @(
        (Join-Path $PostgisDir "extensions/postgis_extension_helper.sql"),
        (Join-Path $extensionSqlDir "raster_unpackage.sql"),
        (Join-Path $extensionSqlDir "postgis_upgrade.sql"),
        (Join-Path $extensionSqlDir "spatial_ref_sys.sql"),
        (Join-Path $extensionSqlDir "spatial_ref_sys_config_dump.sql"),
        (Join-Path $PostgisDir "extensions/postgis_extension_helper_uninstall.sql")
    ) '\echo Use "CREATE EXTENSION postgis" to load this file. \quit'

    $templatedSql = Join-Path $extensionSqlDir "postgis--TEMPLATED--TO--ANY.sql"
    Set-Content -Path $templatedSql -Encoding UTF8 -Value @"
-- Just tag extension postgis version as "ANY"
-- Installed by postgis $($Version.Version)
-- Built on $buildDate
"@
    Copy-Item -Force $templatedSql (Join-Path $extensionSqlDir "postgis--$($Version.Version)--ANY.sql")
    Set-Content -Path (Join-Path $extensionSqlDir "postgis--unpackaged.sql") -Encoding UTF8 -Value "-- Nothing to do here"
    $unpackagedVersionSql = Join-Path $extensionSqlDir "postgis--unpackaged--$($Version.Version).sql"
    Invoke-PerlFromInputFile $installSql @((Join-Path $PostgisDir "utils/create_unpackaged.pl"), "postgis") $unpackagedVersionSql
    Add-Content -Path $unpackagedVersionSql -Encoding UTF8 -Value (Get-Content -Raw -Path $anyUpgradeSql)
}

function Patch-WindowsPostgisFlatgeobufSource([string]$SourceDir) {
    $geometryReader = Join-Path $SourceDir "geometryreader.cpp"
    $text = Get-Content -Raw -Path $geometryReader
    $pointLiteral = "pt = (POINT4D) { x, y, z, m };"
    $pointAssignments = "pt.x = x;`n`tpt.y = y;`n`tpt.z = z;`n`tpt.m = m;"
    $arrayLiteral = "pt = (POINT4D) { xv, yv, zv, mv };"
    $arrayAssignments = "pt.x = xv;`n`t`tpt.y = yv;`n`t`tpt.z = zv;`n`t`tpt.m = mv;"
    foreach ($expected in @($pointLiteral, $arrayLiteral)) {
        if (-not $text.Contains($expected)) {
            Fail "PostGIS FlatGeobuf geometryreader.cpp is missing expected MSVC patch anchor: $expected"
        }
    }
    $text = $text.Replace($pointLiteral, $pointAssignments)
    $text = $text.Replace($arrayLiteral, $arrayAssignments)
    Set-Content -Path $geometryReader -Encoding UTF8 -Value $text
}

function Build-WindowsPostgisFlatgeobufLibrary([string]$PostgisDir) {
    $prefix = Join-Path $PostgisDependencyPrefix "flatgeobuf"
    $archive = Join-Path $prefix "lib/flatgeobuf.lib"
    if (Test-Path $archive) {
        return $archive
    }
    $sourceDir = Join-Path $PostgisDir "deps/flatgeobuf"
    Patch-WindowsPostgisFlatgeobufSource $sourceDir
    $buildRoot = Join-Path $WorkRoot "postgis-flatgeobuf-windows-build"
    Remove-Item -Recurse -Force $buildRoot, $prefix -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $buildRoot, (Split-Path -Parent $archive) | Out-Null
    $compatHeader = Join-Path $buildRoot "oliphaunt_flatgeobuf_windows_compat.h"
    Set-Content -Path $compatHeader -Encoding UTF8 -Value @"
#ifdef _MSC_VER
#ifndef __attribute__
#define __attribute__(x)
#endif
#ifndef PROJ_DLL
#define PROJ_DLL
#endif
#endif
"@
    $includeArgs = @(
        "/I$(Join-Path $PostgisDir "liblwgeom")",
        "/I$sourceDir",
        "/I$(Join-Path $sourceDir "include")",
        "/I$(Join-Path $PostgisDependencyPrefix "proj/include")"
    )
    $objects = New-Object System.Collections.Generic.List[string]
    foreach ($source in @("flatgeobuf_c.cpp", "geometrywriter.cpp", "geometryreader.cpp", "packedrtree.cpp")) {
        $sourcePath = Join-Path $sourceDir $source
        $object = Join-Path $buildRoot ([System.IO.Path]::GetFileNameWithoutExtension($source) + ".obj")
        Invoke-Logged "postgis-flatgeobuf-$([System.IO.Path]::GetFileNameWithoutExtension($source)).log" {
            cl.exe /nologo /O2 /MD /EHsc /D_CRT_SECURE_NO_WARNINGS /Dflatbuffers=postgis_flatbuffers `
                "/FI$compatHeader" `
                @includeArgs `
                /c $sourcePath "/Fo$object"
        }
        $objects.Add($object)
    }
    Invoke-Logged "postgis-flatgeobuf-lib.log" { lib.exe /nologo "/OUT:$archive" @objects }
    if (-not (Test-Path $archive)) {
        Fail "PostGIS FlatGeobuf Windows build did not produce $archive"
    }
    $archive
}

function Copy-WindowsPostgisRuntimeData([string]$PostgisDir) {
    $projDb = Join-Path $PostgisDependencyPrefix "proj/share/proj/proj.db"
    if (-not (Test-Path $projDb)) {
        Fail "PostGIS PROJ dependency did not produce $projDb"
    }
    $destination = Join-Path $PostgisDir "share/proj"
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    Copy-Item -Force $projDb (Join-Path $destination "proj.db")
}

function Ensure-WindowsPostgisCommentsSql([string]$PostgisDir) {
    $comments = Join-Path $PostgisDir "doc/postgis_comments.sql"
    if (Test-Path $comments) {
        return
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $comments) | Out-Null
    Set-Content -Path $comments -Encoding UTF8 -Value "-- PostGIS SQL comments are optional and are not generated by the Windows native producer."
}

function Patch-WindowsPostgisSource([string]$PostgisDir) {
    $compat = Join-Path $PostgisDir "oliphaunt_postgis_windows_compat.h"
    Set-Content -Path $compat -Encoding UTF8 -Value @"
#ifndef OLIPHAUNT_POSTGIS_WINDOWS_COMPAT_H
#define OLIPHAUNT_POSTGIS_WINDOWS_COMPAT_H

#ifdef _MSC_VER
#ifndef __attribute__
#define __attribute__(x)
#endif
#ifndef __attribute
#define __attribute(x)
#endif
#ifndef FALLTHROUGH
#define FALLTHROUGH ((void)0)
#endif
#ifndef PROJ_DLL
#define PROJ_DLL
#endif
#ifndef strcasecmp
#define strcasecmp _stricmp
#endif
#ifndef strncasecmp
#define strncasecmp _strnicmp
#endif
#endif

#endif
"@

    $declarationPattern = "(?m)^\s*(?!(?:extern\s+)?PGDLLEXPORT\s+)(?:extern\s+)?Datum\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(PG_FUNCTION_ARGS\);\r?$"
    $patchedDeclarationCount = 0
    foreach ($subdir in @("postgis", "libpgcommon", "liblwgeom")) {
        $root = Join-Path $PostgisDir $subdir
        foreach ($file in Get-ChildItem -Path $root -Recurse -File | Where-Object { $_.Extension -in @(".c", ".h") }) {
            $text = Get-Content -Raw -Path $file.FullName
            $patchedDeclarationCount += [regex]::Matches($text, $declarationPattern).Count
            $patched = [regex]::Replace(
                $text,
                $declarationPattern,
                'extern PGDLLEXPORT Datum $1(PG_FUNCTION_ARGS);'
            )
            if ($patched -ne $text) {
                Set-Content -Path $file.FullName -Encoding UTF8 -Value $patched
            }
        }
    }

    if ($patchedDeclarationCount -lt 50) {
        Fail "PostGIS Windows source patch normalized only $patchedDeclarationCount SQL-callable declarations"
    }

    $legacySource = Join-Path $PostgisDir "postgis/postgis_legacy.c"
    $legacyText = Get-Content -Raw -Path $legacySource
    $legacyDeclarationPattern = "(?m)^([ \t]*)Datum[ \t]+funcname[ \t]*\(PG_FUNCTION_ARGS\);[ \t]*\\\r?$"
    $legacyPatched = [regex]::Replace(
        $legacyText,
        $legacyDeclarationPattern,
        '$1extern PGDLLEXPORT Datum funcname(PG_FUNCTION_ARGS); \'
    )
    if ($legacyPatched -eq $legacyText) {
        Fail "PostGIS Windows source patch did not export POSTGIS_DEPRECATE declarations"
    }
    Set-Content -Path $legacySource -Encoding UTF8 -Value $legacyPatched

    $requiredDeclarations = @(
        @{
            Path = "postgis/lwgeom_accum.c"
            Functions = @(
                "pgis_geometry_accum_transfn",
                "pgis_geometry_collect_finalfn",
                "pgis_geometry_polygonize_finalfn",
                "pgis_geometry_makeline_finalfn",
                "pgis_geometry_clusterintersecting_finalfn",
                "pgis_geometry_clusterwithin_finalfn"
            )
        },
        @{
            Path = "postgis/lwgeom_union.c"
            Functions = @(
                "pgis_geometry_union_parallel_transfn",
                "pgis_geometry_union_parallel_combinefn",
                "pgis_geometry_union_parallel_serialfn",
                "pgis_geometry_union_parallel_deserialfn",
                "pgis_geometry_union_parallel_finalfn"
            )
        },
        @{
            Path = "postgis/lwgeom_spheroid.c"
            Functions = @(
                "ellipsoid_in",
                "ellipsoid_out",
                "LWGEOM_length2d_ellipsoid",
                "LWGEOM_length_ellipsoid_linestring",
                "LWGEOM_distance_ellipsoid",
                "LWGEOM_distance_sphere",
                "geometry_distance_spheroid"
            )
        }
    )
    foreach ($required in $requiredDeclarations) {
        $text = Get-Content -Raw -Path (Join-Path $PostgisDir $required.Path)
        foreach ($functionName in $required.Functions) {
            $expected = "extern PGDLLEXPORT Datum $functionName(PG_FUNCTION_ARGS);"
            if (-not $text.Contains($expected)) {
                Fail "PostGIS Windows source patch did not export $functionName in $($required.Path)"
            }
        }
    }
}

function Write-PostgisMesonModule([string]$PostgisDir, [pscustomobject]$Version, [string]$FlatgeobufLib) {
    $jsonLib = First-File (Join-Path $PostgisDependencyPrefix "json-c") @("json-c.lib", "json-c-static.lib")
    $sqliteLib = First-File (Join-Path $PostgisDependencyPrefix "sqlite") @("sqlite3.lib", "libsqlite3.lib")
    $geosCLib = First-File (Join-Path $PostgisDependencyPrefix "geos") @("geos_c.lib")
    $geosLib = First-File (Join-Path $PostgisDependencyPrefix "geos") @("geos.lib")
    $libxml2Lib = First-File (Join-Path $PostgisDependencyPrefix "libxml2") @("libxml2s.lib", "libxml2.lib", "xml2.lib")
    $projLib = First-File (Join-Path $PostgisDependencyPrefix "proj") @("proj.lib", "libproj.lib")

    $sources = @(
        "postgis/postgis_module.c",
        "postgis/lwgeom_accum.c",
        "postgis/lwgeom_union.c",
        "postgis/lwgeom_spheroid.c",
        "postgis/lwgeom_ogc.c",
        "postgis/lwgeom_functions_analytic.c",
        "postgis/lwgeom_functions_basic.c",
        "postgis/lwgeom_inout.c",
        "postgis/lwgeom_btree.c",
        "postgis/lwgeom_box.c",
        "postgis/lwgeom_box3d.c",
        "postgis/lwgeom_geos.c",
        "postgis/lwgeom_geos_predicates.c",
        "postgis/lwgeom_geos_prepared.c",
        "postgis/lwgeom_geos_clean.c",
        "postgis/lwgeom_geos_relatematch.c",
        "postgis/lwgeom_generate_grid.c",
        "postgis/lwgeom_export.c",
        "postgis/lwgeom_in_gml.c",
        "postgis/lwgeom_in_kml.c",
        "postgis/lwgeom_in_marc21.c",
        "postgis/lwgeom_out_marc21.c",
        "postgis/lwgeom_in_geohash.c",
        "postgis/lwgeom_in_geojson.c",
        "postgis/lwgeom_in_encoded_polyline.c",
        "postgis/lwgeom_triggers.c",
        "postgis/lwgeom_dump.c",
        "postgis/lwgeom_dumppoints.c",
        "postgis/lwgeom_functions_lrs.c",
        "postgis/lwgeom_functions_temporal.c",
        "postgis/lwgeom_rectree.c",
        "postgis/lwgeom_itree.c",
        "postgis/lwgeom_sqlmm.c",
        "postgis/lwgeom_transform.c",
        "postgis/lwgeom_window.c",
        "postgis/gserialized_typmod.c",
        "postgis/gserialized_gist_2d.c",
        "postgis/gserialized_gist_nd.c",
        "postgis/gserialized_supportfn.c",
        "postgis/gserialized_spgist_2d.c",
        "postgis/gserialized_spgist_3d.c",
        "postgis/gserialized_spgist_nd.c",
        "postgis/brin_2d.c",
        "postgis/brin_nd.c",
        "postgis/brin_common.c",
        "postgis/gserialized_estimate.c",
        "postgis/geography_inout.c",
        "postgis/geography_btree.c",
        "postgis/geography_centroid.c",
        "postgis/geography_measurement.c",
        "postgis/geography_measurement_trees.c",
        "postgis/geometry_inout.c",
        "postgis/postgis_libprotobuf.c",
        "postgis/mvt.c",
        "postgis/lwgeom_out_mvt.c",
        "postgis/geobuf.c",
        "postgis/lwgeom_out_geobuf.c",
        "postgis/lwgeom_out_geojson.c",
        "postgis/flatgeobuf.c",
        "postgis/lwgeom_in_flatgeobuf.c",
        "postgis/lwgeom_out_flatgeobuf.c",
        "postgis/lwgeom_remove_irrelevant_points_for_view.c",
        "postgis/lwgeom_remove_small_parts.c",
        "postgis/postgis_legacy.c",
        "libpgcommon/gserialized_gist.c",
        "libpgcommon/lwgeom_transform.c",
        "libpgcommon/lwgeom_cache.c",
        "libpgcommon/lwgeom_pg.c",
        "libpgcommon/shared_gserialized.c",
        "liblwgeom/stringbuffer.c",
        "liblwgeom/optionlist.c",
        "liblwgeom/stringlist.c",
        "liblwgeom/bytebuffer.c",
        "liblwgeom/measures.c",
        "liblwgeom/measures3d.c",
        "liblwgeom/ptarray.c",
        "liblwgeom/lookup3.c",
        "liblwgeom/lwgeom_api.c",
        "liblwgeom/lwgeom.c",
        "liblwgeom/lwpoint.c",
        "liblwgeom/lwline.c",
        "liblwgeom/lwpoly.c",
        "liblwgeom/lwtriangle.c",
        "liblwgeom/lwmpoint.c",
        "liblwgeom/lwmline.c",
        "liblwgeom/lwmpoly.c",
        "liblwgeom/lwboundingcircle.c",
        "liblwgeom/lwcollection.c",
        "liblwgeom/lwcircstring.c",
        "liblwgeom/lwcompound.c",
        "liblwgeom/lwcurvepoly.c",
        "liblwgeom/lwmcurve.c",
        "liblwgeom/lwmsurface.c",
        "liblwgeom/lwpsurface.c",
        "liblwgeom/lwtin.c",
        "liblwgeom/lwout_wkb.c",
        "liblwgeom/lwin_geojson.c",
        "liblwgeom/lwin_wkb.c",
        "liblwgeom/lwin_twkb.c",
        "liblwgeom/lwiterator.c",
        "liblwgeom/lwgeom_median.c",
        "liblwgeom/lwout_wkt.c",
        "liblwgeom/lwout_twkb.c",
        "liblwgeom/lwin_wkt_parse.c",
        "liblwgeom/lwin_wkt_lex.c",
        "liblwgeom/lwin_wkt.c",
        "liblwgeom/lwin_encoded_polyline.c",
        "liblwgeom/lwutil.c",
        "liblwgeom/lwhomogenize.c",
        "liblwgeom/intervaltree.c",
        "liblwgeom/lwalgorithm.c",
        "liblwgeom/lwstroke.c",
        "liblwgeom/lwlinearreferencing.c",
        "liblwgeom/lwprint.c",
        "liblwgeom/gbox.c",
        "liblwgeom/gserialized.c",
        "liblwgeom/gserialized1.c",
        "liblwgeom/gserialized2.c",
        "liblwgeom/lwgeodetic.c",
        "liblwgeom/lwgeodetic_measures.c",
        "liblwgeom/lwgeodetic_tree.c",
        "liblwgeom/lwrandom.c",
        "liblwgeom/lwtree.c",
        "liblwgeom/lwout_gml.c",
        "liblwgeom/lwout_kml.c",
        "liblwgeom/lwout_geojson.c",
        "liblwgeom/lwout_svg.c",
        "liblwgeom/lwout_x3d.c",
        "liblwgeom/lwout_encoded_polyline.c",
        "liblwgeom/lwgeom_debug.c",
        "liblwgeom/lwgeom_geos.c",
        "liblwgeom/lwgeom_geos_clean.c",
        "liblwgeom/lwgeom_geos_cluster.c",
        "liblwgeom/lwgeom_geos_node.c",
        "liblwgeom/lwgeom_geos_split.c",
        "liblwgeom/topo/lwgeom_topo.c",
        "liblwgeom/topo/lwgeom_topo_polygonizer.c",
        "liblwgeom/topo/lwt_edgeend.c",
        "liblwgeom/topo/lwt_edgeend_star.c",
        "liblwgeom/topo/lwt_node_edges.c",
        "liblwgeom/lwgeom_transform.c",
        "liblwgeom/lwgeom_wrapx.c",
        "liblwgeom/lwunionfind.c",
        "liblwgeom/effectivearea.c",
        "liblwgeom/lwchaikins.c",
        "liblwgeom/lwmval.c",
        "liblwgeom/lwkmeans.c",
        "liblwgeom/varint.c",
        "liblwgeom/lwgeom_remove_irrelevant_points_for_view.c",
        "liblwgeom/lwspheroid.c",
        "deps/ryu/d2s.c"
    )
    $extensionSqlFiles = @(
        "extensions/postgis/postgis.control",
        "extensions/postgis/sql/postgis--$($Version.Version).sql",
        "extensions/postgis/sql/postgis--ANY--$($Version.Version).sql",
        "extensions/postgis/sql/postgis--$($Version.Version)--ANY.sql",
        "extensions/postgis/sql/postgis--TEMPLATED--TO--ANY.sql",
        "extensions/postgis/sql/postgis--unpackaged.sql",
        "extensions/postgis/sql/postgis--unpackaged--$($Version.Version).sql"
    )
    $contribDataFiles = @(
        "postgis/legacy.sql",
        "postgis/legacy_gist.sql",
        "postgis/legacy_minimal.sql",
        "postgis/postgis.sql",
        "postgis/postgis_upgrade.sql",
        "spatial_ref_sys.sql",
        "postgis/uninstall_legacy.sql",
        "postgis/uninstall_postgis.sql",
        "doc/postgis_comments.sql"
    )
    $includeArgs = @(
        "/I$(Meson-Path $PostgisDir)",
        # liblwgeom has headers with the same basename as the PostgreSQL module.
        # Source-local includes still win for postgis/*.c; this order keeps
        # liblwgeom/topo/*.c from accidentally including server-side headers.
        "/I$(Meson-Path (Join-Path $PostgisDir "liblwgeom"))",
        "/I$(Meson-Path (Join-Path $PostgisDir "postgis"))",
        "/I$(Meson-Path (Join-Path $PostgisDir "libpgcommon"))",
        "/I$(Meson-Path (Join-Path $PostgisDir "deps"))",
        "/I$(Meson-Path (Join-Path $PostgisDir "deps/flatgeobuf"))",
        "/I$(Meson-Path (Join-Path $PostgisDir "deps/flatgeobuf/include"))",
        "/I$(Meson-Path (Join-Path $PostgisDir "deps/ryu"))",
        "/I$(Meson-Path (Join-Path $PostgisDependencyPrefix "geos/include"))",
        "/I$(Meson-Path (Join-Path $PostgisDependencyPrefix "proj/include"))",
        "/I$(Meson-Path (Join-Path $PostgisDependencyPrefix "json-c/include"))",
        "/I$(Meson-Path (Join-Path $PostgisDependencyPrefix "json-c/include/json-c"))",
        "/I$(Meson-Path (Join-Path $PostgisDependencyPrefix "libxml2/include/libxml2"))"
    )
    $cArgs = @(
        "/D_CRT_SECURE_NO_WARNINGS",
        "/D_USE_MATH_DEFINES",
        "/DLIBXML_STATIC",
        "/DRYU_NO_TRAILING_ZEROS",
        "/FI$(Meson-Path (Join-Path $PostgisDir "oliphaunt_postgis_windows_compat.h"))"
    ) + $includeArgs
    $linkArgs = @(
        (Meson-Path $FlatgeobufLib),
        (Meson-Path $geosCLib),
        (Meson-Path $geosLib),
        (Meson-Path $projLib),
        (Meson-Path $sqliteLib),
        (Meson-Path $jsonLib),
        (Meson-Path $libxml2Lib),
        "ws2_32.lib",
        "bcrypt.lib",
        "advapi32.lib",
        "shell32.lib",
        "user32.lib"
    )

    $sourceList = Meson-List $sources
    $cArgList = Meson-List $cArgs "    "
    $linkArgList = Meson-List $linkArgs "    "
    $extensionDataList = Meson-List $extensionSqlFiles
    $contribDataList = Meson-List $contribDataFiles
    $meson = @"
postgis = shared_module(
  'postgis-3',
  files(
$sourceList,
  ),
  c_pch: pch_postgres_h,
  kwargs: contrib_mod_args + {
    'c_args': [
$cArgList
    ],
    'link_args': [
$linkArgList
    ],
  },
)
contrib_targets += postgis

install_data(
$extensionDataList,
  kwargs: contrib_data_args,
)

install_data(
$contribDataList,
  install_dir: dir_data / 'contrib' / 'postgis-$($Version.MajorMinor)',
)

install_data(
  'share/proj/proj.db',
  install_dir: dir_data / 'proj',
)
"@
    Set-Content -Path (Join-Path $PostgisDir "meson.build") -Encoding UTF8 -Value $meson
    Append-OliphauntContribSubdir "postgis"
}

function Add-PostgisMesonProducer {
    if (-not (NativeExtension-Selected "postgis")) {
        return
    }
    $previousSourceDateEpoch = $env:SOURCE_DATE_EPOCH
    $env:SOURCE_DATE_EPOCH = [string](Get-PostgisSourceDateEpoch)
    try {
        Build-WindowsPostgisDependencies
        $sourceDir = External-Checkout "postgis"
        if (-not (Test-Path (Join-Path $sourceDir "Version.config"))) {
            Fail "missing PostGIS checkout for Windows extension artifacts: $sourceDir"
        }
        $destination = Join-Path $OliphauntContribDir "postgis"
        Copy-SourceTree $sourceDir $destination
        $version = Initialize-WindowsPostgisGeneratedSource $destination $sourceDir
        Build-WindowsPostgisSql $destination $version
        Ensure-WindowsPostgisCommentsSql $destination
        Patch-WindowsPostgisSource $destination
        Copy-WindowsPostgisRuntimeData $destination
        $flatgeobufLib = Build-WindowsPostgisFlatgeobufLibrary $destination
        Write-PostgisMesonModule $destination $version $flatgeobufLib
    } finally {
        if ($null -eq $previousSourceDateEpoch) {
            Remove-Item Env:SOURCE_DATE_EPOCH -ErrorAction SilentlyContinue
        } else {
            $env:SOURCE_DATE_EPOCH = $previousSourceDateEpoch
        }
    }
}

function Add-PgcryptoMesonProducer {
    if (-not (NativeExtension-Selected "pgcrypto")) {
        return
    }
    Build-WindowsOpenSslDependency
    $opensslInclude = Meson-Path (Join-Path $OpenSslDependencyPrefix "include")
    $libCrypto = Meson-Path (Join-Path $OpenSslDependencyPrefix "lib/libcrypto.lib")
    Write-OliphauntMesonModule `
        "pgcrypto" `
        "pgcrypto" `
        @(
            "../../pgcrypto/crypt-blowfish.c",
            "../../pgcrypto/crypt-des.c",
            "../../pgcrypto/crypt-gensalt.c",
            "../../pgcrypto/crypt-md5.c",
            "../../pgcrypto/crypt-sha.c",
            "../../pgcrypto/mbuf.c",
            "../../pgcrypto/openssl.c",
            "../../pgcrypto/pgcrypto.c",
            "../../pgcrypto/pgp-armor.c",
            "../../pgcrypto/pgp-cfb.c",
            "../../pgcrypto/pgp-compress.c",
            "../../pgcrypto/pgp-decrypt.c",
            "../../pgcrypto/pgp-encrypt.c",
            "../../pgcrypto/pgp-info.c",
            "../../pgcrypto/pgp-mpi.c",
            "../../pgcrypto/pgp-mpi-openssl.c",
            "../../pgcrypto/pgp-pgsql.c",
            "../../pgcrypto/pgp-pubdec.c",
            "../../pgcrypto/pgp-pubenc.c",
            "../../pgcrypto/pgp-pubkey.c",
            "../../pgcrypto/pgp-s2k.c",
            "../../pgcrypto/pgp.c",
            "../../pgcrypto/px-crypt.c",
            "../../pgcrypto/px-hmac.c",
            "../../pgcrypto/px.c"
        ) `
        @(
            "../../pgcrypto/pgcrypto--1.0--1.1.sql",
            "../../pgcrypto/pgcrypto--1.1--1.2.sql",
            "../../pgcrypto/pgcrypto--1.2--1.3.sql",
            "../../pgcrypto/pgcrypto--1.3.sql",
            "../../pgcrypto/pgcrypto--1.3--1.4.sql",
            "../../pgcrypto/pgcrypto.control"
        ) `
        @("/I$opensslInclude") `
        @($libCrypto, "crypt32.lib", "advapi32.lib", "bcrypt.lib", "ws2_32.lib", "user32.lib")
}

function Add-UuidOsspMesonProducer {
    if (-not (NativeExtension-Selected "uuid-ossp")) {
        return
    }
    $destination = Join-Path $OliphauntContribDir "uuid_ossp"
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    Copy-Item -Force (Join-Path $PortableUuidDir "portable_uuid.c") (Join-Path $destination "portable_uuid.c")
    $portableUuidInclude = Meson-Path $PortableUuidIncludeDir
    Write-OliphauntMesonModule `
        "uuid_ossp" `
        "uuid-ossp" `
        @("../../uuid-ossp/uuid-ossp.c", "portable_uuid.c") `
        @(
            "../../uuid-ossp/uuid-ossp--1.0--1.1.sql",
            "../../uuid-ossp/uuid-ossp--1.1.sql",
            "../../uuid-ossp/uuid-ossp.control"
        ) `
        @("/I$portableUuidInclude", "/DHAVE_UUID_E2FS=1", "/DHAVE_UUID_UUID_H=1")
}

function Patch-PgTextsearchWindowsSource([string]$ExtensionDir) {
    $compat = Join-Path $ExtensionDir "src/oliphaunt_windows_compat.h"
    Set-Content -Path $compat -Encoding UTF8 -Value @"
#ifdef _MSC_VER
#ifndef __attribute__
#define __attribute__(x)
#endif
#endif
"@
    Set-Content -Path (Join-Path $ExtensionDir "src/unistd.h") -Encoding UTF8 -Value @"
#ifndef OLIPHAUNT_PG_TEXTSEARCH_WINDOWS_UNISTD_H
#define OLIPHAUNT_PG_TEXTSEARCH_WINDOWS_UNISTD_H
#endif
"@
    $segmentHeader = Join-Path $ExtensionDir "src/segment/segment.h"
    $text = Get-Content -Raw -Path $segmentHeader
    $text = $text.Replace("} __attribute__((aligned(4))) TpDictEntry;", "} TpDictEntry;")
    $text = $text.Replace(
        "typedef struct TpSegmentPosting",
        "#ifdef _MSC_VER`n#pragma pack(push, 1)`n#endif`ntypedef struct TpSegmentPosting"
    )
    $text = $text.Replace(
        "} __attribute__((packed)) TpSegmentPosting;",
        "} TpSegmentPosting;`n#ifdef _MSC_VER`n#pragma pack(pop)`n#endif"
    )
    $text = $text.Replace(
        "typedef struct TpSkipEntry",
        "#ifdef _MSC_VER`n#pragma pack(push, 1)`n#endif`ntypedef struct TpSkipEntry"
    )
    $text = $text.Replace(
        "} __attribute__((packed)) TpSkipEntry;",
        "} TpSkipEntry;`n#ifdef _MSC_VER`n#pragma pack(pop)`n#endif"
    )
    $text = $text.Replace(
        "typedef struct TpCtidMapEntry",
        "#ifdef _MSC_VER`n#pragma pack(push, 1)`n#endif`ntypedef struct TpCtidMapEntry"
    )
    $text = $text.Replace(
        "} __attribute__((packed)) TpCtidMapEntry;",
        "} TpCtidMapEntry;`n#ifdef _MSC_VER`n#pragma pack(pop)`n#endif"
    )
    Set-Content -Path $segmentHeader -Encoding UTF8 -Value $text

    $amHeader = Join-Path $ExtensionDir "src/am/am.h"
    $text = Get-Content -Raw -Path $amHeader
    $original = "Datum tp_handler(PG_FUNCTION_ARGS);"
    $replacement = "extern PGDLLEXPORT Datum tp_handler(PG_FUNCTION_ARGS);"
    if (-not $text.Contains($original)) {
        Fail "pg_textsearch am.h is missing expected tp_handler declaration"
    }
    $text = $text.Replace($original, $replacement)
    Set-Content -Path $amHeader -Encoding UTF8 -Value $text

    $vectorHeader = Join-Path $ExtensionDir "src/types/vector.h"
    $text = Get-Content -Raw -Path $vectorHeader
    foreach ($functionName in @("tpvector_in", "tpvector_out", "tpvector_recv", "tpvector_send", "to_tpvector", "tpvector_eq")) {
        $original = "Datum $($functionName)(PG_FUNCTION_ARGS);"
        $replacement = "extern PGDLLEXPORT Datum $($functionName)(PG_FUNCTION_ARGS);"
        if (-not $text.Contains($original)) {
            Fail "pg_textsearch vector.h is missing expected $functionName declaration"
        }
        $text = $text.Replace($original, $replacement)
    }
    Set-Content -Path $vectorHeader -Encoding UTF8 -Value $text

    $queryHeader = Join-Path $ExtensionDir "src/types/query.h"
    $text = Get-Content -Raw -Path $queryHeader
    foreach ($functionName in @(
        "tpquery_in",
        "tpquery_out",
        "tpquery_recv",
        "tpquery_send",
        "to_tpquery_text",
        "to_tpquery_text_index",
        "bm25_text_bm25query_score",
        "bm25_text_text_score",
        "tpquery_eq"
    )) {
        $original = "Datum $($functionName)(PG_FUNCTION_ARGS);"
        $replacement = "extern PGDLLEXPORT Datum $($functionName)(PG_FUNCTION_ARGS);"
        if (-not $text.Contains($original)) {
            Fail "pg_textsearch query.h is missing expected $functionName declaration"
        }
        $text = $text.Replace($original, $replacement)
    }
    Set-Content -Path $queryHeader -Encoding UTF8 -Value $text
}

function Patch-PgUuidv7WindowsSource([string]$ExtensionDir) {
    $source = Join-Path $ExtensionDir "pg_uuidv7.c"
    $text = Get-Content -Raw -Path $source
    $epochDefine = "#define EPOCH_DIFF_USECS ((POSTGRES_EPOCH_JDATE - UNIX_EPOCH_JDATE) * USECS_PER_DAY)"
    $compat = @"
#define EPOCH_DIFF_USECS ((POSTGRES_EPOCH_JDATE - UNIX_EPOCH_JDATE) * USECS_PER_DAY)

#ifdef _WIN32
#ifndef CLOCK_REALTIME
#define CLOCK_REALTIME 0
#endif
static int
oliphaunt_pg_uuidv7_clock_gettime(int clock_id, struct timespec *ts)
{
	TimestampTz unix_usecs;

	if (clock_id != CLOCK_REALTIME || ts == NULL)
		return -1;

	unix_usecs = GetCurrentTimestamp() + EPOCH_DIFF_USECS;
	ts->tv_sec = (time_t) (unix_usecs / USECS_PER_SEC);
	ts->tv_nsec = (long) ((unix_usecs % USECS_PER_SEC) * 1000);
	return 0;
}
#define clock_gettime oliphaunt_pg_uuidv7_clock_gettime
#endif
"@
    if (-not $text.Contains($epochDefine)) {
        Fail "pg_uuidv7.c is missing expected epoch define"
    }
    $text = $text.Replace($epochDefine, $compat)
    Set-Content -Path $source -Encoding UTF8 -Value $text
}

function Add-ExternalPgxsMesonProducer(
    [string]$SqlName,
    [string]$CheckoutName,
    [string]$Subdir,
    [string]$ModuleName,
    [string[]]$Sources,
    [string[]]$DataFiles,
    [string[]]$CArgs = @(),
    [string[]]$LocalIncludeDirs = @()
) {
    if (-not (NativeExtension-Selected $SqlName)) {
        return
    }
    $destination = Join-Path $OliphauntContribDir $Subdir
    Copy-SourceTree (External-Checkout $CheckoutName) $destination
    if ($SqlName -eq "pg_uuidv7") {
        Patch-PgUuidv7WindowsSource $destination
    }
    if ($SqlName -eq "pg_textsearch") {
        Patch-PgTextsearchWindowsSource $destination
        $compatHeader = Meson-Path (Join-Path $destination "src/oliphaunt_windows_compat.h")
        $CArgs = @($CArgs) + @("/FI$compatHeader")
    }
    if ($SqlName -eq "vector") {
        Copy-Item -Force (Join-Path $destination "sql/vector.sql") (Join-Path $destination "sql/vector--0.8.2.sql")
    }
    Write-OliphauntMesonModule $Subdir $ModuleName $Sources $DataFiles $CArgs @() $LocalIncludeDirs
}

function Add-ExternalPgxsMesonProducers {
    Add-ExternalPgxsMesonProducer `
        "pg_hashids" "pg_hashids" "pg_hashids" "pg_hashids" `
        @("pg_hashids.c", "hashids.c") `
        @(
            "pg_hashids--1.3.sql",
            "pg_hashids--1.2.1--1.3.sql",
            "pg_hashids--1.2--1.3.sql",
            "pg_hashids--1.1--1.2.sql",
            "pg_hashids--1.0--1.1.sql",
            "pg_hashids.control"
        )
    Add-ExternalPgxsMesonProducer `
        "pg_ivm" "pg_ivm" "pg_ivm" "pg_ivm" `
        @("createas.c", "matview.c", "pg_ivm.c", "ruleutils.c", "subselect.c") `
        @(
            "pg_ivm--1.0.sql",
            "pg_ivm--1.0--1.1.sql",
            "pg_ivm--1.1--1.2.sql",
            "pg_ivm--1.2--1.3.sql",
            "pg_ivm--1.3--1.4.sql",
            "pg_ivm--1.4--1.5.sql",
            "pg_ivm--1.5--1.6.sql",
            "pg_ivm--1.6--1.7.sql",
            "pg_ivm--1.7--1.8.sql",
            "pg_ivm--1.8--1.9.sql",
            "pg_ivm--1.9--1.10.sql",
            "pg_ivm--1.10.sql",
            "pg_ivm--1.10--1.11.sql",
            "pg_ivm--1.11--1.12.sql",
            "pg_ivm--1.12--1.13.sql",
            "pg_ivm.control"
        )
    Add-ExternalPgxsMesonProducer `
        "pg_uuidv7" "pg_uuidv7" "pg_uuidv7" "pg_uuidv7" `
        @("pg_uuidv7.c") `
        @(
            "sql/pg_uuidv7--1.7.sql",
            "pg_uuidv7.control"
        )
    Add-ExternalPgxsMesonProducer `
        "pg_textsearch" "pg_textsearch" "pg_textsearch" "pg_textsearch" `
        @(
            "src/mod.c",
            "src/source.c",
            "src/am/handler.c",
            "src/am/build.c",
            "src/am/build_parallel.c",
            "src/am/scan.c",
            "src/am/vacuum.c",
            "src/memtable/memtable.c",
            "src/memtable/posting.c",
            "src/memtable/stringtable.c",
            "src/memtable/local_memtable.c",
            "src/memtable/scan.c",
            "src/memtable/source.c",
            "src/segment/segment.c",
            "src/segment/dictionary.c",
            "src/segment/scan.c",
            "src/segment/merge.c",
            "src/segment/docmap.c",
            "src/segment/compression.c",
            "src/query/bmw.c",
            "src/query/score.c",
            "src/types/vector.c",
            "src/types/query.c",
            "src/state/state.c",
            "src/state/registry.c",
            "src/state/metapage.c",
            "src/state/limit.c",
            "src/planner/hooks.c",
            "src/planner/cost.c",
            "src/debug/dump.c"
        ) `
        @(
            "sql/pg_textsearch--0.5.1.sql",
            "sql/pg_textsearch--0.0.1--0.0.2.sql",
            "sql/pg_textsearch--0.0.2--0.0.3.sql",
            "sql/pg_textsearch--0.0.3--0.0.4.sql",
            "sql/pg_textsearch--0.0.4--0.0.5.sql",
            "sql/pg_textsearch--0.0.5--0.1.0.sql",
            "sql/pg_textsearch--0.1.0--0.2.0.sql",
            "sql/pg_textsearch--0.2.0--0.3.0.sql",
            "sql/pg_textsearch--0.3.0--0.4.0.sql",
            "sql/pg_textsearch--0.4.0--0.4.1.sql",
            "sql/pg_textsearch--0.4.1--0.4.2.sql",
            "sql/pg_textsearch--0.4.2--0.5.0.sql",
            "sql/pg_textsearch--0.5.0--0.5.1.sql",
            "pg_textsearch.control"
        ) `
        @("/D_CRT_SECURE_NO_WARNINGS") `
        @("src")
    Add-ExternalPgxsMesonProducer `
        "vector" "pgvector" "vector" "vector" `
        @(
            "src/bitutils.c",
            "src/bitvec.c",
            "src/halfutils.c",
            "src/halfvec.c",
            "src/hnsw.c",
            "src/hnswbuild.c",
            "src/hnswinsert.c",
            "src/hnswscan.c",
            "src/hnswutils.c",
            "src/hnswvacuum.c",
            "src/ivfbuild.c",
            "src/ivfflat.c",
            "src/ivfinsert.c",
            "src/ivfkmeans.c",
            "src/ivfscan.c",
            "src/ivfutils.c",
            "src/ivfvacuum.c",
            "src/sparsevec.c",
            "src/vector.c"
        ) `
        @(
            "sql/vector--0.1.0--0.1.1.sql",
            "sql/vector--0.1.1--0.1.3.sql",
            "sql/vector--0.1.3--0.1.4.sql",
            "sql/vector--0.1.4--0.1.5.sql",
            "sql/vector--0.1.5--0.1.6.sql",
            "sql/vector--0.1.6--0.1.7.sql",
            "sql/vector--0.1.7--0.1.8.sql",
            "sql/vector--0.1.8--0.2.0.sql",
            "sql/vector--0.2.0--0.2.1.sql",
            "sql/vector--0.2.1--0.2.2.sql",
            "sql/vector--0.2.2--0.2.3.sql",
            "sql/vector--0.2.3--0.2.4.sql",
            "sql/vector--0.2.4--0.2.5.sql",
            "sql/vector--0.2.5--0.2.6.sql",
            "sql/vector--0.2.6--0.2.7.sql",
            "sql/vector--0.2.7--0.3.0.sql",
            "sql/vector--0.3.0--0.3.1.sql",
            "sql/vector--0.3.1--0.3.2.sql",
            "sql/vector--0.3.2--0.4.0.sql",
            "sql/vector--0.4.0--0.4.1.sql",
            "sql/vector--0.4.1--0.4.2.sql",
            "sql/vector--0.4.2--0.4.3.sql",
            "sql/vector--0.4.3--0.4.4.sql",
            "sql/vector--0.4.4--0.5.0.sql",
            "sql/vector--0.5.0--0.5.1.sql",
            "sql/vector--0.5.1--0.6.0.sql",
            "sql/vector--0.6.0--0.6.1.sql",
            "sql/vector--0.6.1--0.6.2.sql",
            "sql/vector--0.6.2--0.7.0.sql",
            "sql/vector--0.7.0--0.7.1.sql",
            "sql/vector--0.7.1--0.7.2.sql",
            "sql/vector--0.7.2--0.7.3.sql",
            "sql/vector--0.7.3--0.7.4.sql",
            "sql/vector--0.7.4--0.8.0.sql",
            "sql/vector--0.8.0--0.8.1.sql",
            "sql/vector--0.8.1--0.8.2.sql",
            "sql/vector--0.8.2.sql",
            "vector.control"
        ) `
        @("/fp:fast")
}

function Prepare-WindowsExtensionInputs {
    if ($BuildExtensions -eq "0") {
        return
    }
    Assert-WindowsNativeExtensionSelectionSupported
    Add-PgcryptoMesonProducer
    Add-UuidOsspMesonProducer
    Add-ExternalPgxsMesonProducers
    Add-PostgisMesonProducer
}

function Expand-PgtapSqlTemplate([string]$InputPath, [string]$OutputPath, [string]$ModulePath) {
    $text = Get-Content -Raw -Path $InputPath
    $text = $text.Replace("MODULE_PATHNAME", $ModulePath)
    $text = $text.Replace("__OS__", "MSWin32")
    $text = $text.Replace("__VERSION__", "1.3")
    Set-Content -Path $OutputPath -Encoding UTF8 -Value $text
}

function Install-WindowsPgtapExtension {
    if (-not (NativeExtension-Selected "pgtap")) {
        return
    }
    $sourceDir = External-Checkout "pgtap"
    if (-not (Test-Path (Join-Path $sourceDir "pgtap.control"))) {
        Fail "missing pgTAP checkout for Windows extension artifact staging: $sourceDir"
    }
    $buildDir = Join-Path $WorkRoot "pgtap-windows"
    Copy-SourceTree $sourceDir $buildDir
    $sqlDir = Join-Path $buildDir "sql"
    Expand-PgtapSqlTemplate (Join-Path $sqlDir "pgtap.sql.in") (Join-Path $sqlDir "pgtap.sql") "pgtap"
    foreach ($input in Get-ChildItem -Path $sqlDir -Filter "*.sql.in" -File) {
        $output = Join-Path $sqlDir ($input.Name.Substring(0, $input.Name.Length - 3))
        if (-not (Test-Path $output)) {
            Copy-Item -Force $input.FullName $output
        }
    }
    Expand-PgtapSqlTemplate (Join-Path $sqlDir "pgtap.sql.in") (Join-Path $sqlDir "pgtap-static.sql") '$libdir/pgtap'
    $coreSql = Join-Path $sqlDir "pgtap-core.sql"
    $schemaSql = Join-Path $sqlDir "pgtap-schema.sql"
    & perl (Join-Path $buildDir "compat/gencore") 0 (Join-Path $sqlDir "pgtap-static.sql") > $coreSql
    if ($LASTEXITCODE -ne 0) {
        Fail "pgTAP core SQL generation failed"
    }
    & perl (Join-Path $buildDir "compat/gencore") 1 (Join-Path $sqlDir "pgtap-static.sql") > $schemaSql
    if ($LASTEXITCODE -ne 0) {
        Fail "pgTAP schema SQL generation failed"
    }
    $uninstallSql = Join-Path $sqlDir "uninstall_pgtap.sql"
    & perl -e 'for (grep { /^CREATE /} reverse <>) { chomp; s/CREATE (OR REPLACE )?/DROP /; s/DROP (FUNCTION|VIEW|TYPE) /DROP $1 IF EXISTS /; s/ (DEFAULT|=)[ ]+[a-zA-Z0-9]+//g; print "$_;\n" }' (Join-Path $sqlDir "pgtap.sql") > $uninstallSql
    if ($LASTEXITCODE -ne 0) {
        Fail "pgTAP uninstall SQL generation failed"
    }
    Copy-Item -Force (Join-Path $sqlDir "pgtap.sql") (Join-Path $sqlDir "pgtap--1.3.5.sql")
    Copy-Item -Force $coreSql (Join-Path $sqlDir "pgtap-core--1.3.5.sql")
    Copy-Item -Force $schemaSql (Join-Path $sqlDir "pgtap-schema--1.3.5.sql")

    $extensionDir = Join-Path $InstallDir "share/postgresql/extension"
    New-Item -ItemType Directory -Force -Path $extensionDir | Out-Null
    Copy-Item -Force (Join-Path $buildDir "pgtap.control") (Join-Path $extensionDir "pgtap.control")
    Copy-Item -Force (Join-Path $sqlDir "pgtap*.sql") $extensionDir
    Copy-Item -Force $uninstallSql $extensionDir
    if (-not (Test-Path (Join-Path $extensionDir "pgtap--1.3.5.sql"))) {
        Fail "pgTAP Windows staging did not produce pgtap--1.3.5.sql"
    }
}

function Get-ExactExtensionCatalogRows([string]$Purpose) {
    if ($null -eq $script:ExactExtensionCatalogRows) {
        Push-Location $RepoRoot
        try {
            $catalogText = cargo run -p oliphaunt --bin oliphaunt-resources --locked -- --list-extensions
            $exitCode = $LASTEXITCODE
        } finally {
            Pop-Location
        }
        if ($exitCode -ne 0 -or -not $catalogText) {
            Fail "failed to read exact extension catalog for $Purpose"
        }
        $script:ExactExtensionCatalogRows = @($catalogText | Select-Object -Skip 1)
    }
    $script:ExactExtensionCatalogRows
}

function Get-SelectedEmbeddedExtensionModules {
    if ($BuildExtensions -eq "0") {
        return
    }
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($row in (Get-ExactExtensionCatalogRows "Windows embedded extension module linkage")) {
        if (-not $row) {
            continue
        }
        $columns = $row -split "`t", 12
        if ($columns.Count -lt 12) {
            Fail "malformed extension catalog row while selecting Windows embedded modules: $row"
        }
        $sqlName = $columns[0]
        $stem = $columns[3]
        if (-not (NativeExtension-Selected $sqlName) -or -not $stem -or $stem -eq "-") {
            continue
        }
        if ($seen.Add($stem)) {
            [PSCustomObject]@{
                SqlName = $sqlName
                Stem = $stem
            }
        }
    }
}

function Runtime-Installed([string]$DesiredHash) {
    return (Test-Path (Join-Path $InstallDir "bin/initdb.exe")) -and
        (Test-Path (Join-Path $InstallDir "bin/postgres.exe")) -and
        (Test-Path (Join-Path $InstallDir "bin/pg_config.exe")) -and
        (Test-Path (Join-Path $InstallDir "share/postgresql/postgresql.conf.sample")) -and
        (Test-Path (Join-Path $InstallDir "share/postgresql/timezone/UTC")) -and
        (Test-Path (Join-Path $InstallDir ".oliphaunt-postgres-runtime.sha256")) -and
        ((Get-Content (Join-Path $InstallDir ".oliphaunt-postgres-runtime.sha256") -Raw).Trim() -eq $DesiredHash) -and
        (($BuildExtensions -ne "0") -or (BaseRuntimeOptionalExtensionsAbsent))
}

function Build-Runtime([string]$DesiredHash) {
    if (Runtime-Installed $DesiredHash) {
        return
    }
    Write-MesonNativeFile $RuntimeNativeFile $false
    $options = @(
        "--native-file", $RuntimeNativeFile,
        "--prefix", $InstallDir,
        "--buildtype=release",
        "-Db_pch=false",
        "-Dreadline=disabled",
        "-Dicu=disabled",
        "-Dldap=disabled",
        "-Dllvm=disabled",
        "-Dzlib=disabled",
        "-Dzstd=disabled",
        "-Dlz4=disabled",
        "-Dnls=disabled",
        "-Dssl=none",
        "-Ddocs=disabled",
        "-Dtap_tests=disabled",
        "-Dplperl=disabled",
        "-Dplpython=disabled",
        "-Dpltcl=disabled"
    )
    if (-not (Test-Path $RuntimeBuildDir)) {
        Invoke-Logged "meson-runtime-setup.log" { meson setup $RuntimeBuildDir $BuildDir @options }
    }
    Invoke-Logged "meson-runtime-compile.log" { meson compile -C $RuntimeBuildDir }
    Invoke-Logged "meson-runtime-install.log" { meson install -C $RuntimeBuildDir }
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    Install-WindowsPgtapExtension
    Prune-BaseRuntimeOptionalExtensions
    Set-Content -Path (Join-Path $InstallDir ".oliphaunt-postgres-runtime.sha256") -Value $DesiredHash -NoNewline
    if (-not (Runtime-Installed $DesiredHash)) {
        Fail "PostgreSQL Windows runtime install is incomplete"
    }
}

function Prune-BaseRuntimeOptionalExtensions {
    if ($BuildExtensions -ne "0") {
        return
    }

    $extensionDir = Join-Path $InstallDir "share/postgresql/extension"
    $moduleDir = Join-Path $InstallDir "lib/postgresql"
    $shareDir = Join-Path $InstallDir "share/postgresql"
    foreach ($row in (Get-ExactExtensionCatalogRows "base Windows runtime pruning")) {
        if (-not $row) {
            continue
        }
        $columns = $row -split "`t", 12
        if ($columns.Count -lt 12) {
            Fail "malformed extension catalog row while pruning Windows base runtime: $row"
        }

        $sqlName = $columns[0]
        $stem = $columns[3]
        $dataFiles = $columns[10]
        if (Test-Path $extensionDir) {
            Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $extensionDir "$sqlName.control")
            Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $extensionDir "$sqlName--*.sql")
        }
        if ((Test-Path $moduleDir) -and $stem -and $stem -ne "-") {
            foreach ($suffix in @("dll", "so", "dylib")) {
                Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $moduleDir "$stem.$suffix")
            }
        }
        if ($dataFiles -and $dataFiles -ne "-") {
            foreach ($dataFile in $dataFiles.Split(",")) {
                if ($dataFile) {
                    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $shareDir $dataFile)
                }
            }
        }
    }

    if (Test-Path $extensionDir) {
        Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $extensionDir "postgis*.sql")
        Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $extensionDir "rtpostgis*.sql")
        Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $extensionDir "uninstall_postgis.sql")
        Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $extensionDir "uninstall_legacy.sql")
        Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $extensionDir "pgtap-*.sql")
        Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $extensionDir "uninstall_pgtap.sql")
    }
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $shareDir "contrib")
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $shareDir "proj")
}

function BaseRuntimeOptionalExtensionsAbsent {
    if (-not (Test-Path $InstallDir)) {
        return $false
    }

    $extensionDir = Join-Path $InstallDir "share/postgresql/extension"
    $moduleDir = Join-Path $InstallDir "lib/postgresql"
    $shareDir = Join-Path $InstallDir "share/postgresql"
    foreach ($row in (Get-ExactExtensionCatalogRows "base Windows runtime validation")) {
        if (-not $row) {
            continue
        }
        $columns = $row -split "`t", 12
        if ($columns.Count -lt 12) {
            Fail "malformed extension catalog row while validating Windows base runtime: $row"
        }

        $sqlName = $columns[0]
        $stem = $columns[3]
        $dataFiles = $columns[10]
        if ((Test-Path $extensionDir) -and (Test-Path (Join-Path $extensionDir "$sqlName.control"))) {
            return $false
        }
        if ((Test-Path $extensionDir) -and (Get-ChildItem -Path $extensionDir -Filter "$sqlName--*.sql" -File -ErrorAction SilentlyContinue | Select-Object -First 1)) {
            return $false
        }
        if ((Test-Path $moduleDir) -and $stem -and $stem -ne "-") {
            foreach ($suffix in @("dll", "so", "dylib")) {
                if (Test-Path (Join-Path $moduleDir "$stem.$suffix")) {
                    return $false
                }
            }
        }
        if ($dataFiles -and $dataFiles -ne "-") {
            foreach ($dataFile in $dataFiles.Split(",")) {
                if ($dataFile -and (Test-Path (Join-Path $shareDir $dataFile))) {
                    return $false
                }
            }
        }
    }

    if ((Test-Path (Join-Path $shareDir "contrib")) -or (Test-Path (Join-Path $shareDir "proj"))) {
        return $false
    }

    return $true
}

function Write-MesonNativeFile([string]$Path, [bool]$UseCrtSecureNoWarnings) {
    $content = @(
        "[binaries]",
        "c = 'cl.exe'",
        "cpp = 'cl.exe'",
        "ar = 'lib.exe'"
    )
    if ($UseCrtSecureNoWarnings) {
        $content += @(
            "",
            "[built-in options]",
            "c_args = ['/D_CRT_SECURE_NO_WARNINGS']"
        )
    }
    Set-Content -Path $Path -Value ($content -join "`n") -Encoding UTF8
}

function Build-EmbeddedBackend {
    Write-MesonNativeFile $EmbeddedNativeFile $true
    $options = @(
        "--native-file", $EmbeddedNativeFile,
        "--prefix", $InstallDir,
        "--buildtype=release",
        "-Doliphaunt_embedded=true",
        "-Doliphaunt_embedded_module_provider=",
        "-Db_pch=false",
        "-Dreadline=disabled",
        "-Dicu=disabled",
        "-Dldap=disabled",
        "-Dllvm=disabled",
        "-Dzlib=disabled",
        "-Dzstd=disabled",
        "-Dlz4=disabled",
        "-Dnls=disabled",
        "-Dssl=none",
        "-Ddocs=disabled",
        "-Dtap_tests=disabled",
        "-Dplperl=disabled",
        "-Dplpython=disabled",
        "-Dpltcl=disabled"
    )
    $previousCflags = $env:CFLAGS
    $env:CFLAGS = ""
    try {
        if (-not (Test-Path $EmbeddedBuildDir)) {
            Invoke-Logged "meson-embedded-setup.log" { meson setup $EmbeddedBuildDir $BuildDir @options }
        }
        Invoke-Logged "meson-embedded-bootstrap-provider.log" {
            meson configure $EmbeddedBuildDir "-Doliphaunt_embedded_module_provider="
        }
        Invoke-Logged "meson-embedded-postgres-lib.log" { meson compile -C $EmbeddedBuildDir postgres_lib }
        Invoke-Logged "meson-embedded-postgres-def.log" { meson compile -C $EmbeddedBuildDir postgres.def }
        Invoke-Logged "meson-embedded-plpgsql.log" { meson compile -C $EmbeddedBuildDir plpgsql }
    } finally {
        $env:CFLAGS = $previousCflags
    }
}

function Assert-SymbolPresent([string]$Binary, [string]$Symbol) {
    $stem = [System.IO.Path]::GetFileNameWithoutExtension($Binary)
    $log = Join-Path $WorkRoot "dumpbin-symbols-$stem.log"
    dumpbin.exe /symbols $Binary *> $log
    if ($LASTEXITCODE -ne 0) {
        Get-Content $log -Tail 160 | Write-Error
        Fail "dumpbin failed while inspecting $Binary"
    }
    $symbols = Get-Content $log -Raw
    if ($symbols -notmatch "(^|[^A-Za-z0-9_])_?$([regex]::Escape($Symbol))([^A-Za-z0-9_]|$)") {
        Get-Content $log -Tail 160 | Write-Error
        Fail "$Binary does not define required embedded PostgreSQL symbol $Symbol"
    }
}

function First-File([string]$Root, [string[]]$Filters) {
    foreach ($filter in $Filters) {
        $item = Get-ChildItem -Path $Root -Recurse -Filter $filter -File | Select-Object -First 1
        if ($item) {
            return $item.FullName
        }
    }
    Fail "could not find any of $($Filters -join ', ') under $Root"
}

function First-PostgresArchive([string]$Root, [string]$BaseName) {
    $file = First-File $Root @("$BaseName.lib", "$BaseName.a")
    if (-not $file) {
        Fail "could not find PostgreSQL archive $BaseName under $Root"
    }
    $file
}

function First-PlpgsqlObject([string]$Source) {
    $root = Join-Path $EmbeddedBuildDir "src/pl/plpgsql/src"
    if (-not (Test-Path $root)) {
        Fail "could not find embedded PL/pgSQL object root under $root"
    }
    $matches = New-Object System.Collections.Generic.List[string]
    foreach ($filter in @("$Source.c.obj", "meson-generated_*_$Source.c.obj", "*$Source.c.obj")) {
        Get-ChildItem -Path $root -Recurse -Filter $filter -File |
            ForEach-Object { $matches.Add($_.FullName) | Out-Null }
    }
    $unique = @($matches | Sort-Object -Unique)
    if ($unique.Count -eq 1) {
        return $unique[0]
    }
    if ($unique.Count -eq 0) {
        Fail "could not find embedded PL/pgSQL object for $Source under $root"
    }
    Fail "ambiguous embedded PL/pgSQL object for $Source under $root`: $($unique -join ', ')"
}

function Embedded-PlpgsqlObjects {
    $objects = New-Object System.Collections.Generic.List[string]
    foreach ($source in @("pl_comp", "pl_exec", "pl_funcs", "pl_gram", "pl_handler", "pl_scanner")) {
        $objects.Add((First-PlpgsqlObject $source)) | Out-Null
    }
    Assert-SymbolPresent (First-PlpgsqlObject "pl_gram") "plpgsql_yyparse"
    Assert-SymbolPresent (First-PlpgsqlObject "pl_handler") "plpgsql_call_handler"
    $objects
}

function Compile-LiboliphauntSources {
    Remove-Item -Recurse -Force $ObjDir -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $ObjDir | Out-Null
    $objects = New-Object System.Collections.Generic.List[string]
    foreach ($source in $LiboliphauntSources) {
        $object = Join-Path $ObjDir ([System.IO.Path]::GetFileNameWithoutExtension($source) + ".obj")
        $sourceName = [System.IO.Path]::GetFileNameWithoutExtension($source)
        Invoke-Logged "compile-liboliphaunt-$sourceName.log" {
            cl.exe /nologo /O2 /Zi /MD /DOLIPHAUNT_EMBEDDED /DOLIPHAUNT_BUILTIN_PLPGSQL /DOLIPHAUNT_BUILDING_DLL /D_CRT_SECURE_NO_WARNINGS `
                "/I$(Join-Path $RepoRoot "src/runtimes/liboliphaunt/native/include")" `
                "/I$(Join-Path $RepoRoot "src/runtimes/liboliphaunt/native/src")" `
                /c $source "/Fo$object"
        }
        $objects.Add($object)
    }
    $objects
}

function Link-LiboliphauntDll([System.Collections.Generic.List[string]]$Objects) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $DllOut), (Split-Path -Parent $ImportLibOut) | Out-Null
    $postgresLib = First-PostgresArchive $EmbeddedBuildDir "postgres_lib"
    $postgresDef = First-File $EmbeddedBuildDir "postgres.def"
    Assert-SymbolPresent $postgresLib "oliphaunt_embedded_main"
    $exports = @(
        "oliphaunt_init",
        "oliphaunt_init_ex",
        "oliphaunt_exec_protocol",
        "oliphaunt_exec_simple_query",
        "oliphaunt_exec_protocol_stream",
        "oliphaunt_backup",
        "oliphaunt_backup_ex",
        "oliphaunt_restore",
        "oliphaunt_cancel",
        "oliphaunt_detach",
        "oliphaunt_logical_generation",
        "oliphaunt_close_if_generation",
        "oliphaunt_close",
        "oliphaunt_register_static_extensions",
        "oliphaunt_last_error",
        "oliphaunt_version",
        "oliphaunt_capabilities",
        "oliphaunt_free_response",
        "oliphaunt_embedded_kill",
        "oliphaunt_embedded_raise"
    )
    $response = Join-Path $OutDir "link-oliphaunt.rsp"
    $lines = @(
        "/nologo",
        "/DLL",
        "/INCREMENTAL:NO",
        "/OUT:$DllOut",
        "/IMPLIB:$ImportLibOut",
        "/PDB:$(Join-Path $OutDir "bin/oliphaunt.pdb")",
        "/DEF:$postgresDef",
        "/WHOLEARCHIVE:$postgresLib"
    )
    foreach ($export in $exports) {
        $lines += "/EXPORT:$export"
    }
    foreach ($object in $Objects) {
        $lines += $object
    }
    foreach ($object in (Embedded-PlpgsqlObjects)) {
        $lines += $object
    }
    $lines += @(
        "ws2_32.lib",
        "secur32.lib",
        "advapi32.lib",
        "shell32.lib",
        "user32.lib",
        "bcrypt.lib"
    )
    Set-Content -Path $response -Value ($lines -join "`r`n")
    link.exe "@$response"
    if ($LASTEXITCODE -ne 0) {
        Fail "failed to link $DllOut"
    }
}

function Get-ModuleHostBinding([string]$Binary) {
    if (-not (Test-Path -LiteralPath $Binary -PathType Leaf)) {
        return "missing"
    }
    $dependencies = dumpbin.exe /dependents $Binary 2>$null | Out-String
    if ($LASTEXITCODE -ne 0) {
        return "invalid"
    }
    $serverBound = $dependencies -match '(?im)^\s*postgres\.exe\s*$'
    $embeddedBound = $dependencies -match '(?im)^\s*oliphaunt\.dll\s*$'
    if ($serverBound -and $embeddedBound) {
        return "crossed"
    }
    if ($serverBound) {
        return "server"
    }
    if ($embeddedBound) {
        return "embedded"
    }
    return "neutral"
}

function Test-EmbeddedModuleHostContract([string]$Binary, [bool]$RequireProvider = $false) {
    $binding = Get-ModuleHostBinding $Binary
    if ($RequireProvider) {
        return $binding -eq "embedded"
    }
    return $binding -eq "embedded" -or $binding -eq "neutral"
}

function Assert-EmbeddedModuleHostContract([string]$Binary, [bool]$RequireProvider = $false) {
    if (-not (Test-EmbeddedModuleHostContract $Binary $RequireProvider)) {
        $binding = Get-ModuleHostBinding $Binary
        $dependencies = if (Test-Path -LiteralPath $Binary -PathType Leaf) {
            (dumpbin.exe /dependents $Binary 2>$null | Out-String).Trim()
        } else {
            "<missing>"
        }
        $expectation = if ($RequireProvider) {
            "must import oliphaunt.dll and must not import postgres.exe"
        } else {
            "must not import postgres.exe and may be host-neutral or import oliphaunt.dll"
        }
        Fail "$Binary violates the embedded module host contract: $expectation; observed binding: $binding; dependencies: $dependencies"
    }
}

function Test-ServerModuleHostContract([string]$Binary) {
    $binding = Get-ModuleHostBinding $Binary
    return $binding -eq "server" -or $binding -eq "neutral"
}

function Assert-ServerModuleHostContract([string]$Binary) {
    if (-not (Test-ServerModuleHostContract $Binary)) {
        $binding = Get-ModuleHostBinding $Binary
        $dependencies = if (Test-Path -LiteralPath $Binary -PathType Leaf) {
            (dumpbin.exe /dependents $Binary 2>$null | Out-String).Trim()
        } else {
            "<missing>"
        }
        Fail "$Binary violates the server module host contract: must not import oliphaunt.dll and may be host-neutral or import postgres.exe; observed binding: $binding; dependencies: $dependencies"
    }
}

function Test-CompatibleModuleProfiles([string]$ServerBinary, [string]$EmbeddedBinary) {
    if (-not (Test-ServerModuleHostContract $ServerBinary) -or
        -not (Test-EmbeddedModuleHostContract $EmbeddedBinary)) {
        return $false
    }
    $serverSha256 = Get-FileSha256 $ServerBinary
    $embeddedSha256 = Get-FileSha256 $EmbeddedBinary
    if ($serverSha256 -ne $embeddedSha256) {
        return $true
    }
    return (Get-ModuleHostBinding $ServerBinary) -eq "neutral" -and
        (Get-ModuleHostBinding $EmbeddedBinary) -eq "neutral"
}

function Assert-CompatibleModuleProfiles([string]$ServerBinary, [string]$EmbeddedBinary) {
    Assert-ServerModuleHostContract $ServerBinary
    Assert-EmbeddedModuleHostContract $EmbeddedBinary
    $serverSha256 = Get-FileSha256 $ServerBinary
    $embeddedSha256 = Get-FileSha256 $EmbeddedBinary
    if ($serverSha256 -eq $embeddedSha256 -and
        ((Get-ModuleHostBinding $ServerBinary) -ne "neutral" -or
         (Get-ModuleHostBinding $EmbeddedBinary) -ne "neutral")) {
        Fail "Windows host-bound extension module server and embedded profiles must have distinct bytes: $ServerBinary and $EmbeddedBinary both have SHA-256 $serverSha256"
    }
}

function Find-EmbeddedModuleBinary([string]$Stem) {
    $matches = @(
        Get-ChildItem -Path $EmbeddedBuildDir -Recurse -Filter "$Stem.dll" -File |
            Sort-Object -Property FullName
    )
    if ($matches.Count -ne 1) {
        $observed = if ($matches.Count -eq 0) { "<none>" } else { ($matches.FullName -join ", ") }
        Fail "expected exactly one Meson embedded module output for $Stem.dll; observed $observed"
    }
    $matches[0].FullName
}

function Remove-EmbeddedModuleStage {
    if (-not (Test-Path -LiteralPath $EmbeddedModulesDir)) {
        return
    }
    $embeddedModulesInfo = Get-Item -LiteralPath $EmbeddedModulesDir -Force
    if (($embeddedModulesInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        Remove-Item -LiteralPath $EmbeddedModulesDir -Force
    } else {
        Remove-Item -LiteralPath $EmbeddedModulesDir -Recurse -Force
    }
}

function Build-EmbeddedModules {
    if (-not (Test-Path -LiteralPath $ImportLibOut -PathType Leaf)) {
        Fail "cannot build embedded extension modules before the host import library exists at $ImportLibOut"
    }

    $selectedModules = @(Get-SelectedEmbeddedExtensionModules)
    $targetNames = @("plpgsql") + @($selectedModules | ForEach-Object { $_.Stem })
    $targetNames = @($targetNames | Sort-Object -Unique)
    $provider = Meson-Path $ImportLibOut
    Invoke-Logged "meson-embedded-module-provider.log" {
        meson configure $EmbeddedBuildDir "-Doliphaunt_embedded_module_provider=$provider"
    }
    Invoke-Logged "meson-embedded-modules.log" {
        meson compile -C $EmbeddedBuildDir @targetNames
    }

    Remove-EmbeddedModuleStage
    New-Item -ItemType Directory -Force -Path $EmbeddedModulesDir | Out-Null
    $plpgsqlSource = Find-EmbeddedModuleBinary "plpgsql"
    Assert-EmbeddedModuleHostContract $plpgsqlSource $true
    Copy-Item -LiteralPath $plpgsqlSource -Destination $EmbeddedPlpgsqlDllOut -Force
    Assert-EmbeddedModuleHostContract $EmbeddedPlpgsqlDllOut $true

    foreach ($module in $selectedModules) {
        $source = Find-EmbeddedModuleBinary $module.Stem
        Assert-EmbeddedModuleHostContract $source
        $staged = Join-Path $EmbeddedModulesDir "$($module.Stem).dll"
        Copy-Item -LiteralPath $source -Destination $staged -Force
        Assert-EmbeddedModuleHostContract $staged
    }

    $installedModuleDir = Join-Path $InstallDir "lib/postgresql"
    foreach ($module in $selectedModules) {
        $server = Join-Path $installedModuleDir "$($module.Stem).dll"
        $embedded = Join-Path $EmbeddedModulesDir "$($module.Stem).dll"
        Assert-CompatibleModuleProfiles $server $embedded
    }
}

function Embedded-ModulesReady {
    if (-not (Test-EmbeddedModuleHostContract $EmbeddedPlpgsqlDllOut $true)) {
        return $false
    }
    foreach ($module in @(Get-SelectedEmbeddedExtensionModules)) {
        $server = Join-Path $InstallDir "lib/postgresql/$($module.Stem).dll"
        $embedded = Join-Path $EmbeddedModulesDir "$($module.Stem).dll"
        if (-not (Test-CompatibleModuleProfiles $server $embedded)) {
            return $false
        }
    }
    return $true
}

function Artifact-Ready {
    if (-not (Test-Path $DllOut) -or
        -not (Test-Path $ImportLibOut) -or
        -not (Embedded-ModulesReady)) {
        return $false
    }
    if (-not (Test-VcRuntimeClosure)) {
        return $false
    }
    $exports = dumpbin.exe /exports $DllOut 2>$null | Out-String
    foreach ($symbol in @(
        "oliphaunt_init",
        "oliphaunt_init_ex",
        "oliphaunt_exec_protocol",
        "oliphaunt_exec_protocol_stream",
        "oliphaunt_backup",
        "oliphaunt_restore",
        "oliphaunt_logical_generation",
        "oliphaunt_close_if_generation",
        "oliphaunt_close",
        "oliphaunt_version",
        "oliphaunt_capabilities",
        "oliphaunt_free_response"
    )) {
        if ($exports -notmatch "\b$symbol\b") {
            return $false
        }
    }
    $true
}

if (-not $IsWindows) {
    Fail "Windows liboliphaunt build must run on Windows"
}

Require-Command git
Require-Command curl.exe
Require-Command bun
Require-Command cargo
Import-MsvcEnvironment
Prefer-NativePerl
$env:CCACHE_DISABLE = "1"
Ensure-MesonTools
Configure-MsvcToolchainPath

$desiredHash = Get-DesiredHash
Prepare-Source $desiredHash
Prepare-WindowsExtensionInputs

if ($CheckCurrent) {
    if ((Runtime-Installed $desiredHash) -and (Artifact-Ready) -and (Test-Path $Stamp) -and ((Get-Content $Stamp -Raw).Trim() -eq $desiredHash)) {
        Write-Output "Windows $TargetId liboliphaunt DLL is current"
        exit 0
    }
    Write-Error "Windows $TargetId liboliphaunt DLL is missing or stale"
    exit 1
}

Build-Runtime $desiredHash
Build-EmbeddedBackend
$objects = Compile-LiboliphauntSources
Link-LiboliphauntDll $objects
Build-EmbeddedModules
Stage-VcRuntimeClosure
if (-not (Artifact-Ready)) {
    Fail "Windows liboliphaunt DLL did not pass export checks"
}
Set-Content -Path $Stamp -Value $desiredHash -NoNewline
Write-Output $DllOut
