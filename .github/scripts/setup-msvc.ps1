$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Fail([string] $Message) {
    throw "setup-msvc.ps1: $Message"
}

function Write-GitHubEnvironment([string] $Name, [string] $Value) {
    if (-not $env:GITHUB_ENV) {
        Fail "GITHUB_ENV is not set"
    }
    if ($Name -notmatch '^[A-Za-z_][A-Za-z0-9_()]*$') {
        Fail "refusing to export invalid environment name: $Name"
    }
    if ($Name -match '^(?:GITHUB|RUNNER|ACTIONS)_') {
        Fail "refusing to overwrite GitHub-owned environment variable: $Name"
    }

    $delimiter = "OLIPHAUNT_MSVC_$([Guid]::NewGuid().ToString('N'))"
    @(
        "$Name<<$delimiter"
        $Value
        $delimiter
    ) | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
}

function Require-MajorVersion([string] $Name, [string] $Value, [int] $ExpectedMajor) {
    if ([string]::IsNullOrWhiteSpace($Value)) {
        Fail "$Name is empty"
    }
    try {
        $version = [Version]::Parse($Value.Trim())
    }
    catch {
        Fail "$Name '$Value' is not a numeric dotted version"
    }
    if ($version.Major -ne $ExpectedMajor) {
        Fail "$Name '$Value' has major $($version.Major); expected $ExpectedMajor"
    }
    return $version
}

function Require-RunnerProvenance([string] $Name, [string] $Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) {
        Fail "hosted runner provenance $Name is empty"
    }
    if ($Value -match '[\r\n|]') {
        Fail "hosted runner provenance $Name must be a single safe summary value"
    }
    return $Value
}

function Resolve-CommandPath([string] $Name, [string] $ExpectedPath) {
    $command = Get-Command $Name -CommandType Application -ErrorAction Stop | Select-Object -First 1
    $observedPath = [IO.Path]::GetFullPath($command.Source)
    $normalizedExpectedPath = [IO.Path]::GetFullPath($ExpectedPath)
    if (-not [StringComparer]::OrdinalIgnoreCase.Equals($observedPath, $normalizedExpectedPath)) {
        Fail "$Name resolved to $observedPath; expected $normalizedExpectedPath"
    }
    return $observedPath
}

function Require-FileVersion([string] $Name, [string] $Path) {
    $versionInfo = (Get-Item -LiteralPath $Path).VersionInfo
    $version = $versionInfo.FileVersion
    if ([string]::IsNullOrWhiteSpace($version)) {
        $version = $versionInfo.ProductVersion
    }
    if ([string]::IsNullOrWhiteSpace($version) -or $version -match '[\r\n|]') {
        Fail "$Name at $Path did not expose a safe file version"
    }
    return $version.Trim()
}

$programFilesX86 = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)
$vswhere = Join-Path $programFilesX86 "Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) {
    Fail "vswhere.exe was not found at $vswhere"
}

$vswhereOutput = & $vswhere `
    -latest `
    -products '*' `
    -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
    -version '[18.0,19.0)' `
    -format json `
    -utf8
if ($LASTEXITCODE -ne 0) {
    Fail "vswhere failed with exit code $LASTEXITCODE"
}
$vswhereJson = $vswhereOutput -join [Environment]::NewLine
if ([string]::IsNullOrWhiteSpace($vswhereJson)) {
    Fail "Visual Studio 18 with the x64 C++ toolchain was not found"
}
try {
    $installations = @($vswhereJson | ConvertFrom-Json)
}
catch {
    Fail "vswhere returned invalid JSON: $($_.Exception.Message)"
}
if ($installations.Count -ne 1) {
    Fail "vswhere returned $($installations.Count) installations; expected exactly one latest Visual Studio 18 installation"
}
$installation = $installations[0]
$installPathProperty = $installation.PSObject.Properties['installationPath']
$installationVersionProperty = $installation.PSObject.Properties['installationVersion']
if ($null -eq $installPathProperty -or $null -eq $installationVersionProperty) {
    Fail "vswhere JSON omitted installationPath or installationVersion"
}
$installPath = ([string] $installPathProperty.Value).Trim()
$installationVersion = ([string] $installationVersionProperty.Value).Trim()
if (-not $installPath -or -not (Test-Path -LiteralPath $installPath -PathType Container)) {
    Fail "Visual Studio 18 installation path was not found at $installPath"
}
$null = Require-MajorVersion "installationVersion" $installationVersion 18

$devShellLauncher = Join-Path $installPath "Common7\Tools\Launch-VsDevShell.ps1"
if (-not (Test-Path -LiteralPath $devShellLauncher -PathType Leaf)) {
    Fail "Visual Studio developer shell launcher was not found at $devShellLauncher"
}

$before = @{}
Get-ChildItem Env: | ForEach-Object { $before[$_.Name] = $_.Value }

& $devShellLauncher `
    -SkipAutomaticLocation `
    -Arch x64 `
    -HostArch x64
if (-not $?) {
    Fail "Visual Studio developer shell initialization failed"
}

