[CmdletBinding()]
param(
    [switch]$SelfTest,
    [switch]$JsonContractSelfTest,
    [string]$RepositoryRoot,
    [string]$OutputRoot,
    [string]$BunPath,
    [string]$BunEnvelope,
    [string]$DenoEnvelope,
    [string]$NpmEnvelope,
    [string]$NodeEnvelope,
    [string]$PnpmEnvelope,
    [string]$CandidateSha,
    [string]$Target,
    [string]$ChildManifest
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Tool = "run-windows-standard-user-exact-candidate.ps1"
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$LauncherStartedAtUtc = [DateTime]::UtcNow
# Microsoft.PowerShell.LocalAccounts New-LocalUser field limits.
$LocalUserNameMaxLength = 20
$LocalUserDescriptionMaxLength = 48
$LocalUserPasswordMaxLength = 127
$ChildCaptureTailCharacters = 16384
$ChildDiagnosticTailCharacters = 4096
$ChildCaptureDrainMilliseconds = 5000
$ConservativeWindowsPathBudget = 260
$ParentEnvironmentCanaryName = "OLIPHAUNT_STANDARD_USER_SECRET_CANARY"
$RepositoryConsumerRelativePath = "tools/release/js-exact-candidate-consumer.mjs"
$RepositoryConsumerControlReadRelativePaths = @(
    $RepositoryConsumerRelativePath,
    "tools/release/artifact_target_matrix.mjs",
    "tools/release/ios-carrier-manifest.mjs",
    "tools/release/extension-registry-packages.mjs",
    "tools/release/release-artifact-targets.mjs",
    "tools/release/native-extension-asset-index-contract.mjs",
    "tools/release/tar-command.mjs",
    "tools/release/extension-artifact-inventory.mjs",
    "tools/release/fixtures/js-exact-candidate-runtime.mjs",
    "tools/release/fixtures/js-exact-candidate-procsignal.mjs",
    "tools/release/fixtures/js-exact-candidate-prepare-deno-runtime.mjs",
    "tools/release/fixtures/js-exact-candidate-jsr.mjs",
    "tools/release/build-extension-ci-artifacts.mjs",
    "tools/release/exact-candidate-command-watchdog.mjs",
    "tools/release/local-registry-publish.mjs"
)
$RepositoryConsumerModuleLoadArgument = "--windows-standard-user-module-load-proof"
$RepositoryConsumerModuleLoadProof = "OLIPHAUNT_WINDOWS_STANDARD_USER_CONSUMER_MODULE_OK"
$GitHubFileCommandEnvironmentNames = @(
    "GITHUB_ENV",
    "GITHUB_OUTPUT",
    "GITHUB_PATH",
    "GITHUB_STEP_SUMMARY",
    "GITHUB_STATE"
)
$SandboxDirectoryNames = @(
    "home",
    "tmp",
    "runner-temp",
    "npm-cache",
    "pnpm-store",
    "bun-cache",
    "deno-cache",
    "appdata",
    "local-appdata"
)

function Fail([string]$Message) {
    throw "$($Tool): $($Message)"
}

function Write-JsonFile([string]$PathValue, [object]$Value) {
    $parent = Split-Path -Parent $PathValue
    if ($parent) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    [System.IO.File]::WriteAllText(
        $PathValue,
        (($Value | ConvertTo-Json -Depth 12) + [Environment]::NewLine),
        $Utf8NoBom
    )
}

function Read-JsonFilePreservingExactStringProperty(
    [string]$PathValue,
    [string]$PropertyName,
    [string]$Label
) {
    $jsonText = [System.IO.File]::ReadAllText($PathValue, [System.Text.Encoding]::UTF8)
    $document = $null
    try {
        $document = [System.Text.Json.JsonDocument]::Parse($jsonText)
    } catch {
        Fail "$Label is not valid JSON"
    }
    $exactValue = $null
    try {
        if ($document.RootElement.ValueKind -ne [System.Text.Json.JsonValueKind]::Object) {
            Fail "$Label must be a JSON object"
        }
        $matches = [System.Collections.Generic.List[System.Text.Json.JsonProperty]]::new()
        foreach ($property in $document.RootElement.EnumerateObject()) {
            if (
                [string]::Equals(
                    $property.Name,
                    $PropertyName,
                    [System.StringComparison]::OrdinalIgnoreCase
                )
            ) {
                $matches.Add($property)
            }
        }
        if (
            $matches.Count -ne 1 -or
            $matches[0].Name -cne $PropertyName -or
            $matches[0].Value.ValueKind -ne [System.Text.Json.JsonValueKind]::String
        ) {
            Fail "$Label must contain exactly one string $PropertyName property"
        }
        $exactValue = $matches[0].Value.GetString()
        if ($null -eq $exactValue) {
            Fail "$Label $PropertyName property must not be null"
        }
    } finally {
        $document.Dispose()
    }

    # PowerShell 7.5 converts ISO-looking JSON strings to DateTime by default.
    # Restore this contract field from System.Text.Json so its exact lexical value
    # remains stable across every supported PowerShell 7 release.
    try {
        $value = $jsonText | ConvertFrom-Json
    } catch {
        Fail "$Label is not valid JSON"
    }
    $value.$PropertyName = $exactValue
    return $value
}

function Invoke-JsonContractSelfTest {
    $root = Join-Path `
        ([System.IO.Path]::GetTempPath()) `
        ("oliphaunt-windows-json-contract-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    try {
        $deadline = [DateTime]::UtcNow.AddMinutes(2).ToString(
            "O",
            [System.Globalization.CultureInfo]::InvariantCulture
        )
        $manifestPath = Join-Path $root "manifest.json"
        $proofPath = Join-Path $root "proof.json"
        Write-JsonFile $manifestPath ([ordered]@{
            schema = "oliphaunt-windows-standard-user-launch-v1"
            deadlineUtc = $deadline
            operation = "self-test"
            protectedWritableInputs = @()
        })
        $manifest = Read-JsonFilePreservingExactStringProperty `
            $manifestPath `
            "deadlineUtc" `
            "self-test manifest"
        if ($manifest.deadlineUtc -isnot [string] -or $manifest.deadlineUtc -cne $deadline) {
            Fail "manifest JSON reader did not preserve the exact deadline string"
        }
        $parsedDeadline = [DateTimeOffset]::ParseExact(
            $manifest.deadlineUtc,
            "O",
            [System.Globalization.CultureInfo]::InvariantCulture,
            [System.Globalization.DateTimeStyles]::RoundtripKind
        )
        if ($parsedDeadline.Offset -ne [TimeSpan]::Zero) {
            Fail "manifest JSON reader did not preserve a UTC deadline"
        }
        $manifestProtectedInputs = @($manifest.protectedWritableInputs)
        if (
            $manifest.protectedWritableInputs -isnot [System.Array] -or
            $manifestProtectedInputs.Count -ne 0
        ) {
            Fail "manifest JSON reader did not preserve an exact empty protected-input array"
        }

        $protectedRepository = Join-Path $root "protected-repository"
        $protectedRuntime = Join-Path $protectedRepository "tools/release/verdaccio-runtime"
        New-Item -ItemType Directory -Force -Path $protectedRuntime | Out-Null
        foreach ($name in @("package.json", "pnpm-lock.yaml")) {
            [System.IO.File]::WriteAllText(
                (Join-Path $protectedRuntime $name),
                "fixture",
                $Utf8NoBom
            )
        }
        $selfTestProtectedInputs = [System.Collections.Generic.List[string]]::new()
        Add-ExpectedProtectedWritableInputs `
            $selfTestProtectedInputs `
            $protectedRepository `
            "self-test"
        if ($selfTestProtectedInputs.Count -ne 0) {
            Fail "self-test operation unexpectedly selected protected writable inputs"
        }
        $consumerProtectedInputs = [System.Collections.Generic.List[string]]::new()
        Add-ExpectedProtectedWritableInputs `
            $consumerProtectedInputs `
            $protectedRepository `
            "consumer"
        if (
            $consumerProtectedInputs.Count -ne 2 -or
            $consumerProtectedInputs[0] -cne
                [System.IO.Path]::GetFullPath((Join-Path $protectedRuntime "package.json")) -or
            $consumerProtectedInputs[1] -cne
                [System.IO.Path]::GetFullPath((Join-Path $protectedRuntime "pnpm-lock.yaml"))
        ) {
            Fail "consumer operation did not select the exact protected writable inputs"
        }

        Write-JsonFile $proofPath ([ordered]@{
            schema = "oliphaunt-windows-standard-user-proof-v1"
            deadlineUtc = $manifest.deadlineUtc
        })
        $proof = Read-JsonFilePreservingExactStringProperty `
            $proofPath `
            "deadlineUtc" `
            "self-test proof"
        if ($proof.deadlineUtc -isnot [string] -or $proof.deadlineUtc -cne $deadline) {
            Fail "proof JSON reader did not preserve the exact deadline string"
        }

        $sandbox = Join-Path $root "sandbox"
        $systemRoot = Join-Path $root "system-root"
        $system32 = Join-Path $systemRoot "System32"
        New-Item -ItemType Directory -Force -Path $sandbox, $system32 | Out-Null
        [System.IO.File]::WriteAllText(
            (Join-Path $system32 "cmd.exe"),
            "fixture",
            $Utf8NoBom
        )
        $childEnvironment = New-ExplicitChildEnvironment `
            ([ordered]@{
                sandboxRoot = $sandbox
                toolPathDirectories = @($system32)
                userName = "oliphaunt-selftest"
            }) `
            $systemRoot `
            $system32
        $expectedHome = Join-Path $sandbox "home"
        if (
            $childEnvironment.HOME -cne $expectedHome -or
            $childEnvironment.USERPROFILE -cne $expectedHome -or
            $childEnvironment.PATH -cne $system32 -or
            $childEnvironment.Contains("PGPASSWORD") -or
            @(
                $childEnvironment.Keys |
                    Where-Object {
                        $_ -match "(?i)(TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)" -or
                        $GitHubFileCommandEnvironmentNames -contains $_
                    }
            ).Count -ne 0
        ) {
            Fail "explicit child environment self-test violated the allowlist"
        }
        $wrappedAccessDenied = [System.Management.Automation.MethodInvocationException]::new(
            "wrapped access denial",
            [System.UnauthorizedAccessException]::new("denied")
        )
        if (
            -not (Test-IsAccessDeniedException $wrappedAccessDenied) -or
            (Test-IsAccessDeniedException ([System.IO.IOException]::new("unrelated")))
        ) {
            Fail "access-denied exception-chain classifier self-test failed"
        }
        Write-Output "OLIPHAUNT_WINDOWS_JSON_CONTRACT_SELF_TEST_OK"
    } finally {
        Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Resolve-Directory([string]$PathValue, [string]$Label) {
    if (-not $PathValue) {
        Fail "$Label is required"
    }
    $resolved = Resolve-Path -LiteralPath $PathValue -ErrorAction Stop
    if (-not (Test-Path -LiteralPath $resolved.Path -PathType Container)) {
        Fail "$Label is not a directory: $PathValue"
    }
    return [System.IO.Path]::GetFullPath($resolved.Path)
}

function Resolve-File([string]$PathValue, [string]$Label) {
    if (-not $PathValue) {
        Fail "$Label is required"
    }
    $resolved = Resolve-Path -LiteralPath $PathValue -ErrorAction Stop
    if (-not (Test-Path -LiteralPath $resolved.Path -PathType Leaf)) {
        Fail "$Label is not a file: $PathValue"
    }
    return [System.IO.Path]::GetFullPath($resolved.Path)
}

function Add-ExpectedProtectedWritableInputs(
    [System.Collections.Generic.List[string]]$Destination,
    [string]$Repository,
    [string]$Operation
) {
    if ($Operation -ceq "self-test") {
        return
    }
    if ($Operation -cne "consumer") {
        Fail "cannot derive protected writable inputs for an unsupported operation"
    }
    $Destination.Add(
        (Resolve-File `
            (Join-Path $Repository "tools/release/verdaccio-runtime/package.json") `
            "expected protected Verdaccio manifest")
    ) | Out-Null
    $Destination.Add(
        (Resolve-File `
            (Join-Path $Repository "tools/release/verdaccio-runtime/pnpm-lock.yaml") `
            "expected protected Verdaccio lockfile")
    ) | Out-Null
}

function Get-FileSha256([string]$PathValue, [string]$Label) {
    $file = Resolve-File $PathValue $Label
    return (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-RepositoryControlReadSetSha256([string]$Repository) {
    $serialized = [System.Text.StringBuilder]::new()
    foreach ($relative in $RepositoryConsumerControlReadRelativePaths) {
        if (
            $relative -isnot [string] -or
            [System.IO.Path]::IsPathFullyQualified($relative) -or
            $relative.Contains([System.IO.Path]::DirectorySeparatorChar) -or
            $relative -match '(^|/)\.\.(/|$)'
        ) {
            Fail "repository consumer control read set contains an invalid relative path"
        }
        $file = Resolve-File `
            (Join-Path $Repository ($relative.Replace(
                [char]"/",
                [System.IO.Path]::DirectorySeparatorChar
            ))) `
            "repository consumer control file"
        if (-not (Test-PathInside $Repository $file)) {
            Fail "repository consumer control file escaped the checkout"
        }
        $digest = Get-FileSha256 $file "repository consumer control file"
        $serialized.Append($relative).Append([char]0).Append($digest).Append("`n") | Out-Null
    }
    $bytes = $Utf8NoBom.GetBytes($serialized.ToString())
    try {
        return [Convert]::ToHexString(
            [System.Security.Cryptography.SHA256]::HashData($bytes)
        ).ToLowerInvariant()
    } finally {
        [Array]::Clear($bytes, 0, $bytes.Length)
    }
}

function Assert-CleanTrackedCandidateTree([string]$Repository, [string]$Label) {
    & git -C $Repository diff --quiet --no-ext-diff HEAD --
    $worktreeStatus = $LASTEXITCODE
    if ($worktreeStatus -ne 0) {
        Fail "$Label found tracked worktree changes or could not inspect them (status $worktreeStatus)"
    }
    & git -C $Repository diff --cached --quiet --no-ext-diff HEAD --
    $indexStatus = $LASTEXITCODE
    if ($indexStatus -ne 0) {
        Fail "$Label found staged tracked changes or could not inspect them (status $indexStatus)"
    }
}

function Test-PathInside([string]$Parent, [string]$Child) {
    $prefix = $Parent.TrimEnd([System.IO.Path]::DirectorySeparatorChar) +
        [System.IO.Path]::DirectorySeparatorChar
    return $Child.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-CurrentIdentityContract() {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
    return [pscustomobject]@{
        Name = $identity.Name
        Sid = $identity.User.Value
        Administrator = $principal.IsInRole(
            [System.Security.Principal.WindowsBuiltInRole]::Administrator
        )
    }
}

function Get-ExplicitAclState([string]$PathValue, [string]$Sid) {
    $identity = [System.Security.Principal.SecurityIdentifier]::new($Sid)
    $acl = Get-Acl -LiteralPath $PathValue -ErrorAction Stop
    $rules = @(
        $acl.GetAccessRules(
            $true,
            $false,
            [System.Security.Principal.SecurityIdentifier]
        ) |
            Where-Object { $_.IdentityReference.Value -ceq $Sid }
    )
    return [pscustomobject]@{
        Acl = $acl
        Identity = $identity
        Rules = $rules
    }
}

function Assert-NoAclRulesForSid([string]$PathValue, [string]$Sid, [string]$Label) {
    $identity = [System.Security.Principal.SecurityIdentifier]::new($Sid)
    $acl = Get-Acl -LiteralPath $PathValue -ErrorAction Stop
    $rules = @(
        $acl.GetAccessRules(
            $true,
            $true,
            [System.Security.Principal.SecurityIdentifier]
        ) |
            Where-Object { $_.IdentityReference.Value -ceq $identity.Value }
    )
    if ($rules.Count -ne 0) {
        Fail "$Label retains explicit or inherited standard-user ACL rules"
    }
}

function Add-EphemeralAclGrant(
    [string]$PathValue,
    [string]$Sid,
    [System.Security.AccessControl.FileSystemRights]$Rights,
    [System.Collections.Generic.List[string]]$GrantedPaths
) {
    if (-not (Test-Path -LiteralPath $PathValue -PathType Container)) {
        Fail "cannot grant standard-user access to a missing directory: $PathValue"
    }
    $state = Get-ExplicitAclState $PathValue $Sid
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
        [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $state.Identity,
        $Rights,
        $inheritance,
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Allow
    )
    $state.Acl.AddAccessRule($rule) | Out-Null
    # Track before the mutation: Windows can apply a DACL change and still surface
    # a later Set-Acl error, and cleanup must cover that partially failed state.
    if (-not $GrantedPaths.Contains($PathValue)) {
        $GrantedPaths.Add($PathValue) | Out-Null
    }
    Set-Acl -LiteralPath $PathValue -AclObject $state.Acl -ErrorAction Stop

    $verification = Get-ExplicitAclState $PathValue $Sid
    $grantedRights = [System.Security.AccessControl.FileSystemRights]0
    foreach ($observedRule in $verification.Rules) {
        if ($observedRule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow) {
            $grantedRights = $grantedRights -bor $observedRule.FileSystemRights
        }
    }
    if (($grantedRights -band $Rights) -ne $Rights) {
        Fail "could not prove the explicit $Rights standard-user ACL grant on $PathValue"
    }
}

function Add-EphemeralAclDeny(
    [string]$PathValue,
    [string]$Sid,
    [System.Security.AccessControl.FileSystemRights]$Rights,
    [bool]$InheritToChildren,
    [System.Collections.Generic.List[string]]$GrantedPaths
) {
    if (-not (Test-Path -LiteralPath $PathValue)) {
        Fail "cannot deny standard-user access to a missing path: $PathValue"
    }
    $state = Get-ExplicitAclState $PathValue $Sid
    $inheritance = if ($InheritToChildren) {
        [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
            [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    } else {
        [System.Security.AccessControl.InheritanceFlags]::None
    }
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $state.Identity,
        $Rights,
        $inheritance,
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Deny
    )
    $state.Acl.AddAccessRule($rule) | Out-Null
    # Track before Set-Acl for the same partially-applied mutation case as an
    # Allow rule. PurgeAccessRules removes every explicit ACE for this SID.
    if (-not $GrantedPaths.Contains($PathValue)) {
        $GrantedPaths.Add($PathValue) | Out-Null
    }
    Set-Acl -LiteralPath $PathValue -AclObject $state.Acl -ErrorAction Stop

    $verification = Get-ExplicitAclState $PathValue $Sid
    $deniedRights = [System.Security.AccessControl.FileSystemRights]0
    foreach ($observedRule in $verification.Rules) {
        if ($observedRule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Deny) {
            $deniedRights = $deniedRights -bor $observedRule.FileSystemRights
        }
    }
    if (($deniedRights -band $Rights) -ne $Rights) {
        Fail "could not prove the explicit $Rights standard-user ACL denial on $PathValue"
    }
}

function Set-RepositoryEphemeralAclContract(
    [string]$PathValue,
    [string]$Sid,
    [System.Security.AccessControl.FileSystemRights]$AllowRights,
    [System.Security.AccessControl.FileSystemRights]$DenyRights,
    [System.Collections.Generic.List[string]]$GrantedPaths
) {
    if (-not (Test-Path -LiteralPath $PathValue -PathType Container)) {
        Fail "cannot constrain standard-user repository access on a missing directory"
    }
    $state = Get-ExplicitAclState $PathValue $Sid
    if ($state.Rules.Count -ne 0) {
        Fail "ephemeral standard-user SID unexpectedly already has repository ACL rules"
    }
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
        [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    $propagation = [System.Security.AccessControl.PropagationFlags]::None
    $state.Acl.AddAccessRule(
        [System.Security.AccessControl.FileSystemAccessRule]::new(
            $state.Identity,
            $DenyRights,
            $inheritance,
            $propagation,
            [System.Security.AccessControl.AccessControlType]::Deny
        )
    ) | Out-Null
    $state.Acl.AddAccessRule(
        [System.Security.AccessControl.FileSystemAccessRule]::new(
            $state.Identity,
            $AllowRights,
            $inheritance,
            $propagation,
            [System.Security.AccessControl.AccessControlType]::Allow
        )
    ) | Out-Null
    # Persist the complete two-ACE contract once so no child ever observes a
    # repository with only half of its access boundary installed.
    if (-not $GrantedPaths.Contains($PathValue)) {
        $GrantedPaths.Add($PathValue) | Out-Null
    }
    Set-Acl -LiteralPath $PathValue -AclObject $state.Acl -ErrorAction Stop
    Assert-RepositoryAclContract $PathValue $Sid
}

function Assert-RepositoryAclContract([string]$PathValue, [string]$Sid) {
    $state = Get-ExplicitAclState $PathValue $Sid
    $allowRules = @(
        $state.Rules |
            Where-Object {
                $_.AccessControlType -eq
                    [System.Security.AccessControl.AccessControlType]::Allow
            }
    )
    $denyRules = @(
        $state.Rules |
            Where-Object {
                $_.AccessControlType -eq
                    [System.Security.AccessControl.AccessControlType]::Deny
            }
    )
    if (
        -not $state.Acl.AreAccessRulesCanonical -or
        $state.Rules.Count -ne 2 -or
        $denyRules.Count -ne 1 -or
        $allowRules.Count -ne 1 -or
        $state.Rules[0].AccessControlType -ne
            [System.Security.AccessControl.AccessControlType]::Deny -or
        $state.Rules[1].AccessControlType -ne
            [System.Security.AccessControl.AccessControlType]::Allow
    ) {
        Fail "repository must have one canonical deny and one canonical allow rule for the standard user"
    }
    $expectedAllow = [System.Security.AccessControl.FileSystemRights]::ReadAndExecute -bor
        [System.Security.AccessControl.FileSystemRights]::WriteAttributes -bor
        [System.Security.AccessControl.FileSystemRights]::Synchronize
    $expectedDeny = [System.Security.AccessControl.FileSystemRights]::WriteData -bor
        [System.Security.AccessControl.FileSystemRights]::AppendData -bor
        [System.Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
        [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [System.Security.AccessControl.FileSystemRights]::Delete -bor
        [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [System.Security.AccessControl.FileSystemRights]::TakeOwnership
    $expectedInheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
        [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    foreach ($rule in @($denyRules[0], $allowRules[0])) {
        if (
            $rule.IsInherited -or
            $rule.InheritanceFlags -ne $expectedInheritance -or
            $rule.PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None
        ) {
            Fail "repository standard-user ACL rules must be explicit and fully inheritable"
        }
    }
    if ($allowRules[0].FileSystemRights -ne $expectedAllow) {
        Fail "repository standard-user allow rule is not the exact Bun read-open contract"
    }
    if ($denyRules[0].FileSystemRights -ne $expectedDeny) {
        Fail "repository standard-user deny rule is not the exact source-mutation contract"
    }
}

function Assert-InheritedRepositoryMutationDeny(
    [string]$PathValue,
    [string]$Sid,
    [string]$Label
) {
    $acl = Get-Acl -LiteralPath $PathValue -ErrorAction Stop
    if ($acl.AreAccessRulesProtected) {
        Fail "$Label has a protected DACL that escapes the repository mutation denial"
    }
    $rules = @(
        $acl.GetAccessRules(
            $true,
            $true,
            [System.Security.Principal.SecurityIdentifier]
        ) |
            Where-Object {
                $_.IdentityReference.Value -ceq $Sid -and
                $_.IsInherited -and
                $_.AccessControlType -eq
                    [System.Security.AccessControl.AccessControlType]::Deny
            }
    )
    $expectedDeny = [System.Security.AccessControl.FileSystemRights]::WriteData -bor
        [System.Security.AccessControl.FileSystemRights]::AppendData -bor
        [System.Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
        [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [System.Security.AccessControl.FileSystemRights]::Delete -bor
        [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [System.Security.AccessControl.FileSystemRights]::TakeOwnership
    if ($rules.Count -ne 1 -or $rules[0].FileSystemRights -ne $expectedDeny) {
        Fail "$Label did not inherit the exact repository source-mutation denial"
    }
}

function Remove-EphemeralAclGrant([string]$PathValue, [string]$Sid) {
    if (-not (Test-Path -LiteralPath $PathValue)) {
        return
    }
    $state = Get-ExplicitAclState $PathValue $Sid
    if ($state.Rules.Count -eq 0) {
        return
    }
    $state.Acl.PurgeAccessRules($state.Identity)
    Set-Acl -LiteralPath $PathValue -AclObject $state.Acl -ErrorAction Stop
    $remaining = Get-ExplicitAclState $PathValue $Sid
    if ($remaining.Rules.Count -ne 0) {
        Fail "explicit standard-user ACL entries remain on $PathValue after cleanup"
    }
}

function Set-ReadOnlyToolExecutionAcl(
    [string]$PathValue,
    [string]$StandardUserSid,
    [string]$ParentSid,
    [System.Collections.Generic.List[string]]$GrantedPaths
) {
    $resolvedPath = Resolve-Directory $PathValue "tool execution root"
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
        [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    $noPropagation = [System.Security.AccessControl.PropagationFlags]::None
    $allow = [System.Security.AccessControl.AccessControlType]::Allow
    $parentIdentity = [System.Security.Principal.SecurityIdentifier]::new($ParentSid)
    $systemIdentity = [System.Security.Principal.SecurityIdentifier]::new("S-1-5-18")
    $standardIdentity = [System.Security.Principal.SecurityIdentifier]::new($StandardUserSid)
    $acl = [System.Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($parentIdentity)
    foreach ($ownerIdentity in @($parentIdentity, $systemIdentity)) {
        $acl.AddAccessRule(
            [System.Security.AccessControl.FileSystemAccessRule]::new(
                $ownerIdentity,
                [System.Security.AccessControl.FileSystemRights]::FullControl,
                $inheritance,
                $noPropagation,
                $allow
            )
        ) | Out-Null
    }
    $acl.AddAccessRule(
        [System.Security.AccessControl.FileSystemAccessRule]::new(
            $standardIdentity,
            [System.Security.AccessControl.FileSystemRights]::ReadAndExecute,
            $inheritance,
            $noPropagation,
            $allow
        )
    ) | Out-Null
    if (-not $GrantedPaths.Contains($resolvedPath)) {
        $GrantedPaths.Add($resolvedPath) | Out-Null
    }
    Set-Acl -LiteralPath $resolvedPath -AclObject $acl -ErrorAction Stop

    $observedAcl = Get-Acl -LiteralPath $resolvedPath -ErrorAction Stop
    if (-not $observedAcl.AreAccessRulesProtected) {
        Fail "tool execution root DACL is not protected from writable ancestor grants"
    }
    $standardRules = @(
        $observedAcl.GetAccessRules(
            $true,
            $false,
            [System.Security.Principal.SecurityIdentifier]
        ) |
            Where-Object { $_.IdentityReference.Value -ceq $StandardUserSid }
    )
    if ($standardRules.Count -ne 1) {
        Fail "tool execution root must have exactly one explicit standard-user ACL rule"
    }
    $standardRights = $standardRules[0].FileSystemRights
    if (
        $standardRules[0].AccessControlType -ne $allow -or
        ($standardRights -band [System.Security.AccessControl.FileSystemRights]::ReadAndExecute) -ne
            [System.Security.AccessControl.FileSystemRights]::ReadAndExecute -or
        ($standardRights -band [System.Security.AccessControl.FileSystemRights]::Write) -ne 0 -or
        ($standardRights -band [System.Security.AccessControl.FileSystemRights]::Modify) -eq
            [System.Security.AccessControl.FileSystemRights]::Modify
    ) {
        Fail "tool execution root standard-user ACL is not exact read/execute"
    }
}

function Assert-NoForbiddenString(
    [object]$Value,
    [string]$Forbidden,
    [string]$Label
) {
    if ($null -eq $Value) {
        return
    }
    if ($Value -is [string]) {
        if (
            $Value.IndexOf($Forbidden, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
        ) {
            Fail "$Label contains a forbidden private path"
        }
        return
    }
    if ($Value -is [System.Collections.IDictionary]) {
        foreach ($key in $Value.Keys) {
            Assert-NoForbiddenString $Value[$key] $Forbidden $Label
        }
        return
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        foreach ($item in $Value) {
            Assert-NoForbiddenString $item $Forbidden $Label
        }
        return
    }
    if ($Value -is [System.Management.Automation.PSCustomObject]) {
        foreach ($property in $Value.PSObject.Properties) {
            Assert-NoForbiddenString $property.Value $Forbidden $Label
        }
    }
}

function Test-IsAccessDeniedException([object]$FailureValue) {
    $current = if ($FailureValue -is [System.Management.Automation.ErrorRecord]) {
        $FailureValue.Exception
    } elseif ($FailureValue -is [System.Exception]) {
        $FailureValue
    } else {
        $null
    }
    for ($depth = 0; $null -ne $current -and $depth -lt 16; $depth += 1) {
        if (
            $current -is [System.UnauthorizedAccessException] -or
            $current -is [System.Security.SecurityException] -or
            $current.HResult -eq -2147024891
        ) {
            return $true
        }
        if ($current.InnerException -eq $current) {
            break
        }
        $current = $current.InnerException
    }
    return $false
}

function Assert-DirectoryCreateDenied([string]$Directory, [string]$Label) {
    $probePath = Join-Path $Directory (".oliphaunt-denied-" + [Guid]::NewGuid().ToString("N"))
    $failure = $null
    try {
        [System.IO.File]::WriteAllText($probePath, "must-not-write", $Utf8NoBom)
    } catch {
        $failure = $_.Exception
    }
    if (Test-Path -LiteralPath $probePath) {
        Remove-Item -LiteralPath $probePath -Force -ErrorAction SilentlyContinue
        Fail "$Label unexpectedly allowed standard-user file creation"
    }
    if (-not (Test-IsAccessDeniedException $failure)) {
        $message = if ($failure) { $failure.Message } else { "no access-denied error" }
        Fail "$Label write-denial proof was not authoritative: $message"
    }
}

function Assert-FileWriteOpenDenied([string]$PathValue, [string]$Label) {
    $stream = $null
    $failure = $null
    try {
        $stream = [System.IO.File]::Open(
            $PathValue,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::ReadWrite
        )
    } catch {
        $failure = $_.Exception
    } finally {
        if ($stream) {
            $stream.Dispose()
        }
    }
    if ($stream) {
        Fail "$Label unexpectedly allowed standard-user write access"
    }
    if (-not (Test-IsAccessDeniedException $failure)) {
        $message = if ($failure) { $failure.Message } else { "no access-denied error" }
        Fail "$Label write-denial proof was not authoritative: $message"
    }
}

function Assert-FileAppendOpenDenied([string]$PathValue, [string]$Label) {
    $stream = $null
    $failure = $null
    try {
        $stream = [System.IO.File]::Open(
            $PathValue,
            [System.IO.FileMode]::Append,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::ReadWrite
        )
    } catch {
        $failure = $_.Exception
    } finally {
        if ($stream) {
            $stream.Dispose()
        }
    }
    if ($stream) {
        Fail "$Label unexpectedly allowed standard-user append access"
    }
    if (-not (Test-IsAccessDeniedException $failure)) {
        $message = if ($failure) { $failure.Message } else { "no access-denied error" }
        Fail "$Label append-denial proof was not authoritative: $message"
    }
}

function Assert-FileAttributeWriteAllowed([string]$PathValue, [string]$Label) {
    $attributes = [System.IO.File]::GetAttributes($PathValue)
    [System.IO.File]::SetAttributes($PathValue, $attributes)
    if ([System.IO.File]::GetAttributes($PathValue) -ne $attributes) {
        Fail "$Label attribute-write compatibility probe changed attributes"
    }
}

function Assert-DirectoryWriteRoundTrip([string]$Directory, [string]$Label) {
    $probeRoot = Join-Path $Directory (".oliphaunt-writable-" + [Guid]::NewGuid().ToString("N"))
    $nested = Join-Path $probeRoot "depth-one/depth-two"
    $probePath = Join-Path $nested "write-proof.txt"
    $renamedPath = Join-Path $nested "renamed-proof.txt"
    $expected = "oliphaunt-standard-user-write-proof+append"
    try {
        [System.IO.Directory]::CreateDirectory($nested) | Out-Null
        [System.IO.File]::WriteAllText(
            $probePath,
            "oliphaunt-standard-user-write-proof",
            $Utf8NoBom
        )
        [System.IO.File]::AppendAllText($probePath, "+append", $Utf8NoBom)
        $observed = [System.IO.File]::ReadAllText($probePath, [System.Text.Encoding]::UTF8)
        if ($observed -cne $expected) {
            Fail "$Label nested write/append/read round trip changed bytes"
        }
        [System.IO.File]::Move($probePath, $renamedPath)
        [System.IO.File]::Delete($renamedPath)
        [System.IO.Directory]::Delete($nested)
        [System.IO.Directory]::Delete((Split-Path -Parent $nested))
        [System.IO.Directory]::Delete($probeRoot)
    } finally {
        Remove-Item -LiteralPath $probeRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $probeRoot) {
        Fail "$Label nested write probe could not be removed"
    }
}

function Add-CleanupFailure(
    [System.Collections.Generic.List[string]]$Errors,
    [string]$Stage,
    [object]$FailureValue
) {
    $message = if ($FailureValue -is [System.Management.Automation.ErrorRecord]) {
        $FailureValue.Exception.Message
    } elseif ($FailureValue -is [System.Exception]) {
        $FailureValue.Message
    } else {
        [string]$FailureValue
    }
    $Errors.Add("$Stage failed: $message") | Out-Null
}

function Merge-CleanupFailures(
    [object]$PrimaryFailure,
    [System.Collections.Generic.List[string]]$CleanupErrors
) {
    if ($CleanupErrors.Count -eq 0) {
        return $PrimaryFailure
    }
    $cleanupMessage = $CleanupErrors -join "; "
    if ($PrimaryFailure) {
        $primaryException = if ($PrimaryFailure -is [System.Management.Automation.ErrorRecord]) {
            $PrimaryFailure.Exception
        } elseif ($PrimaryFailure -is [System.Exception]) {
            $PrimaryFailure
        } else {
            [System.Exception]::new([string]$PrimaryFailure)
        }
        return [System.Exception]::new(
            "$($primaryException.Message); cleanup failures: $cleanupMessage",
            $primaryException
        )
    }
    return [System.Exception]::new("cleanup failures: $cleanupMessage")
}

function New-BoundedStreamCapture(
    [System.IO.StreamReader]$Reader,
    [string]$Name
) {
    $buffer = [char[]]::new(2048)
    return [pscustomobject]@{
        Name = $Name
        Reader = $Reader
        Buffer = $buffer
        Tail = [System.Text.StringBuilder]::new($ChildCaptureTailCharacters)
        ReadTask = $Reader.ReadAsync($buffer, 0, $buffer.Length)
        Truncated = $false
        Complete = $false
        Error = $null
    }
}

function Add-BoundedStreamText([object]$Capture, [string]$Text) {
    if (-not $Text) {
        return
    }
    if ($Text.Length -ge $ChildCaptureTailCharacters) {
        $Capture.Tail.Clear() | Out-Null
        $Capture.Tail.Append(
            $Text.Substring($Text.Length - $ChildCaptureTailCharacters)
        ) | Out-Null
        $Capture.Truncated = $true
        return
    }
    $Capture.Tail.Append($Text) | Out-Null
    $excess = $Capture.Tail.Length - $ChildCaptureTailCharacters
    if ($excess -gt 0) {
        $Capture.Tail.Remove(0, $excess) | Out-Null
        $Capture.Truncated = $true
    }
}

function Receive-BoundedStreamChunk([object]$Capture) {
    try {
        $count = $Capture.ReadTask.GetAwaiter().GetResult()
        if ($count -eq 0) {
            $Capture.ReadTask = $null
            $Capture.Complete = $true
            return
        }
        Add-BoundedStreamText `
            $Capture `
            ([string]::new($Capture.Buffer, 0, $count))
        [Array]::Clear($Capture.Buffer, 0, $Capture.Buffer.Length)
        $Capture.ReadTask = $Capture.Reader.ReadAsync(
            $Capture.Buffer,
            0,
            $Capture.Buffer.Length
        )
    } catch {
        $Capture.Error = $_.Exception.Message
        $Capture.ReadTask = $null
    }
}

function ConvertTo-SanitizedDiagnosticTail(
    [string]$Text,
    [string]$SensitiveValue,
    [bool]$WasTruncated
) {
    if (-not $Text) {
        return "<empty>"
    }
    $sanitized = $Text -replace '\x1B\[[0-?]*[ -/]*[@-~]', ''
    $sanitized = $sanitized -replace '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]', '?'
    if ($SensitiveValue) {
        $sanitized = $sanitized.Replace($SensitiveValue, "<redacted>")
    }
    $sanitized = $sanitized -replace '(?i)\bgh[pousr]_[A-Za-z0-9_]{8,}\b', '<redacted>'
    $sanitized = $sanitized -replace '(?i)\bBearer\s+\S+', 'Bearer <redacted>'
    $sanitized = $sanitized -replace (
        '(?im)\b(token|secret|password|credential|authorization|auth)' +
        '(\s*[:=]\s*)([^\s,;]+)'
    ), '$1$2<redacted>'
    if ($sanitized.Length -gt $ChildDiagnosticTailCharacters) {
        $sanitized = $sanitized.Substring(
            $sanitized.Length - $ChildDiagnosticTailCharacters
        )
        $WasTruncated = $true
    }
    $prefix = if ($WasTruncated) { "<earlier-output-truncated>" } else { "" }
    return $prefix + $sanitized.Trim()
}

function Format-ChildDiagnostics([object]$Result, [string]$SensitiveValue) {
    if (-not $Result) {
        return "child diagnostics unavailable"
    }
    $stdout = ConvertTo-SanitizedDiagnosticTail `
        $Result.stdoutTail `
        $SensitiveValue `
        $Result.stdoutTruncated
    $stderr = ConvertTo-SanitizedDiagnosticTail `
        $Result.stderrTail `
        $SensitiveValue `
        $Result.stderrTruncated
    $stdoutJson = ConvertTo-Json $stdout -Compress
    $stderrJson = ConvertTo-Json $stderr -Compress
    return (
        "child diagnostics: exitCode=$($Result.exitCode) " +
        "captureIncomplete=$($Result.captureIncomplete) " +
        "stdoutTail=$stdoutJson stderrTail=$stderrJson"
    )
}

function Get-BoundedTaskText([object]$Task, [int]$TimeoutMilliseconds) {
    if (-not $Task) {
        return ""
    }
    try {
        if (-not $Task.Wait($TimeoutMilliseconds)) {
            return "<output capture timed out>"
        }
        $value = [string]$Task.GetAwaiter().GetResult()
        if ($value.Length -gt 4096) {
            return $value.Substring(0, 4096) + "<truncated>"
        }
        return $value
    } catch {
        return "<output capture failed: $($_.Exception.Message)>"
    }
}

function Invoke-BoundedNativeProcess(
    [string]$Executable,
    [string[]]$Arguments,
    [int]$TimeoutMilliseconds
) {
    if ($TimeoutMilliseconds -lt 1) {
        Fail "bounded native process timeout must be positive"
    }
    $result = [ordered]@{
        started = $false
        timedOut = $false
        exitCode = $null
        stdout = ""
        stderr = ""
        error = $null
    }
    $process = [System.Diagnostics.Process]::new()
    $stdoutTask = $null
    $stderrTask = $null
    try {
        $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
        $startInfo.FileName = $Executable
        foreach ($argument in $Arguments) {
            $startInfo.ArgumentList.Add($argument)
        }
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $process.StartInfo = $startInfo
        if (-not $process.Start()) {
            $result["error"] = "process did not start"
            return [pscustomobject]$result
        }
        $result["started"] = $true
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutMilliseconds)) {
            $result["timedOut"] = $true
            try {
                if (-not $process.HasExited) {
                    $process.Kill($true)
                }
            } catch {
                $result["error"] = "timed-out process-tree termination failed: $($_.Exception.Message)"
            }
            $process.WaitForExit(5000) | Out-Null
        }
        if ($process.HasExited) {
            $result["exitCode"] = $process.ExitCode
        }
        $result["stdout"] = Get-BoundedTaskText $stdoutTask 2000
        $result["stderr"] = Get-BoundedTaskText $stderrTask 2000
    } catch {
        $result["error"] = $_.Exception.Message
    } finally {
        $process.Dispose()
    }
    return [pscustomobject]$result
}

function Invoke-BoundedToolProbe(
    [string]$Executable,
    [string[]]$Arguments,
    [int]$TimeoutMilliseconds
) {
    $extension = [System.IO.Path]::GetExtension($Executable)
    if ($extension -in @(".cmd", ".bat")) {
        if (
            $Executable.IndexOfAny(
                [char[]]@('"', '%', '!', '^', '&', '|', '<', '>', '(', ')', "`r", "`n")
            ) -ge 0 -or
            @(
                $Arguments |
                    Where-Object { $_ -notmatch '^[A-Za-z0-9._/?=-]+$' }
            ).Count -ne 0
        ) {
            Fail "batch-file tool probe contains unsupported command bytes"
        }
        # Each cmd.exe token must be a separate ArgumentList entry. Embedding a
        # quoted batch path inside one entry makes .NET apply C-runtime backslash
        # escaping, which cmd.exe does not understand. The leading call token
        # also keeps /s from treating a quoted path as the command's outer quote.
        $commandArguments = @(
            "/d",
            "/s",
            "/v:off",
            "/c",
            "call",
            $Executable
        ) + @($Arguments)
        return Invoke-BoundedNativeProcess `
            (Join-Path $env:SystemRoot "System32/cmd.exe") `
            ([string[]]$commandArguments) `
            $TimeoutMilliseconds
    }
    return Invoke-BoundedNativeProcess $Executable $Arguments $TimeoutMilliseconds
}

function Get-ProcessesForAccount([string]$CanonicalUserName) {
    return @(
        Get-Process -IncludeUserName -ErrorAction Stop |
            Where-Object {
                $_.UserName -and [string]::Equals(
                    [string]$_.UserName,
                    $CanonicalUserName,
                    [System.StringComparison]::OrdinalIgnoreCase
                )
            } |
            Sort-Object -Property Id |
            ForEach-Object {
                [ordered]@{
                    id = [int]$_.Id
                    name = [string]$_.ProcessName
                    userName = [string]$_.UserName
                }
            }
    )
}

function Stop-And-ProveNoAccountProcesses(
    [string]$CanonicalUserName,
    [string]$Sid,
    [System.Collections.IDictionary]$Proof
) {
    $Proof["attempted"] = $true
    $Proof["accountName"] = $CanonicalUserName
    $Proof["accountSid"] = $Sid
    $cleanupDeadline = [DateTime]::UtcNow.AddSeconds(60)
    $commandFailures = [System.Collections.Generic.List[string]]::new()

    $taskkillArgs = @(
        "/F",
        "/T",
        "/FI", ("USERNAME eq " + $CanonicalUserName),
        "/IM", "*"
    )
    $initialTaskkill = Invoke-BoundedNativeProcess `
        "$env:SystemRoot\System32\taskkill.exe" `
        $taskkillArgs `
        10000
    $Proof["initialTaskkillExitCode"] = $initialTaskkill.exitCode
    $Proof["initialTaskkillTimedOut"] = $initialTaskkill.timedOut
    if (-not $initialTaskkill.started -or $initialTaskkill.timedOut -or $initialTaskkill.error) {
        $commandFailures.Add(
            "initial filtered taskkill failed or timed out: $($initialTaskkill.error)"
        ) | Out-Null
    }

    $observations = [System.Collections.Generic.List[object]]::new()
    $terminatedProcessIds = [System.Collections.Generic.HashSet[int]]::new()
    $zeroProcessSamples = 0
    $lastProcesses = @()
    for ($attempt = 1; $attempt -le 12; $attempt += 1) {
        if ([DateTime]::UtcNow -ge $cleanupDeadline) {
            $commandFailures.Add("process cleanup exceeded its 60-second deadline") | Out-Null
            break
        }
        try {
            $lastProcesses = @(Get-ProcessesForAccount $CanonicalUserName)
        } catch {
            $Proof["verificationError"] = $_.Exception.Message
            $Proof["observations"] = @($observations)
            $Proof["terminatedProcessIds"] = @($terminatedProcessIds | Sort-Object)
            $Proof["commandFailures"] = @($commandFailures)
            Fail "could not enumerate process owners for the standard-user cleanup proof: $($_.Exception.Message)"
        }
        $observations.Add([ordered]@{
            attempt = $attempt
            processCount = $lastProcesses.Count
            processes = @($lastProcesses)
        }) | Out-Null

        if ($lastProcesses.Count -eq 0) {
            $zeroProcessSamples += 1
            if ($zeroProcessSamples -ge 2) {
                $Proof["verified"] = $true
                $Proof["zeroProcessSamples"] = $zeroProcessSamples
                $Proof["remainingProcesses"] = @()
                $Proof["observations"] = @($observations)
                $Proof["terminatedProcessIds"] = @($terminatedProcessIds | Sort-Object)
                $Proof["commandFailures"] = @($commandFailures)
                if ($commandFailures.Count -ne 0) {
                    Fail "bounded taskkill cleanup reported failures: $($commandFailures -join '; ')"
                }
                return
            }
        } else {
            $zeroProcessSamples = 0
            foreach ($ownedProcess in $lastProcesses) {
                if ([DateTime]::UtcNow -ge $cleanupDeadline) {
                    $commandFailures.Add("process cleanup exceeded its 60-second deadline") | Out-Null
                    break
                }
                $remainingMilliseconds = [int][Math]::Max(
                    1,
                    [Math]::Min(
                        10000,
                        ($cleanupDeadline - [DateTime]::UtcNow).TotalMilliseconds
                    )
                )
                $pidTaskkill = Invoke-BoundedNativeProcess `
                    "$env:SystemRoot\System32\taskkill.exe" `
                    @("/F", "/T", "/PID", [string]$ownedProcess.id) `
                    $remainingMilliseconds
                if ($pidTaskkill.exitCode -eq 0 -and -not $pidTaskkill.timedOut) {
                    $terminatedProcessIds.Add([int]$ownedProcess.id) | Out-Null
                }
                if (-not $pidTaskkill.started -or $pidTaskkill.timedOut -or $pidTaskkill.error) {
                    $commandFailures.Add(
                        "PID $($ownedProcess.id) taskkill failed or timed out: $($pidTaskkill.error)"
                    ) | Out-Null
                }
            }
        }
        Start-Sleep -Milliseconds 250
    }

    $Proof["zeroProcessSamples"] = $zeroProcessSamples
    $Proof["remainingProcesses"] = @($lastProcesses)
    $Proof["observations"] = @($observations)
    $Proof["terminatedProcessIds"] = @($terminatedProcessIds | Sort-Object)
    $Proof["commandFailures"] = @($commandFailures)
    Fail "standard-user process cleanup did not reach two owner-enumerated zero-process samples"
}

function Get-CommandPath([string]$Name) {
    $command = Get-Command $Name -CommandType Application -ErrorAction Stop | Select-Object -First 1
    return [System.IO.Path]::GetFullPath($command.Path)
}

function Get-PrivateToolRoot(
    [string]$Name,
    [string]$Executable,
    [string]$RunnerTemp,
    [string]$ExpectedEnvelope
) {
    $directory = Resolve-Directory (Split-Path -Parent $Executable) "private tool directory"
    if (-not $ExpectedEnvelope) {
        if ($RunnerTemp -and (Test-PathInside $RunnerTemp $directory)) {
            Fail "$Name unexpectedly resolved to an undeclared private RUNNER_TEMP tool"
        }
        # Other resolved commands are public Windows/Program Files tools. They
        # are not copied and their ACLs are never rewritten.
        return $null
    }

    # Each setup action declares its exact digest-verified execution envelope.
    # Bind the resolved command to that envelope and stage it directly, never a
    # guessed RUNNER_TEMP ancestor containing archives or installation identities.
    $envelope = Resolve-Directory $ExpectedEnvelope "$Name private tool execution envelope"
    if (-not (Test-PathInside $RunnerTemp $envelope)) {
        Fail "private tool execution envelope escaped RUNNER_TEMP"
    }
    if (-not (Test-PathInside $envelope $Executable)) {
        Fail "$Name command escaped its declared private tool execution envelope"
    }
    $expectedCommandDirectory = Resolve-Directory `
        (Join-Path $envelope "bin") `
        "$Name declared private tool bin directory"
    if (-not [string]::Equals(
        $directory,
        $expectedCommandDirectory,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        Fail "$Name command is not an immediate child of its declared bin directory"
    }
    $expectedCommandName = switch ($Name) {
        "bun" { "bun.exe" }
        "deno" { "deno.exe" }
        "node" { "node.exe" }
        "npm" { "npm.cmd" }
        "pnpm" { "pnpm.cmd" }
        default { Fail "unsupported declared private tool envelope: $Name" }
    }
    if (-not [string]::Equals(
        (Split-Path -Leaf $Executable),
        $expectedCommandName,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        Fail "$Name command filename disagrees with its declared execution envelope"
    }
    $receipt = Resolve-File (Join-Path $envelope "receipt") "$Name private tool receipt"
    if ((Get-Item -LiteralPath $receipt -Force).Attributes -band
        [System.IO.FileAttributes]::ReparsePoint
    ) {
        Fail "$Name private tool receipt must not be a reparse point"
    }
    return $envelope
}

function Get-ToolTreeFingerprint([string]$Root, [string]$Label) {
    $rootPath = Resolve-Directory $Root $Label
    if ($rootPath.Length -ge $ConservativeWindowsPathBudget) {
        Fail (
            "$Label root exceeds the conservative Windows path budget before inspection: " +
            "$($rootPath.Length) characters"
        )
    }
    $rootItem = Get-Item -LiteralPath $rootPath -Force -ErrorAction Stop
    if (
        ($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
    ) {
        Fail "$Label root must not be a reparse point: $rootPath"
    }
    foreach ($stream in @(
        Get-Item -LiteralPath $rootPath -Stream * -Force -ErrorAction Stop
    )) {
        if ($stream.Stream -cne ':$DATA') {
            Fail "$Label root contains a forbidden alternate data stream: $($stream.Stream)"
        }
    }

    $records = [System.Collections.Generic.SortedDictionary[string, object]]::new(
        [System.StringComparer]::Ordinal
    )
    $pending = [System.Collections.Generic.Stack[string]]::new()
    $pending.Push($rootPath)
    [long]$totalBytes = 0
    [int]$fileCount = 0
    [int]$directoryCount = 0
    [int]$maxRelativePathCharacters = 0

    while ($pending.Count -ne 0) {
        $directory = $pending.Pop()
        foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)) {
            if ($item.FullName.Length -ge $ConservativeWindowsPathBudget) {
                Fail (
                    "$Label entry exceeds the conservative Windows path budget before inspection: " +
                    "$($item.FullName.Length) characters: $($item.FullName)"
                )
            }
            if (
                ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
            ) {
                Fail "$Label contains a forbidden reparse point: $($item.FullName)"
            }
            foreach ($stream in @(
                Get-Item -LiteralPath $item.FullName -Stream * -Force -ErrorAction Stop
            )) {
                if ($stream.Stream -cne ':$DATA') {
                    Fail "$Label contains a forbidden alternate data stream: $($item.FullName):$($stream.Stream)"
                }
            }
            $relative = [System.IO.Path]::GetRelativePath($rootPath, $item.FullName)
            if (
                [System.IO.Path]::IsPathFullyQualified($relative) -or
                $relative -eq ".." -or
                $relative.StartsWith(
                    ".." + [System.IO.Path]::DirectorySeparatorChar,
                    [System.StringComparison]::Ordinal
                )
            ) {
                Fail "$Label inventory escaped its root: $($item.FullName)"
            }
            $normalized = $relative.Replace(
                [System.IO.Path]::DirectorySeparatorChar,
                [System.IO.Path]::AltDirectorySeparatorChar
            )
            $maxRelativePathCharacters = [Math]::Max(
                $maxRelativePathCharacters,
                $normalized.Length
            )
            if ($records.ContainsKey($normalized)) {
                Fail "$Label inventory contains a duplicate path: $normalized"
            }
            if ($item.PSIsContainer) {
                $records.Add($normalized, [ordered]@{
                    kind = "directory"
                    path = $normalized
                    attributes = [long]$item.Attributes
                })
                $directoryCount += 1
                $pending.Push($item.FullName)
            } elseif ($item.PSIsContainer -eq $false) {
                $length = [long]$item.Length
                $sha256 = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
                $records.Add($normalized, [ordered]@{
                    kind = "file"
                    path = $normalized
                    attributes = [long]$item.Attributes
                    bytes = $length
                    sha256 = $sha256
                })
                $fileCount += 1
                $totalBytes += $length
            } else {
                Fail "$Label contains an unsupported filesystem entry: $($item.FullName)"
            }
        }
    }

    $aggregate = [System.Text.StringBuilder]::new()
    $rootAttributes = ([long]$rootItem.Attributes).ToString(
        [System.Globalization.CultureInfo]::InvariantCulture
    )
    $aggregate.Append("R:").Append($rootAttributes).Append("`n") | Out-Null
    foreach ($record in $records.Values) {
        $encodedPath = [Convert]::ToBase64String($Utf8NoBom.GetBytes($record.path))
        $attributes = $record.attributes.ToString(
            [System.Globalization.CultureInfo]::InvariantCulture
        )
        if ($record.kind -ceq "directory") {
            $aggregate.Append("D:").Append($encodedPath).Append(":") |
                Out-Null
            $aggregate.Append($attributes).Append("`n") | Out-Null
        } else {
            $aggregate.Append("F:").Append($encodedPath).Append(":") |
                Out-Null
            $aggregate.Append($attributes).Append(":") | Out-Null
            $aggregate.Append(
                $record.bytes.ToString([System.Globalization.CultureInfo]::InvariantCulture)
            ).Append(":").Append($record.sha256).Append("`n") | Out-Null
        }
    }
    $aggregateBytes = $Utf8NoBom.GetBytes($aggregate.ToString())
    try {
        $treeSha256 = [Convert]::ToHexString(
            [System.Security.Cryptography.SHA256]::HashData($aggregateBytes)
        ).ToLowerInvariant()
    } finally {
        [Array]::Clear($aggregateBytes, 0, $aggregateBytes.Length)
    }
    return [pscustomobject][ordered]@{
        schema = "oliphaunt-windows-tool-tree-v1"
        sha256 = $treeSha256
        rootAttributes = [long]$rootItem.Attributes
        files = $fileCount
        directories = $directoryCount
        bytes = $totalBytes
        maxRelativePathCharacters = $maxRelativePathCharacters
    }
}

function Assert-ToolTreeFingerprintEqual(
    [object]$Expected,
    [object]$Actual,
    [string]$Label
) {
    if (
        $Expected.schema -cne "oliphaunt-windows-tool-tree-v1" -or
        $Actual.schema -cne "oliphaunt-windows-tool-tree-v1" -or
        [string]$Expected.sha256 -cne [string]$Actual.sha256 -or
        [long]$Expected.rootAttributes -ne [long]$Actual.rootAttributes -or
        [int]$Expected.files -ne [int]$Actual.files -or
        [int]$Expected.directories -ne [int]$Actual.directories -or
        [long]$Expected.bytes -ne [long]$Actual.bytes -or
        [int]$Expected.maxRelativePathCharacters -ne
            [int]$Actual.maxRelativePathCharacters
    ) {
        Fail "$Label tool-tree fingerprint mismatch"
    }
}

function Copy-PrivateToolTree(
    [string]$Source,
    [string]$Destination,
    [string]$Label
) {
    $sourcePath = Resolve-Directory $Source "$Label source"
    if (Test-Path -LiteralPath $Destination) {
        Fail "$Label destination already exists: $Destination"
    }
    $destinationPath = [System.IO.Path]::GetFullPath($Destination)
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destinationPath) |
        Out-Null

    $sourceBefore = Get-ToolTreeFingerprint $sourcePath "$Label source before copy"
    $maxDestinationPathCharacters = if ($sourceBefore.maxRelativePathCharacters -eq 0) {
        $destinationPath.Length
    } else {
        $destinationPath.Length + 1 + $sourceBefore.maxRelativePathCharacters
    }
    if ($maxDestinationPathCharacters -ge $ConservativeWindowsPathBudget) {
        Fail (
            "$Label destination exceeds the conservative Windows path budget: " +
            "$maxDestinationPathCharacters characters"
        )
    }
    $robocopy = Resolve-File (Join-Path $env:SystemRoot "System32/robocopy.exe") "robocopy"
    $copy = Invoke-BoundedNativeProcess `
        $robocopy `
        @(
            $sourcePath,
            $destinationPath,
            "/E",
            "/COPY:DAX",
            "/DCOPY:DAX",
            "/R:0",
            "/W:0",
            "/XJ",
            "/NFL",
            "/NDL",
            "/NJH",
            "/NJS",
            "/NP"
        ) `
        600000
    if (
        -not $copy.started -or
        $copy.timedOut -or
        $copy.error -or
        $null -eq $copy.exitCode -or
        $copy.exitCode -lt 0 -or
        $copy.exitCode -gt 7
    ) {
        Fail (
            "$Label data-only copy failed: exitCode=$($copy.exitCode) " +
            "timedOut=$($copy.timedOut) error=$($copy.error) stderr=$($copy.stderr)"
        )
    }
    $sourceAfter = Get-ToolTreeFingerprint $sourcePath "$Label source after copy"
    $destinationFingerprint = Get-ToolTreeFingerprint `
        $destinationPath `
        "$Label destination"
    Assert-ToolTreeFingerprintEqual `
        $sourceBefore `
        $sourceAfter `
        "$Label source stability"
    Assert-ToolTreeFingerprintEqual `
        $sourceBefore `
        $destinationFingerprint `
        "$Label source/destination"
    return $destinationFingerprint
}

function Get-ToolProbeSpecifications(
    [string]$ResolvedBun,
    [System.Collections.IDictionary]$PrivateToolEnvelopes
) {
    $specifications = [System.Collections.Generic.List[object]]::new()
    $specifications.Add([pscustomobject]@{
        name = "bun"
        path = $ResolvedBun
        arguments = @("--version")
        envelope = $PrivateToolEnvelopes["bun"]
    }) | Out-Null
    $specifications.Add([pscustomobject]@{
        name = "deno"
        path = Get-CommandPath "deno"
        arguments = @("--version")
        envelope = $PrivateToolEnvelopes["deno"]
    }) | Out-Null
    foreach ($contract in @(
        @("npm", "npm.cmd", "--version"),
        @("pnpm", "pnpm.cmd", "--version"),
        @("node", "node", "--version"),
        @("git", "git", "--version"),
        @("tar", "tar", "--version"),
        @("unzip", "unzip", "-v"),
        @("bash", "bash", "--version"),
        @("cmd", "cmd", "/d", "/c", "ver"),
        @("taskkill", "taskkill", "/?")
    )) {
        $name = $contract[0]
        $specifications.Add([pscustomobject]@{
            name = $name
            path = Get-CommandPath $contract[1]
            arguments = @($contract[2..($contract.Count - 1)])
            envelope = $PrivateToolEnvelopes[$name]
        }) | Out-Null
    }
    return @($specifications)
}

function New-RandomPassword() {
    $bytes = [byte[]]::new(30)
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    try {
        return [Convert]::ToBase64String($bytes) + "aA1!"
    } finally {
        [Array]::Clear($bytes, 0, $bytes.Length)
    }
}

function Assert-LocalStandardUser([object]$User) {
    $administratorsSid = [System.Security.Principal.SecurityIdentifier]::new(
        "S-1-5-32-544"
    )
    $administrators = Get-LocalGroup -SID $administratorsSid
    $administratorMembers = @(
        Get-LocalGroupMember -Group $administrators.Name -ErrorAction Stop |
            Where-Object { $_.SID.Value -eq $User.SID.Value }
    )
    if ($administratorMembers.Count -ne 0) {
        Fail "ephemeral proof account unexpectedly belongs to the local Administrators group"
    }

    $usersSid = [System.Security.Principal.SecurityIdentifier]::new("S-1-5-32-545")
    $users = Get-LocalGroup -SID $usersSid
    $userMembers = @(
        Get-LocalGroupMember -Group $users.Name -ErrorAction Stop |
            Where-Object { $_.SID.Value -eq $User.SID.Value }
    )
    if ($userMembers.Count -eq 0) {
        Add-LocalGroupMember -Group $users.Name -Member $User -ErrorAction Stop
    }
}

function Read-And-ValidateProof(
    [string]$ProofPath,
    [object]$Manifest,
    [object]$ChildResult,
    [string]$SensitiveValue
) {
    if (-not (Test-Path -LiteralPath $ProofPath -PathType Leaf)) {
        Fail (
            "standard-user child did not write its token proof; " +
            (Format-ChildDiagnostics $ChildResult $SensitiveValue)
        )
    }
    $proof = Read-JsonFilePreservingExactStringProperty `
        $ProofPath `
        "deadlineUtc" `
        "standard-user child token proof"
    if (
        $proof.schema -cne "oliphaunt-windows-standard-user-proof-v1" -or
        $proof.mechanism -cne "ephemeral-local-standard-user" -or
        $proof.operation -cne $Manifest.operation -or
        $proof.account.sid -cne $Manifest.userSid -or
        $proof.token.administrator -isnot [bool] -or
        $proof.token.administrator -ne $false -or
        $proof.environment.sensitiveNamesAbsent -isnot [bool] -or
        $proof.environment.sensitiveNamesAbsent -ne $true -or
        $proof.environment.githubFileCommandsAbsent -isnot [bool] -or
        $proof.environment.githubFileCommandsAbsent -ne $true -or
        $proof.repositoryAccess.entrypointSha256 -cne
            $Manifest.consumerEntrypointSha256 -or
        $proof.repositoryAccess.controlReadSetSha256 -cne
            $Manifest.consumerControlReadSetSha256 -or
        $proof.repositoryAccess.dotNetReadVerified -isnot [bool] -or
        $proof.repositoryAccess.dotNetReadVerified -ne $true -or
        $proof.repositoryAccess.bunModuleLoadVerified -isnot [bool] -or
        $proof.repositoryAccess.bunModuleLoadVerified -ne $true -or
        $proof.repositoryAccess.preflightTrackedTreeCleanVerified -isnot [bool] -or
        $proof.repositoryAccess.preflightTrackedTreeCleanVerified -ne $true -or
        $proof.repositoryAccess.entrypointDataWriteDenied -isnot [bool] -or
        $proof.repositoryAccess.entrypointDataWriteDenied -ne $true -or
        $proof.repositoryAccess.entrypointAppendDenied -isnot [bool] -or
        $proof.repositoryAccess.entrypointAppendDenied -ne $true -or
        $proof.repositoryAccess.metadataWriteVerified -isnot [bool] -or
        $proof.repositoryAccess.metadataWriteVerified -ne $true -or
        $proof.repositoryAccess.inheritedMutationDenyVerified -isnot [bool] -or
        $proof.repositoryAccess.inheritedMutationDenyVerified -ne $true -or
        $proof.repositoryAccess.controlReadSetMutationDenied -isnot [bool] -or
        $proof.repositoryAccess.controlReadSetMutationDenied -ne $true -or
        $proof.repositoryAccess.rootCreateDenied -isnot [bool] -or
        $proof.repositoryAccess.rootCreateDenied -ne $true -or
        $proof.repositoryAccess.sourceDirectoryCreateDenied -isnot [bool] -or
        $proof.repositoryAccess.sourceDirectoryCreateDenied -ne $true -or
        $proof.repositoryAccess.protectedWritableInputsWriteDenied -isnot [bool] -or
        $proof.repositoryAccess.protectedWritableInputsWriteDenied -ne $true -or
        $proof.toolAccess.stagingVerified -isnot [bool] -or
        $proof.toolAccess.stagingVerified -ne $true -or
        $proof.toolAccess.bunExecuted -isnot [bool] -or
        $proof.toolAccess.bunExecuted -ne $true -or
        $proof.toolAccess.toolRootWriteDenied -isnot [bool] -or
        $proof.toolAccess.toolRootWriteDenied -ne $true -or
        $proof.toolAccess.sandboxWriteVerified -isnot [bool] -or
        $proof.toolAccess.sandboxWriteVerified -ne $true -or
        $proof.toolAccess.writableRootsNestedRoundTripVerified -isnot [bool] -or
        $proof.toolAccess.writableRootsNestedRoundTripVerified -ne $true -or
        [int]$proof.toolAccess.stagedTreeCount -ne @($Manifest.toolStaging).Count -or
        $proof.deadlineUtc -cne $Manifest.deadlineUtc
    ) {
        Fail "standard-user child token proof is malformed or disagrees with the launch contract"
    }
    $manifestProbeNames = @(
        $Manifest.toolProbes | ForEach-Object { [string]$_.name }
    )
    $proofProbes = @($proof.toolAccess.probes)
    $proofProbeNames = @(
        $proofProbes | ForEach-Object { [string]$_.name }
    )
    if (
        $proofProbes.Count -ne $manifestProbeNames.Count -or
        [string]::Join("`n", $proofProbeNames) -cne
            [string]::Join("`n", $manifestProbeNames) -or
        @(
            $proofProbes |
                Where-Object {
                    $_.staged -isnot [bool] -or
                    $_.exitCode -ne 0 -or
                    $_.outputSha256 -notmatch '^[0-9a-f]{64}$'
                }
        ).Count -ne 0 -or
        @(
            $proofProbes |
                Where-Object { $_.name -ceq "bun" -and $_.staged -eq $true }
        ).Count -ne 1
    ) {
        Fail "standard-user child tool-access proof is malformed"
    }
    if ($Manifest.operation -eq "consumer") {
        if (
            $proof.candidate.sha -cne $Manifest.candidateSha -or
            $proof.candidate.tree -notmatch "^[0-9a-f]{40}$" -or
            $proof.target -cne $Manifest.target
        ) {
            Fail "standard-user child token proof is not bound to the exact candidate"
        }
    } elseif ($null -ne $proof.candidate -or $null -ne $proof.target) {
        Fail "standard-user self-test proof contains consumer-only identity"
    }
    return $proof
}

function New-ExplicitChildEnvironment(
    [object]$Manifest,
    [string]$WindowsRoot,
    [string]$System32
) {
    $sandbox = [System.IO.Path]::GetFullPath($Manifest.sandboxRoot)
    $sandboxHome = Join-Path $sandbox "home"
    $homeDrive = [System.IO.Path]::GetPathRoot($sandboxHome).TrimEnd("\")
    if (-not $homeDrive) {
        Fail "could not derive the child sandbox drive"
    }
    $windowsDrive = [System.IO.Path]::GetPathRoot($WindowsRoot).TrimEnd("\")
    if (-not $windowsDrive) {
        Fail "could not derive the Windows system drive"
    }
    $computerName = [Environment]::MachineName
    if (-not $computerName) {
        Fail "could not resolve the child computer name"
    }
    $toolPathDirectories = @($Manifest.toolPathDirectories)
    if ($toolPathDirectories.Count -eq 0) {
        Fail "cannot construct the child environment without an allowlisted tool PATH"
    }

    return [ordered]@{
        "APPDATA" = Join-Path $sandbox "appdata"
        "BUN_INSTALL_CACHE_DIR" = Join-Path $sandbox "bun-cache"
        "COMPUTERNAME" = $computerName
        "ComSpec" = Resolve-File (Join-Path $System32 "cmd.exe") "child ComSpec"
        "DENO_DIR" = Join-Path $sandbox "deno-cache"
        "HOME" = $sandboxHome
        "HOMEDRIVE" = $homeDrive
        "HOMEPATH" = $sandboxHome.Substring($homeDrive.Length)
        "LOCALAPPDATA" = Join-Path $sandbox "local-appdata"
        "NPM_CONFIG_CACHE" = Join-Path $sandbox "npm-cache"
        "NUMBER_OF_PROCESSORS" = [Environment]::ProcessorCount.ToString(
            [System.Globalization.CultureInfo]::InvariantCulture
        )
        "OS" = "Windows_NT"
        "PATH" = $toolPathDirectories -join [System.IO.Path]::PathSeparator
        "PATHEXT" = ".COM;.EXE;.BAT;.CMD"
        "PROCESSOR_ARCHITECTURE" = "AMD64"
        "RUNNER_TEMP" = Join-Path $sandbox "runner-temp"
        "SystemDrive" = $windowsDrive
        "SystemRoot" = $WindowsRoot
        "TEMP" = Join-Path $sandbox "tmp"
        "TMP" = Join-Path $sandbox "tmp"
        "USERDOMAIN" = $computerName
        "USERNAME" = $Manifest.userName
        "USERPROFILE" = $sandboxHome
        "windir" = $WindowsRoot
    }
}

function Invoke-ChildProcess(
    [string]$PowerShellPath,
    [string]$ScriptPath,
    [string]$ManifestPath,
    [string]$Repository,
    [string]$UserName,
    [securestring]$Password,
    [string]$SensitiveValue,
    [DateTime]$DeadlineUtc,
    [System.Collections.IDictionary]$ChildEnvironment
) {
    if ([DateTime]::UtcNow -ge $DeadlineUtc) {
        Fail "the invocation-absolute child deadline expired during launcher setup"
    }
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $PowerShellPath
    $startInfo.ArgumentList.Add("-NoLogo")
    $startInfo.ArgumentList.Add("-NoProfile")
    $startInfo.ArgumentList.Add("-NonInteractive")
    $startInfo.ArgumentList.Add("-ExecutionPolicy")
    $startInfo.ArgumentList.Add("Bypass")
    $startInfo.ArgumentList.Add("-File")
    $startInfo.ArgumentList.Add($ScriptPath)
    $startInfo.ArgumentList.Add("-ChildManifest")
    $startInfo.ArgumentList.Add($ManifestPath)
    $startInfo.WorkingDirectory = $Repository
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    # ProcessStartInfo initializes this dictionary from the parent process on first
    # access. Clear it before adding only the explicit non-secret child contract;
    # otherwise CreateProcessWithLogonW also imports machine-level credentials such
    # as PGPASSWORD when its environment pointer is left null.
    $explicitEnvironment = $startInfo.Environment
    $explicitEnvironment.Clear()
    foreach ($name in @($ChildEnvironment.Keys | Sort-Object)) {
        $value = $ChildEnvironment[$name]
        if (
            $name -isnot [string] -or
            [string]::IsNullOrWhiteSpace($name) -or
            $value -isnot [string] -or
            $name -match "(?i)(TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)" -or
            $GitHubFileCommandEnvironmentNames -contains $name
        ) {
            Fail "the explicit child environment contains an invalid entry"
        }
        $explicitEnvironment[$name] = $value
    }
    if ($explicitEnvironment.Count -ne $ChildEnvironment.Count) {
        Fail "the explicit child environment lost an allowlisted entry"
    }
    $startInfo.LoadUserProfile = $false
    $startInfo.UserName = $UserName
    $startInfo.Domain = $env:COMPUTERNAME
    $startInfo.Password = $Password

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    $stdoutCapture = $null
    $stderrCapture = $null
    $childTimedOut = $false
    $terminationResult = $null
    $drainDeadline = $null
    $nextHeartbeat = [DateTime]::UtcNow.AddSeconds(30)
    try {
        $canaryName = $ParentEnvironmentCanaryName
        $previousCanary = [Environment]::GetEnvironmentVariable(
            $canaryName,
            [EnvironmentVariableTarget]::Process
        )
        [Environment]::SetEnvironmentVariable(
            $canaryName,
            "must-not-cross",
            [EnvironmentVariableTarget]::Process
        )
        try {
            if (-not $process.Start()) {
                Fail "the standard-user child process did not start"
            }
        } finally {
            [Environment]::SetEnvironmentVariable(
                $canaryName,
                $previousCanary,
                [EnvironmentVariableTarget]::Process
            )
        }
        $process.StandardInput.Close()
        $stdoutCapture = New-BoundedStreamCapture $process.StandardOutput "stdout"
        $stderrCapture = New-BoundedStreamCapture $process.StandardError "stderr"

        while ($true) {
            $now = [DateTime]::UtcNow
            if (-not $childTimedOut -and -not $process.HasExited -and $now -ge $DeadlineUtc) {
                $childTimedOut = $true
                $terminationResult = Invoke-BoundedNativeProcess `
                    "$env:SystemRoot\System32\taskkill.exe" `
                    @("/F", "/T", "/PID", [string]$process.Id) `
                    10000
                try {
                    if (-not $process.HasExited) {
                        $process.Kill($true)
                    }
                } catch {
                    if (-not $terminationResult.error) {
                        $terminationResult.error = $_.Exception.Message
                    }
                }
                $process.WaitForExit(5000) | Out-Null
                $drainDeadline = [DateTime]::UtcNow.AddMilliseconds(
                    $ChildCaptureDrainMilliseconds
                )
            } elseif ($process.HasExited -and $null -eq $drainDeadline) {
                $drainDeadline = [DateTime]::UtcNow.AddMilliseconds(
                    $ChildCaptureDrainMilliseconds
                )
            }

            $captureStates = @()
            foreach ($capture in @($stdoutCapture, $stderrCapture)) {
                if ($capture.ReadTask) {
                    $captureStates += $capture
                }
            }
            if ($process.HasExited -and $captureStates.Count -eq 0) {
                break
            }

            $waitDeadline = if ($null -ne $drainDeadline) {
                $drainDeadline
            } else {
                $DeadlineUtc
            }
            $remainingMilliseconds = [int][Math]::Max(
                1,
                [Math]::Min(
                    1000,
                    ($waitDeadline - [DateTime]::UtcNow).TotalMilliseconds
                )
            )
            if ([DateTime]::UtcNow -ge $waitDeadline) {
                break
            }

            if ($captureStates.Count -ne 0) {
                $readTasks = [System.Threading.Tasks.Task[]]@(
                    $captureStates | ForEach-Object { $_.ReadTask }
                )
                $completedIndex = [System.Threading.Tasks.Task]::WaitAny(
                    $readTasks,
                    $remainingMilliseconds
                )
                if ($completedIndex -ge 0) {
                    # Drain every ready pipe on each wakeup. Always consuming only
                    # WaitAny's lowest ready index can starve the other redirected
                    # stream until its pipe fills and blocks the child.
                    foreach ($captureState in $captureStates) {
                        if ($captureState.ReadTask -and $captureState.ReadTask.IsCompleted) {
                            Receive-BoundedStreamChunk $captureState
                        }
                    }
                }
            } else {
                $process.WaitForExit($remainingMilliseconds) | Out-Null
            }

            if (-not $process.HasExited -and [DateTime]::UtcNow -ge $nextHeartbeat) {
                Write-Host "standard-user exact-candidate consumer is still running (pid $($process.Id))"
                $nextHeartbeat = [DateTime]::UtcNow.AddSeconds(30)
            }
        }

        $result = [pscustomobject]@{
            exitCode = if ($process.HasExited) { $process.ExitCode } else { $null }
            stdoutTail = $stdoutCapture.Tail.ToString()
            stderrTail = $stderrCapture.Tail.ToString()
            stdoutTruncated = [bool]$stdoutCapture.Truncated
            stderrTruncated = [bool]$stderrCapture.Truncated
            captureIncomplete = [bool](
                -not $stdoutCapture.Complete -or
                -not $stderrCapture.Complete -or
                $stdoutCapture.Error -or
                $stderrCapture.Error
            )
        }
        if ($childTimedOut) {
            Fail (
                "standard-user child exceeded its invocation-absolute deadline; " +
                "bounded taskkill timedOut=$($terminationResult.timedOut) " +
                "exitCode=$($terminationResult.exitCode) error=$($terminationResult.error); " +
                (Format-ChildDiagnostics $result $SensitiveValue)
            )
        }
        if (-not $process.HasExited) {
            Fail (
                "standard-user child did not exit after its bounded wait; " +
                (Format-ChildDiagnostics $result $SensitiveValue)
            )
        }
        return $result
    } finally {
        if ($stdoutCapture) {
            $stdoutCapture.Reader.Dispose()
        }
        if ($stderrCapture) {
            $stderrCapture.Reader.Dispose()
        }
        $process.Dispose()
    }
}

function Invoke-ChildMode([string]$ManifestPath) {
    $manifestFile = Resolve-File $ManifestPath "-ChildManifest"
    $manifest = Read-JsonFilePreservingExactStringProperty `
        $manifestFile `
        "deadlineUtc" `
        "child manifest"
    if (
        $manifest.schema -cne "oliphaunt-windows-standard-user-launch-v1" -or
        $manifest.operation -notin @("self-test", "consumer") -or
        -not $manifest.deadlineUtc -or
        $manifest.consumerEntrypoint -isnot [string] -or
        $manifest.consumerEntrypointSha256 -notmatch '^[0-9a-f]{64}$' -or
        $manifest.consumerControlReadSetSha256 -notmatch '^[0-9a-f]{64}$' -or
        $manifest.protectedWritableInputs -isnot [System.Array]
    ) {
        Fail "child manifest has an unsupported schema or operation"
    }
    try {
        $manifestDeadline = [DateTimeOffset]::ParseExact(
            [string]$manifest.deadlineUtc,
            "O",
            [System.Globalization.CultureInfo]::InvariantCulture,
            [System.Globalization.DateTimeStyles]::RoundtripKind
        )
    } catch {
        Fail "child manifest deadlineUtc is not an exact round-trip timestamp"
    }
    if ($manifestDeadline.Offset -ne [TimeSpan]::Zero) {
        Fail "child manifest deadlineUtc must be UTC"
    }
    if ([DateTimeOffset]::UtcNow -ge $manifestDeadline) {
        Fail "child manifest deadline expired before token validation"
    }

    $identity = Get-CurrentIdentityContract
    if ($identity.Sid -cne $manifest.userSid) {
        Fail "child token SID does not match the ephemeral account"
    }
    if ($identity.Administrator) {
        Fail "child token is administrative; the nativeServer proof requires a standard user"
    }
    if (Test-Path ("Env:" + $ParentEnvironmentCanaryName)) {
        Fail "the parent process environment canary crossed the standard-user boundary"
    }
    $sensitiveEnvironmentNames = @(
        Get-ChildItem Env: |
            Where-Object { $_.Name -match "(?i)(TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)" } |
            ForEach-Object { $_.Name }
    )
    $presentFileCommands = @(
        $GitHubFileCommandEnvironmentNames |
            Where-Object { Test-Path ("Env:" + $_) }
    )
    if ($sensitiveEnvironmentNames.Count -ne 0) {
        Fail (
            "credential-like environment names crossed the standard-user boundary: " +
            (($sensitiveEnvironmentNames | Sort-Object -Unique) -join ", ")
        )
    }
    if ($presentFileCommands.Count -ne 0) {
        Fail (
            "GitHub file-command environment names crossed the standard-user boundary: " +
            (($presentFileCommands | Sort-Object -Unique) -join ", ")
        )
    }

    $repository = Resolve-Directory $manifest.repositoryRoot "child repository"
    $sandbox = Resolve-Directory $manifest.sandboxRoot "child sandbox"
    $toolExecutionRoot = Resolve-Directory `
        $manifest.toolExecutionRoot `
        "child tool execution root"
    if (
        -not (Test-PathInside $repository $sandbox) -or
        -not (Test-PathInside $repository $toolExecutionRoot) -or
        (Test-PathInside $sandbox $toolExecutionRoot) -or
        (Test-PathInside $toolExecutionRoot $sandbox)
    ) {
        Fail "child repository, sandbox, and tool execution roots violate containment"
    }
    $manifestToolStaging = @($manifest.toolStaging)
    if ($manifestToolStaging.Count -eq 0) {
        Fail "child manifest does not contain staged private tool trees"
    }
    $seenToolStagingIds = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::Ordinal
    )
    $seenToolStagingRoots = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    foreach ($staging in $manifestToolStaging) {
        if (
            $staging.id -isnot [string] -or
            $staging.id -notmatch '^private-tool-[0-9]{2}$' -or
            -not $seenToolStagingIds.Add($staging.id)
        ) {
            Fail "child manifest contains an invalid or duplicate tool staging identity"
        }
        $stagedRoot = Resolve-Directory `
            $staging.destinationRoot `
            "child staged tool root"
        if (
            -not (Test-PathInside $toolExecutionRoot $stagedRoot) -or
            -not $seenToolStagingRoots.Add($stagedRoot)
        ) {
            Fail "child staged tool root is outside the execution root or duplicated"
        }
        $observedFingerprint = Get-ToolTreeFingerprint `
            $stagedRoot `
            "child staged tool tree $($staging.id)"
        Assert-ToolTreeFingerprintEqual `
            $staging.fingerprint `
            $observedFingerprint `
            "child staged tool tree $($staging.id)"
    }
    $manifestToolPathDirectories = @($manifest.toolPathDirectories)
    if ($manifestToolPathDirectories.Count -eq 0) {
        Fail "child manifest does not contain the allowlisted tool PATH"
    }
    $toolPathDirectories = [System.Collections.Generic.List[string]]::new()
    $seenToolPathDirectories = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    foreach ($pathValue in $manifestToolPathDirectories) {
        if (
            $pathValue -isnot [string] -or
            [string]::IsNullOrWhiteSpace($pathValue) -or
            -not [System.IO.Path]::IsPathFullyQualified($pathValue) -or
            $pathValue.Contains([string][System.IO.Path]::PathSeparator)
        ) {
            Fail "child manifest contains an invalid tool PATH directory"
        }
        $resolvedToolPath = Resolve-Directory $pathValue "allowlisted tool PATH directory"
        if (-not $seenToolPathDirectories.Add($resolvedToolPath)) {
            Fail "child manifest contains duplicate tool PATH directories"
        }
        $toolPathDirectories.Add($resolvedToolPath) | Out-Null
    }
    foreach ($directory in $SandboxDirectoryNames) {
        Resolve-Directory (Join-Path $sandbox $directory) "child sandbox directory" | Out-Null
    }
    $env:HOME = Join-Path $sandbox "home"
    $env:USERPROFILE = $env:HOME
    $env:HOMEDRIVE = [System.IO.Path]::GetPathRoot($env:HOME).TrimEnd("\")
    $env:HOMEPATH = $env:HOME.Substring($env:HOMEDRIVE.Length)
    $env:TEMP = Join-Path $sandbox "tmp"
    $env:TMP = $env:TEMP
    $env:RUNNER_TEMP = Join-Path $sandbox "runner-temp"
    $env:APPDATA = Join-Path $sandbox "appdata"
    $env:LOCALAPPDATA = Join-Path $sandbox "local-appdata"
    $env:NPM_CONFIG_CACHE = Join-Path $sandbox "npm-cache"
    $env:BUN_INSTALL_CACHE_DIR = Join-Path $sandbox "bun-cache"
    $env:DENO_DIR = Join-Path $sandbox "deno-cache"
    $env:USERNAME = $manifest.userName
    $env:USERDOMAIN = $env:COMPUTERNAME
    $env:PATH = [string]::Join(
        [System.IO.Path]::PathSeparator,
        $toolPathDirectories
    )
    $env:GIT_CONFIG_COUNT = "1"
    $env:GIT_CONFIG_KEY_0 = "safe.directory"
    $env:GIT_CONFIG_VALUE_0 = $manifest.repositoryRoot
    $pnpmStore = Resolve-Directory $manifest.pnpmStore "child pnpm store"
    if (-not (Test-PathInside $sandbox $pnpmStore)) {
        Fail "child pnpm store is not inside the writable sandbox"
    }
    $env:npm_config_store_dir = $pnpmStore
    Assert-DirectoryCreateDenied `
        $toolExecutionRoot `
        "staged tool execution root"
    Assert-DirectoryWriteRoundTrip `
        $pnpmStore `
        "sandbox-local pnpm store"

    $expectedWritableRoots = [System.Collections.Generic.List[string]]::new()
    $expectedWritableRoots.Add($sandbox) | Out-Null
    if ($manifest.operation -eq "consumer") {
        $manifestOutputRoot = [System.IO.Path]::GetFullPath([string]$manifest.outputRoot)
        $expectedWritableRoots.Add(
            (Resolve-Directory (Split-Path -Parent $manifestOutputRoot) "consumer output parent")
        ) | Out-Null
        $expectedWritableRoots.Add(
            (Resolve-Directory `
                (Join-Path $repository "target/local-registry-archive-extract") `
                "local registry archive scratch")
        ) | Out-Null
        $expectedWritableRoots.Add(
            (Resolve-Directory `
                (Join-Path $repository "tools/release/verdaccio-runtime") `
                "Verdaccio runtime")
        ) | Out-Null
    }
    $manifestWritableRoots = @($manifest.writableRoots)
    if ($manifestWritableRoots.Count -ne $expectedWritableRoots.Count) {
        Fail "child manifest writable-root count does not match the operation contract"
    }
    $seenWritableRoots = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    for ($index = 0; $index -lt $expectedWritableRoots.Count; $index += 1) {
        if ($manifestWritableRoots[$index] -isnot [string]) {
            Fail "child manifest writable root is not a string"
        }
        $writableRoot = Resolve-Directory `
            ([string]$manifestWritableRoots[$index]) `
            "child writable root"
        if (
            -not [string]::Equals(
                $writableRoot,
                $expectedWritableRoots[$index],
                [System.StringComparison]::OrdinalIgnoreCase
            ) -or
            -not $seenWritableRoots.Add($writableRoot) -or
            -not (Test-PathInside $repository $writableRoot) -or
            (Test-PathInside $writableRoot $toolExecutionRoot) -or
            (Test-PathInside $toolExecutionRoot $writableRoot)
        ) {
            Fail "child manifest writable root escaped, overlapped tools, or was duplicated"
        }
        Assert-DirectoryWriteRoundTrip $writableRoot "authorized writable root $index"
    }

    $expectedProtectedInputs = [System.Collections.Generic.List[string]]::new()
    Add-ExpectedProtectedWritableInputs `
        $expectedProtectedInputs `
        $repository `
        $manifest.operation
    $manifestProtectedInputs = @($manifest.protectedWritableInputs)
    if ($manifestProtectedInputs.Count -ne $expectedProtectedInputs.Count) {
        Fail "child manifest protected-input count does not match the operation contract"
    }
    for ($index = 0; $index -lt $expectedProtectedInputs.Count; $index += 1) {
        $declared = $manifestProtectedInputs[$index]
        $protectedInput = Resolve-File $declared.path "child protected writable-subtree input"
        if (
            -not [string]::Equals(
                $protectedInput,
                $expectedProtectedInputs[$index],
                [System.StringComparison]::OrdinalIgnoreCase
            ) -or
            $declared.sha256 -notmatch '^[0-9a-f]{64}$' -or
            (Get-FileSha256 $protectedInput "child protected input") -cne $declared.sha256
        ) {
            Fail "child protected writable-subtree input disagrees with the parent contract"
        }
        Assert-FileWriteOpenDenied $protectedInput "tracked writable-subtree input"
        Assert-FileAppendOpenDenied $protectedInput "tracked writable-subtree input"
    }

    $bunPath = Resolve-File $manifest.bunPath "child staged Bun"
    if (-not (Test-PathInside $toolExecutionRoot $bunPath)) {
        Fail "child Bun path is not inside the staged tool execution root"
    }
    $consumerEntrypoint = Resolve-File `
        $manifest.consumerEntrypoint `
        "child exact-candidate consumer entrypoint"
    $expectedConsumerEntrypoint = Resolve-File `
        (Join-Path $repository $RepositoryConsumerRelativePath) `
        "child expected exact-candidate consumer entrypoint"
    if (
        -not [string]::Equals(
            $consumerEntrypoint,
            $expectedConsumerEntrypoint,
            [System.StringComparison]::OrdinalIgnoreCase
        ) -or
        $manifest.consumerEntrypointSha256 -notmatch '^[0-9a-f]{64}$'
    ) {
        Fail "child consumer entrypoint escaped or has an invalid expected digest"
    }
    Assert-InheritedRepositoryMutationDeny `
        $consumerEntrypoint `
        $identity.Sid `
        "repository consumer entrypoint"
    Assert-DirectoryCreateDenied $repository "repository root"
    Assert-FileWriteOpenDenied $consumerEntrypoint "repository consumer entrypoint"
    Assert-FileAppendOpenDenied $consumerEntrypoint "repository consumer entrypoint"
    Assert-FileAttributeWriteAllowed $consumerEntrypoint "repository consumer entrypoint"
    $seenControlDirectories = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    foreach ($relativeControlPath in $RepositoryConsumerControlReadRelativePaths) {
        $controlFile = Resolve-File `
            (Join-Path $repository $relativeControlPath) `
            "repository consumer control file"
        if (
            -not [string]::Equals(
                $controlFile,
                $consumerEntrypoint,
                [System.StringComparison]::OrdinalIgnoreCase
            )
        ) {
            Assert-InheritedRepositoryMutationDeny `
                $controlFile `
                $identity.Sid `
                "repository consumer control file"
            Assert-FileWriteOpenDenied $controlFile "repository consumer control file"
            Assert-FileAppendOpenDenied $controlFile "repository consumer control file"
        }
        $controlDirectory = Resolve-Directory `
            (Split-Path -Parent $controlFile) `
            "repository consumer control directory"
        if ($seenControlDirectories.Add($controlDirectory)) {
            Assert-InheritedRepositoryMutationDeny `
                $controlDirectory `
                $identity.Sid `
                "repository consumer control directory"
            Assert-DirectoryCreateDenied `
                $controlDirectory `
                "repository consumer control directory"
        }
    }
    $consumerEntrypointSha256 = Get-FileSha256 `
        $consumerEntrypoint `
        "child exact-candidate consumer entrypoint"
    if ($consumerEntrypointSha256 -cne $manifest.consumerEntrypointSha256) {
        Fail "child consumer entrypoint digest disagrees with the parent contract"
    }
    $consumerControlReadSetSha256 = Get-RepositoryControlReadSetSha256 $repository
    if ($consumerControlReadSetSha256 -cne $manifest.consumerControlReadSetSha256) {
        Fail "child consumer control read set disagrees with the parent contract"
    }
    Assert-CleanTrackedCandidateTree `
        $repository `
        "before staged Bun consumer module-load proof"
    $consumerModuleLoadResult = Invoke-BoundedToolProbe `
        $bunPath `
        @($consumerEntrypoint, $RepositoryConsumerModuleLoadArgument) `
        30000
    if (
        -not $consumerModuleLoadResult.started -or
        $consumerModuleLoadResult.timedOut -or
        $consumerModuleLoadResult.error -or
        $consumerModuleLoadResult.exitCode -ne 0 -or
        $consumerModuleLoadResult.stdout.Trim() -cne
            ($RepositoryConsumerModuleLoadProof + "`t" + $consumerControlReadSetSha256) -or
        -not [string]::IsNullOrWhiteSpace($consumerModuleLoadResult.stderr)
    ) {
        $moduleStdout = ConvertTo-Json (
            ConvertTo-SanitizedDiagnosticTail `
                $consumerModuleLoadResult.stdout `
                "" `
                $false
        ) -Compress
        $moduleStderr = ConvertTo-Json (
            ConvertTo-SanitizedDiagnosticTail `
                $consumerModuleLoadResult.stderr `
                "" `
                $false
        ) -Compress
        Fail (
            "staged Bun failed the repository consumer module-load proof: " +
            "exitCode=$($consumerModuleLoadResult.exitCode) " +
            "timedOut=$($consumerModuleLoadResult.timedOut) " +
            "error=$($consumerModuleLoadResult.error) " +
            "stdout=$moduleStdout stderr=$moduleStderr"
        )
    }
    if (
        (Get-RepositoryControlReadSetSha256 $repository) -cne
            $manifest.consumerControlReadSetSha256
    ) {
        Fail "staged Bun changed the repository consumer control read set"
    }
    Assert-CleanTrackedCandidateTree `
        $repository `
        "after staged Bun consumer module-load proof"
    $repositoryAccessEvidence = [ordered]@{
        entrypointSha256 = $consumerEntrypointSha256
        controlReadSetSha256 = $consumerControlReadSetSha256
        dotNetReadVerified = $true
        bunModuleLoadVerified = $true
        preflightTrackedTreeCleanVerified = $true
        entrypointDataWriteDenied = $true
        entrypointAppendDenied = $true
        metadataWriteVerified = $true
        inheritedMutationDenyVerified = $true
        controlReadSetMutationDenied = $true
        rootCreateDenied = $true
        sourceDirectoryCreateDenied = $true
        protectedWritableInputsWriteDenied = $true
    }
    $manifestToolProbes = @($manifest.toolProbes)
    $expectedProbeNames = @(
        "bun",
        "deno",
        "npm",
        "pnpm",
        "node",
        "git",
        "tar",
        "unzip",
        "bash",
        "cmd",
        "taskkill"
    )
    $observedProbeNames = @(
        $manifestToolProbes | ForEach-Object { [string]$_.name }
    )
    if (
        $manifestToolProbes.Count -ne $expectedProbeNames.Count -or
        [string]::Join("`n", $observedProbeNames) -cne
            [string]::Join("`n", $expectedProbeNames)
    ) {
        Fail "child manifest tool probes do not match the operation contract"
    }
    $expectedToolPathDirectories = [System.Collections.Generic.List[string]]::new()
    $seenExpectedToolPathDirectories = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    foreach ($probe in $manifestToolProbes) {
        $probePathForDirectory = Resolve-File `
            $probe.path `
            "child $($probe.name) PATH probe executable"
        $probeDirectory = Resolve-Directory `
            (Split-Path -Parent $probePathForDirectory) `
            "child $($probe.name) PATH directory"
        if ($seenExpectedToolPathDirectories.Add($probeDirectory)) {
            $expectedToolPathDirectories.Add($probeDirectory) | Out-Null
        }
    }
    $currentPowerShellPath = Resolve-File `
        ([System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName) `
        "child PowerShell"
    foreach ($publicDirectory in @(
        (Resolve-Directory (Split-Path -Parent $currentPowerShellPath) "child PowerShell directory"),
        (Resolve-Directory (Join-Path $env:SystemRoot "System32") "child System32")
    )) {
        if ($seenExpectedToolPathDirectories.Add($publicDirectory)) {
            $expectedToolPathDirectories.Add($publicDirectory) | Out-Null
        }
    }
    if ($toolPathDirectories.Count -ne $expectedToolPathDirectories.Count) {
        Fail "child tool PATH has unexpected or missing directories"
    }
    for ($index = 0; $index -lt $toolPathDirectories.Count; $index += 1) {
        if (
            -not [string]::Equals(
                $toolPathDirectories[$index],
                $expectedToolPathDirectories[$index],
                [System.StringComparison]::OrdinalIgnoreCase
            )
        ) {
            Fail "child tool PATH precedence disagrees with the exact probe contract"
        }
    }
    $toolProbeEvidence = [System.Collections.Generic.List[object]]::new()
    $seenProbeNames = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::Ordinal
    )
    foreach ($probe in $manifestToolProbes) {
        if (
            $probe.name -isnot [string] -or
            -not $seenProbeNames.Add($probe.name) -or
            $probe.path -isnot [string]
        ) {
            Fail "child manifest contains an invalid or duplicate tool probe"
        }
        $probePath = Resolve-File $probe.path "child $($probe.name) probe executable"
        $probeArguments = @($probe.arguments)
        if (
            @(
                $probeArguments |
                    Where-Object { $_ -isnot [string] -or $_.Contains([char]0) }
            ).Count -ne 0
        ) {
            Fail "child manifest contains invalid $($probe.name) probe arguments"
        }
        $probeIsStaged = Test-PathInside $toolExecutionRoot $probePath
        if ($probeIsStaged) {
            Assert-FileWriteOpenDenied `
                $probePath `
                "staged $($probe.name) executable"
        }
        $probeResult = Invoke-BoundedToolProbe `
            $probePath `
            @($probeArguments) `
            30000
        if (
            -not $probeResult.started -or
            $probeResult.timedOut -or
            $probeResult.error -or
            $probeResult.exitCode -ne 0 -or
            [string]::IsNullOrWhiteSpace($probeResult.stdout + $probeResult.stderr)
        ) {
            $probeStdout = ConvertTo-Json (
                ConvertTo-SanitizedDiagnosticTail `
                    $probeResult.stdout `
                    "" `
                    $false
            ) -Compress
            $probeStderr = ConvertTo-Json (
                ConvertTo-SanitizedDiagnosticTail `
                    $probeResult.stderr `
                    "" `
                    $false
            ) -Compress
            Fail (
                "$($probe.name) failed its standard-user execution probe: " +
                "exitCode=$($probeResult.exitCode) timedOut=$($probeResult.timedOut) " +
                "error=$($probeResult.error) stdout=$probeStdout stderr=$probeStderr"
            )
        }
        $probeBytes = $Utf8NoBom.GetBytes(
            $probeResult.stdout + [char]0 + $probeResult.stderr
        )
        try {
            $probeOutputSha256 = [Convert]::ToHexString(
                [System.Security.Cryptography.SHA256]::HashData($probeBytes)
            ).ToLowerInvariant()
        } finally {
            [Array]::Clear($probeBytes, 0, $probeBytes.Length)
        }
        $toolProbeEvidence.Add([ordered]@{
            name = $probe.name
            staged = $probeIsStaged
            exitCode = [int]$probeResult.exitCode
            outputSha256 = $probeOutputSha256
        }) | Out-Null
    }
    $bunProbe = @($toolProbeEvidence | Where-Object { $_.name -ceq "bun" })
    if ($bunProbe.Count -ne 1 -or -not $bunProbe[0].staged) {
        Fail "child did not execute exactly one staged Bun probe"
    }

    $candidate = $null
    if ($manifest.operation -eq "consumer") {
        $head = (& git -C $repository rev-parse HEAD).Trim()
        if ($LASTEXITCODE -ne 0 -or $head -cne $manifest.candidateSha) {
            Fail "child checkout does not match the exact candidate SHA"
        }
        $tree = (& git -C $repository rev-parse "HEAD^{tree}").Trim()
        if ($LASTEXITCODE -ne 0 -or $tree -notmatch "^[0-9a-f]{40}$") {
            Fail "child could not resolve the exact candidate tree"
        }
        $candidate = [ordered]@{ sha = $head; tree = $tree }
    }

    $proof = [ordered]@{
        schema = "oliphaunt-windows-standard-user-proof-v1"
        mechanism = "ephemeral-local-standard-user"
        operation = $manifest.operation
        account = [ordered]@{
            name = $identity.Name
            sid = $identity.Sid
        }
        token = [ordered]@{ administrator = $false }
        environment = [ordered]@{
            sensitiveNamesAbsent = $true
            githubFileCommandsAbsent = $true
        }
        repositoryAccess = $repositoryAccessEvidence
        toolAccess = [ordered]@{
            stagingVerified = $true
            stagedTreeCount = $manifestToolStaging.Count
            bunExecuted = $true
            toolRootWriteDenied = $true
            sandboxWriteVerified = $true
            writableRootsNestedRoundTripVerified = $true
            probes = @($toolProbeEvidence)
        }
        deadlineUtc = $manifest.deadlineUtc
        candidate = $candidate
        target = if ($manifest.operation -eq "consumer") { $manifest.target } else { $null }
    }
    Write-JsonFile $manifest.proofPath $proof

    if ($manifest.operation -eq "self-test") {
        Write-Output "OLIPHAUNT_WINDOWS_STANDARD_USER_CHILD_OK"
        return
    }

    $env:OLIPHAUNT_WINDOWS_STANDARD_USER_PROOF = $manifest.proofPath
    Set-Location $manifest.repositoryRoot
    $arguments = @(
        (Join-Path $manifest.repositoryRoot "tools/release/js-exact-candidate-consumer.mjs"),
        "--candidate-sha", $manifest.candidateSha,
        "--target", $manifest.target,
        "--artifact-root", "target/js-exact-candidate-input/native",
        "--artifact-root", "target/js-exact-candidate-input/broker",
        "--artifact-root", "target/js-exact-candidate-input/node",
        "--artifact-root", "target/js-exact-candidate-input/extensions",
        "--ios-extension-artifact-root", "target/js-exact-candidate-input/ios-extensions",
        "--artifact-root", "target/js-exact-candidate-input/js",
        "--artifact-root", "target/js-exact-candidate-input/ios",
        "--output-root", $manifest.outputRoot
    )
    & $bunPath @arguments
    $consumerExitCode = $LASTEXITCODE
    if (
        (Get-RepositoryControlReadSetSha256 $repository) -cne
            $manifest.consumerControlReadSetSha256
    ) {
        Fail "exact-candidate consumer changed its repository control read set"
    }
    Assert-CleanTrackedCandidateTree `
        $repository `
        "after exact-candidate consumer"
    if ($consumerExitCode -ne 0) {
        Fail "exact-candidate consumer exited with status $consumerExitCode"
    }
}

function Write-LauncherReceipt(
    [string]$ReceiptOutputRoot,
    [string]$State,
    [string]$ReceiptCandidateSha,
    [string]$ReceiptTarget,
    [string]$StartedAtUtc,
    [string]$DeadlineUtc,
    [object]$Proof,
    [string]$Message,
    [object]$ProcessCleanup,
    [bool]$AccountRemoved,
    [int]$AclGrantCount,
    [bool]$AclGrantsRemoved,
    [bool]$SandboxRemoved,
    [object]$ToolStaging,
    [bool]$ToolExecutionRootRemoved,
    [bool]$PostCleanupTrackedSourceIntegrityVerified
) {
    if (-not $ReceiptOutputRoot) {
        return
    }
    $receiptPath = Join-Path $ReceiptOutputRoot "evidence/windows-standard-user-launch.json"
    Write-JsonFile $receiptPath ([ordered]@{
        schema = "oliphaunt-windows-standard-user-launch-receipt-v1"
        state = $State
        mechanism = "ephemeral-local-standard-user"
        candidateSha = $ReceiptCandidateSha
        target = $ReceiptTarget
        startedAtUtc = $StartedAtUtc
        deadlineUtc = $DeadlineUtc
        tokenProof = $Proof
        processCleanup = $ProcessCleanup
        accountRemoved = $AccountRemoved
        aclGrantCount = $AclGrantCount
        aclGrantsRemoved = $AclGrantsRemoved
        sandboxRemoved = $SandboxRemoved
        toolStaging = $ToolStaging
        toolExecutionRootRemoved = $ToolExecutionRootRemoved
        postCleanupTrackedSourceIntegrityVerified =
            $PostCleanupTrackedSourceIntegrityVerified
        error = if ($Message) { $Message } else { $null }
    })
}

function Invoke-ParentMode {
    if ($PSVersionTable.PSVersion.Major -lt 7) {
        Fail "PowerShell 7 or newer is required"
    }
    $parentIdentity = Get-CurrentIdentityContract
    if (-not $parentIdentity.Administrator) {
        Fail "the Windows hosted-runner parent must be administrative to create the ephemeral proof account"
    }

    $repository = Resolve-Directory $RepositoryRoot "-RepositoryRoot"
    $consumerEntrypoint = Resolve-File `
        (Join-Path $repository $RepositoryConsumerRelativePath) `
        "exact-candidate consumer entrypoint"
    $consumerEntrypointSha256 = Get-FileSha256 `
        $consumerEntrypoint `
        "exact-candidate consumer entrypoint"
    $consumerControlReadSetSha256 = Get-RepositoryControlReadSetSha256 $repository
    $scriptPath = Resolve-File $PSCommandPath "launcher script"
    $powerShellExecutable = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
    $powerShellPath = Resolve-File $powerShellExecutable "PowerShell"
    $windowsRoot = Resolve-Directory $env:SystemRoot "SystemRoot"
    $system32 = Resolve-Directory (Join-Path $windowsRoot "System32") "System32"
    $childPathDirectories = [System.Collections.Generic.List[string]]::new()
    $seenChildPathDirectories = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    $operation = if ($SelfTest) { "self-test" } else { "consumer" }
    $childDeadlineUtc = if ($SelfTest) {
        $LauncherStartedAtUtc.AddMinutes(10)
    } else {
        $LauncherStartedAtUtc.AddMinutes(65)
    }
    $startedAtText = $LauncherStartedAtUtc.ToString("O")
    $childDeadlineText = $childDeadlineUtc.ToString("O")
    $resolvedOutputRoot = $null
    $resolvedBun = Resolve-File $BunPath "-BunPath"

    if (-not $SelfTest) {
        if ($CandidateSha -notmatch "^[0-9a-f]{40}$") {
            Fail "-CandidateSha must be a full lowercase Git commit SHA"
        }
        if ($Target -cne "windows-x64-msvc") {
            Fail "-Target must be windows-x64-msvc"
        }
        if (-not $OutputRoot) {
            Fail "-OutputRoot is required"
        }
        $resolvedOutputRoot = [System.IO.Path]::GetFullPath($OutputRoot)
        $expectedOutputRoot = [System.IO.Path]::GetFullPath(
            (Join-Path `
                $repository `
                "target/js-exact-candidate-consumer/windows-x64-msvc")
        )
        if (
            -not [string]::Equals(
                $resolvedOutputRoot,
                $expectedOutputRoot,
                [System.StringComparison]::OrdinalIgnoreCase
            )
        ) {
            Fail "-OutputRoot must be the exact Windows candidate output root"
        }
        foreach ($relative in @(
            "target/js-exact-candidate-input/native",
            "target/js-exact-candidate-input/broker",
            "target/js-exact-candidate-input/node",
            "target/js-exact-candidate-input/extensions",
            "target/js-exact-candidate-input/ios-extensions",
            "target/js-exact-candidate-input/js",
            "target/js-exact-candidate-input/ios"
        )) {
            Resolve-Directory (Join-Path $repository $relative) "exact-candidate artifact root" | Out-Null
        }
    }

    $nonceBytes = [byte[]]::new(8)
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($nonceBytes)
    try {
        $nonce = [Convert]::ToHexString($nonceBytes).ToLowerInvariant()
    } finally {
        [Array]::Clear($nonceBytes, 0, $nonceBytes.Length)
    }
    $userName = "oliphaunt-" + $nonce.Substring(0, 9)
    if (
        $userName.Length -gt $LocalUserNameMaxLength -or
        $userName -match '["/\\\[\]:;|=,+*?<>@]' -or
        $userName -match '^[. ]+$'
    ) {
        Fail "generated local-user name violates the Windows account-name contract"
    }
    $sandbox = Join-Path $repository "target/windows-standard-user/$nonce"
    $toolExecutionRoot = Join-Path $repository "target/windows-standard-user-tools/$nonce"
    if (
        (Test-PathInside $sandbox $toolExecutionRoot) -or
        (Test-PathInside $toolExecutionRoot $sandbox)
    ) {
        Fail "tool execution root and writable sandbox must be disjoint"
    }
    New-Item -ItemType Directory -Force -Path $sandbox | Out-Null
    $manifestPath = Join-Path $sandbox "launch.json"
    $proofPath = Join-Path $sandbox "proof.json"
    $grantedPaths = [System.Collections.Generic.List[string]]::new()
    $writableRoots = [System.Collections.Generic.List[string]]::new()
    $protectedWritableInputs = [System.Collections.Generic.List[object]]::new()
    $user = $null
    $password = $null
    $passwordText = $null
    $proof = $null
    $childResult = $null
    $failure = $null
    $accountRemoved = $false
    $processesQuiescent = $false
    $postCleanupTrackedSourceIntegrityVerified = $false
    $canonicalUserName = $env:COMPUTERNAME + "\" + $userName
    $processCleanup = [ordered]@{
        method = "Get-Process -IncludeUserName"
        attempted = $false
        accountName = $null
        accountSid = $null
        initialTaskkillExitCode = $null
        initialTaskkillTimedOut = $false
        verified = $false
        zeroProcessSamples = 0
        remainingProcesses = @()
        observations = @()
        terminatedProcessIds = @()
        commandFailures = @()
        verificationError = $null
    }
    $cleanupErrors = [System.Collections.Generic.List[string]]::new()
    $aclGrantCount = 0
    $aclGrantsRemoved = $false
    $sandboxRemoved = $false
    $toolExecutionRootRemoved = $false
    $toolStagingEvidence = @()
    $currentStage = "initialize launcher"

    try {
        $currentStage = "create ephemeral standard-user account"
        $passwordText = New-RandomPassword
        if ($passwordText.Length -gt $LocalUserPasswordMaxLength) {
            Fail (
                "generated local-user password exceeds the Windows limit of " +
                "$LocalUserPasswordMaxLength characters"
            )
        }
        $password = ConvertTo-SecureString $passwordText -AsPlainText -Force
        $localUserDescription = "Oliphaunt exact-candidate standard-user"
        if ($localUserDescription.Length -gt $LocalUserDescriptionMaxLength) {
            Fail (
                "ephemeral local-user description exceeds the Windows limit of " +
                "$LocalUserDescriptionMaxLength characters"
            )
        }
        $newUser = @{
            Name = $userName
            Password = $password
            Description = $localUserDescription
            AccountNeverExpires = $true
            PasswordNeverExpires = $true
            UserMayNotChangePassword = $true
        }
        $user = New-LocalUser @newUser
        Assert-LocalStandardUser $user
        $sid = $user.SID.Value
        $canonicalUserName = ([System.Security.Principal.SecurityIdentifier]::new($sid)).Translate(
            [System.Security.Principal.NTAccount]
        ).Value

        $currentStage = "grant bounded standard-user filesystem access"
        $repositoryReadRights =
            [System.Security.AccessControl.FileSystemRights]::ReadAndExecute -bor
            [System.Security.AccessControl.FileSystemRights]::WriteAttributes -bor
            [System.Security.AccessControl.FileSystemRights]::Synchronize
        $repositoryMutationRights =
            [System.Security.AccessControl.FileSystemRights]::WriteData -bor
            [System.Security.AccessControl.FileSystemRights]::AppendData -bor
            [System.Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
            [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
            [System.Security.AccessControl.FileSystemRights]::Delete -bor
            [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
            [System.Security.AccessControl.FileSystemRights]::TakeOwnership
        Set-RepositoryEphemeralAclContract `
            $repository `
            $sid `
            $repositoryReadRights `
            $repositoryMutationRights `
            $grantedPaths
        Add-EphemeralAclGrant `
            $sandbox `
            $sid `
            ([System.Security.AccessControl.FileSystemRights]::Modify) `
            $grantedPaths
        $writableRoots.Add($sandbox) | Out-Null
        foreach ($directory in $SandboxDirectoryNames) {
            New-Item -ItemType Directory -Force -Path (Join-Path $sandbox $directory) | Out-Null
        }

        $pnpmStore = Join-Path $sandbox "pnpm-store"
        if (-not $SelfTest) {
            $outputParent = Split-Path -Parent $resolvedOutputRoot
            $archiveScratch = Join-Path $repository "target/local-registry-archive-extract"
            $verdaccioRuntime = Join-Path $repository "tools/release/verdaccio-runtime"
            foreach ($writable in @($outputParent, $archiveScratch, $verdaccioRuntime)) {
                New-Item -ItemType Directory -Force -Path $writable | Out-Null
                Add-EphemeralAclGrant `
                    $writable `
                    $sid `
                    ([System.Security.AccessControl.FileSystemRights]::Modify) `
                    $grantedPaths
                $writableRoots.Add([System.IO.Path]::GetFullPath($writable)) | Out-Null
            }
            foreach ($relativeInput in @(
                "tools/release/verdaccio-runtime/package.json",
                "tools/release/verdaccio-runtime/pnpm-lock.yaml"
            )) {
                $protectedInput = Resolve-File `
                    (Join-Path $repository $relativeInput) `
                    "tracked writable-subtree input"
                Add-EphemeralAclDeny `
                    $protectedInput `
                    $sid `
                    $repositoryMutationRights `
                    $false `
                    $grantedPaths
                $protectedWritableInputs.Add([pscustomobject][ordered]@{
                    path = $protectedInput
                    sha256 = (Get-FileSha256 $protectedInput "tracked writable-subtree input")
                }) | Out-Null
            }
        }

        if (-not $env:RUNNER_TEMP) {
            Fail "RUNNER_TEMP is required to stage private hosted-runner tools"
        }
        $currentStage = "resolve exact private tool contract"
        $runnerTemp = Resolve-Directory $env:RUNNER_TEMP "RUNNER_TEMP"
        if (
            (Test-PathInside $runnerTemp $powerShellPath) -or
            (Test-PathInside $runnerTemp $system32)
        ) {
            Fail "PowerShell and System32 must not be private RUNNER_TEMP tools"
        }
        $privateToolEnvelopeInputs = [ordered]@{
            bun = $BunEnvelope
            deno = $DenoEnvelope
            'npm' = $NpmEnvelope
            node = $NodeEnvelope
            pnpm = $PnpmEnvelope
        }
        $privateToolEnvelopes = [ordered]@{}
        foreach ($toolName in $privateToolEnvelopeInputs.Keys) {
            $declaredEnvelope = Resolve-Directory `
                $privateToolEnvelopeInputs[$toolName] `
                "$toolName declared private tool execution envelope"
            if (-not (Test-PathInside $runnerTemp $declaredEnvelope)) {
                Fail "$toolName declared private tool execution envelope escaped RUNNER_TEMP"
            }
            $privateToolEnvelopes[$toolName] = $declaredEnvelope
        }
        $toolSpecifications = @(
            Get-ToolProbeSpecifications $resolvedBun $privateToolEnvelopes
        )
        $privateToolRoots = [System.Collections.Generic.Dictionary[string, object]]::new(
            [System.StringComparer]::OrdinalIgnoreCase
        )
        $toolStaging = [System.Collections.Generic.List[object]]::new()
        $toolProbes = [System.Collections.Generic.List[object]]::new()
        $stagedBunPath = $null
        $privateToolIndex = 0
        New-Item -ItemType Directory -Force -Path $toolExecutionRoot | Out-Null
        Set-ReadOnlyToolExecutionAcl `
            $toolExecutionRoot `
            $sid `
            $parentIdentity.Sid `
            $grantedPaths

        foreach ($specification in $toolSpecifications) {
            $currentStage = "resolve $($specification.name) tool envelope"
            $sourceCommandPath = Resolve-File $specification.path "$($specification.name) tool"
            $effectiveCommandPath = $sourceCommandPath
            $privateToolRoot = Get-PrivateToolRoot `
                $specification.name `
                $sourceCommandPath `
                $runnerTemp `
                $specification.envelope
            if ($privateToolRoot) {
                $privateToolRoot = Resolve-Directory $privateToolRoot "private tool root"
                if (-not $privateToolRoots.ContainsKey($privateToolRoot)) {
                    $currentStage = "stage $($specification.name) private tool envelope"
                    $privateToolIndex += 1
                    $toolId = "private-tool-" + $privateToolIndex.ToString(
                        "D2",
                        [System.Globalization.CultureInfo]::InvariantCulture
                    )
                    $destinationRoot = Join-Path $toolExecutionRoot $toolId
                    $fingerprint = Copy-PrivateToolTree `
                        $privateToolRoot `
                        $destinationRoot `
                        $toolId
                    $stagingEntry = [pscustomobject][ordered]@{
                        id = $toolId
                        destinationRoot = Resolve-Directory $destinationRoot "$toolId destination"
                        fingerprint = $fingerprint
                    }
                    $privateToolRoots.Add($privateToolRoot, $stagingEntry)
                    $toolStaging.Add($stagingEntry) | Out-Null
                    $toolStagingEvidence = @($toolStaging)
                    Write-Output "Staged verified $($specification.name) tool envelope"
                }
                $currentStage = "resolve staged $($specification.name) command"
                $stagedRoot = $privateToolRoots[$privateToolRoot].destinationRoot
                $relativeCommand = [System.IO.Path]::GetRelativePath(
                    $privateToolRoot,
                    $sourceCommandPath
                )
                if (
                    [System.IO.Path]::IsPathFullyQualified($relativeCommand) -or
                    $relativeCommand -eq ".." -or
                    $relativeCommand.StartsWith(
                        ".." + [System.IO.Path]::DirectorySeparatorChar,
                        [System.StringComparison]::Ordinal
                    )
                ) {
                    Fail "$($specification.name) staged command escaped its private tool root"
                }
                $effectiveCommandPath = Resolve-File `
                    (Join-Path $stagedRoot $relativeCommand) `
                    "$($specification.name) staged command"
            }
            $currentStage = "record $($specification.name) tool probe"
            if (Test-PathInside $runnerTemp $effectiveCommandPath) {
                Fail "$($specification.name) child command still points into private RUNNER_TEMP"
            }
            $commandDirectory = Resolve-Directory `
                (Split-Path -Parent $effectiveCommandPath) `
                "tool PATH directory"
            if ($commandDirectory.Contains([string][System.IO.Path]::PathSeparator)) {
                Fail "tool PATH directory contains the Windows PATH separator"
            }
            if ($seenChildPathDirectories.Add($commandDirectory)) {
                $childPathDirectories.Add($commandDirectory) | Out-Null
            }
            $toolProbes.Add([pscustomobject][ordered]@{
                name = [string]$specification.name
                path = $effectiveCommandPath
                arguments = @($specification.arguments)
            }) | Out-Null
            if ($specification.name -ceq "bun") {
                $stagedBunPath = $effectiveCommandPath
            }
        }
        $currentStage = "finalize exact private tool contract"
        foreach ($publicDirectory in @(
            (Resolve-Directory (Split-Path -Parent $powerShellPath) "PowerShell directory"),
            $system32
        )) {
            if ($seenChildPathDirectories.Add($publicDirectory)) {
                $childPathDirectories.Add($publicDirectory) | Out-Null
            }
        }
        if (
            -not $stagedBunPath -or
            -not (Test-PathInside $toolExecutionRoot $stagedBunPath) -or
            $toolStaging.Count -eq 0
        ) {
            Fail "Bun must execute from a data-only staged private tool tree"
        }
        $toolStagingEvidence = @($toolStaging)

        $currentStage = "write standard-user launch manifest"
        $manifest = [ordered]@{
            schema = "oliphaunt-windows-standard-user-launch-v1"
            operation = $operation
            repositoryRoot = $repository
            consumerEntrypoint = $consumerEntrypoint
            consumerEntrypointSha256 = $consumerEntrypointSha256
            consumerControlReadSetSha256 = $consumerControlReadSetSha256
            outputRoot = $resolvedOutputRoot
            bunPath = $stagedBunPath
            candidateSha = if ($SelfTest) { $null } else { $CandidateSha }
            target = if ($SelfTest) { $null } else { $Target }
            userName = $userName
            userSid = $sid
            deadlineUtc = $childDeadlineText
            sandboxRoot = $sandbox
            proofPath = $proofPath
            pnpmStore = $pnpmStore
            writableRoots = @($writableRoots)
            protectedWritableInputs = @($protectedWritableInputs)
            toolExecutionRoot = $toolExecutionRoot
            toolStaging = @($toolStaging)
            toolProbes = @($toolProbes)
            toolPathDirectories = @($childPathDirectories)
        }
        Assert-NoForbiddenString `
            $manifest `
            $runnerTemp `
            "child manifest"
        Write-JsonFile $manifestPath $manifest
        $childEnvironment = New-ExplicitChildEnvironment $manifest $windowsRoot $system32
        Write-Output "Launching $operation under an ephemeral local standard-user token"
        $currentStage = "launch standard-user child"
        $childResult = Invoke-ChildProcess `
            $powerShellPath `
            $scriptPath `
            $manifestPath `
            $repository `
            $userName `
            $password `
            $passwordText `
            $childDeadlineUtc `
            $childEnvironment
        $currentStage = "validate parent-side consumer entrypoint integrity"
        if (
            (Get-FileSha256 $consumerEntrypoint "parent-side consumer entrypoint") -cne
                $consumerEntrypointSha256 -or
            (Get-RepositoryControlReadSetSha256 $repository) -cne
                $consumerControlReadSetSha256
        ) {
            Fail "standard-user child changed the repository consumer control bytes"
        }
        Assert-CleanTrackedCandidateTree `
            $repository `
            "after standard-user child"
        $currentStage = "validate standard-user child proof"
        $proof = Read-And-ValidateProof `
            $proofPath `
            $manifest `
            $childResult `
            $passwordText
        $currentStage = "validate standard-user child exit status"
        if ($childResult.exitCode -ne 0) {
            Fail (
                "standard-user child exited with status $($childResult.exitCode); " +
                (Format-ChildDiagnostics $childResult $passwordText)
            )
        }
    } catch {
        $failure = [System.Exception]::new(
            "$currentStage failed: $($_.Exception.Message)",
            $_.Exception
        )
    } finally {
        $passwordText = $null
        if ($password) {
            $password.Dispose()
        }
        if ($user) {
            try {
                Stop-And-ProveNoAccountProcesses $canonicalUserName $user.SID.Value $processCleanup
                if ($processCleanup.verified -ne $true) {
                    Fail "standard-user process cleanup returned without verified quiescence"
                }
                $processesQuiescent = $true
            } catch {
                Add-CleanupFailure $cleanupErrors "standard-user process cleanup proof" $_
            }
            try {
                if (
                    (Get-FileSha256 $consumerEntrypoint "cleanup consumer entrypoint") -cne
                        $consumerEntrypointSha256 -or
                    (Get-RepositoryControlReadSetSha256 $repository) -cne
                        $consumerControlReadSetSha256
                ) {
                    Fail "repository consumer control bytes changed before ACL cleanup"
                }
                Assert-CleanTrackedCandidateTree `
                    $repository `
                    "during standard-user failure cleanup"
            } catch {
                Add-CleanupFailure $cleanupErrors "consumer entrypoint integrity proof" $_
            }
            $uniqueGrantedPaths = @($grantedPaths | Select-Object -Unique)
            $aclGrantCount = $uniqueGrantedPaths.Count
            if ($processesQuiescent) {
                $aclGrantsRemoved = $true
                for ($index = $uniqueGrantedPaths.Count - 1; $index -ge 0; $index -= 1) {
                    $grantedPath = $uniqueGrantedPaths[$index]
                    if (
                        [string]::Equals(
                            $grantedPath,
                            $repository,
                            [System.StringComparison]::OrdinalIgnoreCase
                        )
                    ) {
                        continue
                    }
                    try {
                        Remove-EphemeralAclGrant $grantedPath $user.SID.Value
                    } catch {
                        $aclGrantsRemoved = $false
                        Add-CleanupFailure $cleanupErrors "ACL grant removal for $grantedPath" $_
                    }
                }
                try {
                    Remove-LocalUser -Name $userName -ErrorAction Stop
                    $accountRemoved = $true
                } catch {
                    Add-CleanupFailure $cleanupErrors "ephemeral account removal" $_
                }
                if ($accountRemoved) {
                    try {
                        Remove-EphemeralAclGrant $repository $user.SID.Value
                    } catch {
                        $aclGrantsRemoved = $false
                        Add-CleanupFailure `
                            $cleanupErrors `
                            "repository ACL contract removal after account deletion" `
                            $_
                    }
                    try {
                        Assert-NoAclRulesForSid `
                            $consumerEntrypoint `
                            $user.SID.Value `
                            "repository consumer entrypoint after ACL cleanup"
                    } catch {
                        $aclGrantsRemoved = $false
                        Add-CleanupFailure `
                            $cleanupErrors `
                            "inherited consumer entrypoint ACL absence proof" `
                            $_
                    }
                    foreach ($grantedPath in $uniqueGrantedPaths) {
                        try {
                            Remove-EphemeralAclGrant $grantedPath $user.SID.Value
                        } catch {
                            $aclGrantsRemoved = $false
                            Add-CleanupFailure `
                                $cleanupErrors `
                                "idempotent ACL absence proof for $grantedPath" `
                                $_
                        }
                    }
                    try {
                        Assert-NoAclRulesForSid `
                            $consumerEntrypoint `
                            $user.SID.Value `
                            "repository consumer entrypoint after idempotent ACL cleanup"
                    } catch {
                        $aclGrantsRemoved = $false
                        Add-CleanupFailure `
                            $cleanupErrors `
                            "idempotent inherited consumer ACL absence proof" `
                            $_
                    }
                } else {
                    $aclGrantsRemoved = $false
                    Add-CleanupFailure `
                        $cleanupErrors `
                        "repository ACL contract retention" `
                        ([System.Exception]::new(
                            "ephemeral account removal failed; repository SID deny contract was retained"
                        ))
                }
            } else {
                $aclGrantsRemoved = $false
                Add-CleanupFailure `
                    $cleanupErrors `
                    "destructive child-state cleanup" `
                    ([System.Exception]::new(
                        "skipped because standard-user process quiescence was not proven; SID ACLs and account were retained"
                    ))
            }
        }
        $canDestroyChildState = (-not $user) -or $processesQuiescent
        if ($canDestroyChildState) {
            try {
                if (Test-Path -LiteralPath $sandbox) {
                    Remove-Item -LiteralPath $sandbox -Recurse -Force -ErrorAction Stop
                }
                $sandboxRemoved = -not (Test-Path -LiteralPath $sandbox)
                if (-not $sandboxRemoved) {
                    Fail "sandbox still exists after recursive removal"
                }
            } catch {
                Add-CleanupFailure $cleanupErrors "standard-user sandbox removal" $_
            }
            try {
                if (Test-Path -LiteralPath $toolExecutionRoot) {
                    Remove-Item `
                        -LiteralPath $toolExecutionRoot `
                        -Recurse `
                        -Force `
                        -ErrorAction Stop
                }
                $toolExecutionRootRemoved = -not (Test-Path -LiteralPath $toolExecutionRoot)
                if (-not $toolExecutionRootRemoved) {
                    Fail "staged tool execution root still exists after recursive removal"
                }
            } catch {
                Add-CleanupFailure $cleanupErrors "staged tool execution root removal" $_
            }
        }
        try {
            if (
                (Get-FileSha256 $consumerEntrypoint "post-cleanup consumer entrypoint") -cne
                    $consumerEntrypointSha256 -or
                (Get-RepositoryControlReadSetSha256 $repository) -cne
                    $consumerControlReadSetSha256
            ) {
                Fail "repository consumer control bytes changed after standard-user cleanup"
            }
            Assert-CleanTrackedCandidateTree `
                $repository `
                "after standard-user cleanup"
            $postCleanupTrackedSourceIntegrityVerified = $true
        } catch {
            Add-CleanupFailure $cleanupErrors "post-cleanup tracked source integrity proof" $_
        }
        $failure = Merge-CleanupFailures $failure $cleanupErrors
    }

    if (-not $SelfTest) {
        $receiptState = if ($failure) { "failed" } else { "passed" }
        $receiptError = if ($failure) { $failure.Message } else { $null }
        Write-LauncherReceipt `
            $resolvedOutputRoot `
            $receiptState `
            $CandidateSha `
            $Target `
            $startedAtText `
            $childDeadlineText `
            $proof `
            $receiptError `
            $processCleanup `
            $accountRemoved `
            $aclGrantCount `
            $aclGrantsRemoved `
            $sandboxRemoved `
            $toolStagingEvidence `
            $toolExecutionRootRemoved `
            $postCleanupTrackedSourceIntegrityVerified
    }
    if ($failure) {
        throw $failure
    }
    if ($SelfTest) {
        if (
            -not $processCleanup.verified -or
            -not $accountRemoved -or
            -not $aclGrantsRemoved -or
            -not $sandboxRemoved -or
            -not $toolExecutionRootRemoved -or
            -not $postCleanupTrackedSourceIntegrityVerified
        ) {
            Fail "self-test cleanup proof was incomplete"
        }
        Write-Output "OLIPHAUNT_WINDOWS_STANDARD_USER_SELF_TEST_OK"
    }
}

try {
    if ($JsonContractSelfTest) {
        if (
            $SelfTest -or
            $RepositoryRoot -or
            $OutputRoot -or
            $BunPath -or
            $BunEnvelope -or
            $DenoEnvelope -or
            $NpmEnvelope -or
            $NodeEnvelope -or
            $PnpmEnvelope -or
            $CandidateSha -or
            $Target -or
            $ChildManifest
        ) {
            Fail "-JsonContractSelfTest cannot be combined with launcher inputs"
        }
        Invoke-JsonContractSelfTest
        return
    } elseif (-not $IsWindows) {
        Fail "this launcher is Windows-only"
    }
    if ($ChildManifest) {
        Invoke-ChildMode $ChildManifest
    } else {
        Invoke-ParentMode
    }
} catch {
    Write-Error $_
    exit 1
}