if (-not $env:VCToolsInstallDir) {
    Fail "VCToolsInstallDir was not set by the Visual Studio developer shell"
}
if (-not $env:VCToolsRedistDir) {
    Fail "VCToolsRedistDir was not set by the Visual Studio developer shell"
}
if (-not $env:VSCMD_VER) {
    Fail "VSCMD_VER was not set by the Visual Studio developer shell"
}
$null = Require-MajorVersion "VSCMD_VER" $env:VSCMD_VER 18
if ($env:VSCMD_ARG_HOST_ARCH -ne "x64" -or $env:VSCMD_ARG_TGT_ARCH -ne "x64") {
    Fail "developer shell architecture must be HostX64/x64; observed host '$($env:VSCMD_ARG_HOST_ARCH)' target '$($env:VSCMD_ARG_TGT_ARCH)'"
}
if (-not $env:VCToolsVersion) {
    Fail "VCToolsVersion was not set by the Visual Studio developer shell"
}
$vcToolsVersion = $env:VCToolsVersion.Trim().TrimEnd('\')
$vcToolsVersionInfo = Require-MajorVersion "VCToolsVersion" $vcToolsVersion 14
if ($vcToolsVersionInfo.Minor -lt 50 -or $vcToolsVersionInfo.Minor -ge 60) {
    Fail "VCToolsVersion '$vcToolsVersion' is not the Visual Studio 2026 VC145 toolset family"
}
if (-not $env:WindowsSDKVersion) {
    Fail "WindowsSDKVersion was not set by the Visual Studio developer shell"
}
$windowsSdkVersion = $env:WindowsSDKVersion.Trim().TrimEnd('\')
$null = Require-MajorVersion "WindowsSDKVersion" $windowsSdkVersion 10

$vcRuntimeDir = Join-Path $env:VCToolsRedistDir "x64\Microsoft.VC145.CRT"
if (-not (Test-Path -LiteralPath $vcRuntimeDir -PathType Container)) {
    Fail "the exact x64 Microsoft.VC145.CRT redistributable directory was not found at $vcRuntimeDir"
}
foreach ($runtime in @("msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll")) {
    $runtimePath = Join-Path $vcRuntimeDir $runtime
    if (-not (Test-Path -LiteralPath $runtimePath -PathType Leaf)) {
        Fail "required x64 VC redistributable was not found at $runtimePath"
    }
}

$msvcBin = Join-Path $env:VCToolsInstallDir "bin\HostX64\x64"
$requiredTools = @("cl.exe", "link.exe", "lib.exe", "dumpbin.exe")
foreach ($tool in $requiredTools) {
    $toolPath = Join-Path $msvcBin $tool
    if (-not (Test-Path -LiteralPath $toolPath -PathType Leaf)) {
        Fail "required MSVC tool was not found at $toolPath"
    }
}
$clPath = Resolve-CommandPath "cl.exe" (Join-Path $msvcBin "cl.exe")
$linkPath = Resolve-CommandPath "link.exe" (Join-Path $msvcBin "link.exe")
$clVersion = Require-FileVersion "cl.exe" $clPath
$linkVersion = Require-FileVersion "link.exe" $linkPath
$imageOS = Require-RunnerProvenance "ImageOS" $env:ImageOS
$imageVersion = Require-RunnerProvenance "ImageVersion" $env:ImageVersion

$changed = 0
Get-ChildItem Env: | Sort-Object Name | ForEach-Object {
    $name = $_.Name
    $value = $_.Value
    $previous = $before[$name]
    if ($previous -ne $value -and $name -notmatch '^(?:GITHUB|RUNNER|ACTIONS)_') {
        Write-GitHubEnvironment $name $value
        $changed += 1
    }
}
if ($changed -eq 0) {
    Fail "Visual Studio developer shell did not change any environment variables"
}

$linker = $linkPath
Write-GitHubEnvironment "CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER" $linker
Write-Host "Configured Visual Studio at $installPath (installationVersion=$installationVersion, VSCMD_VER=$($env:VSCMD_VER))"
Write-Host "Configured MSVC tools at $msvcBin"
Write-Host "Configured x64 VC redistributables at $vcRuntimeDir"
Write-Host "Configured Rust MSVC linker at $linker"
Write-Host "Windows toolchain: VCToolsVersion=$vcToolsVersion WindowsSDKVersion=$windowsSdkVersion"
Write-Host "Windows tools: cl=$clPath fileVersion=$clVersion; link=$linkPath fileVersion=$linkVersion"
Write-Host "Windows runner image: ImageOS=$imageOS ImageVersion=$imageVersion"

if ($env:GITHUB_STEP_SUMMARY) {
    @(
        "### Windows toolchain"
        ""
        "| Property | Observed value |"
        "| --- | --- |"
        "| ImageOS | ``$imageOS`` |"
        "| ImageVersion | ``$imageVersion`` |"
        "| Visual Studio installationVersion | ``$installationVersion`` |"
        "| VSCMD_VER | ``$($env:VSCMD_VER)`` |"
        "| VCToolsVersion | ``$vcToolsVersion`` |"
        "| WindowsSDKVersion | ``$windowsSdkVersion`` |"
        "| cl.exe | ``$clPath`` (``$clVersion``) |"
        "| link.exe | ``$linkPath`` (``$linkVersion``) |"
    ) | Out-File -FilePath $env:GITHUB_STEP_SUMMARY -Append -Encoding utf8
}
