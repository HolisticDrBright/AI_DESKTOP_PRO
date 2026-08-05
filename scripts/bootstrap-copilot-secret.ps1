<#
.SYNOPSIS
  Phase 10B.2 — write the OpenAI staging key into AWS Secrets Manager.

.DESCRIPTION
  Reads the key INTERACTIVELY into a SecureString and hands it to AWS
  in-process. The key is never a command-line argument, never an
  environment variable, never written to disk, never echoed, and never
  placed in PowerShell history.

  WHY NOT A PARAMETER. A -ApiKey parameter would put the key in the
  process command line, where it is visible to every other process on the
  host via Get-CimInstance Win32_Process, and in PSReadLine history on
  disk. There is no safe way to accept it that way, so it is not accepted
  that way.

  WHY NOT `aws secretsmanager put-secret-value --secret-string`. Same
  problem: the value lands in argv. The `file://` alternative writes
  plaintext to disk. This script uses the AWS.Tools.SecretsManager module
  so the value is passed in-process only.

.PARAMETER SecretId
  The secret's ARN or name. Not a secret.

.PARAMETER Region
  AWS region. Not a secret.

.PARAMETER Check
  Verify only. Reads the secret to confirm it is present and plausibly
  shaped, prints a category, and writes nothing.

.EXAMPLE
  # Verify what is there now
  ./scripts/bootstrap-copilot-secret.ps1 -SecretId clinical/copilot/openai-staging -Region us-east-1 -Check

.EXAMPLE
  # Write or rotate the value. Prompts; nothing is echoed.
  ./scripts/bootstrap-copilot-secret.ps1 -SecretId clinical/copilot/openai-staging -Region us-east-1
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$SecretId,
  [Parameter(Mandatory = $true)][string]$Region,
  [switch]$Check,
  [string]$OpenAiOrganization,
  [string]$OpenAiProject
)

$ErrorActionPreference = 'Stop'

function Write-Status([string]$Name, [string]$Status, [string]$Detail = '') {
  "{0,-28} {1,-14} {2}" -f $Name, $Status, $Detail | Write-Host
}

# --- guardrail: refuse to run if a key was somehow passed as an argument ---
foreach ($k in $PSBoundParameters.Keys) {
  $v = [string]$PSBoundParameters[$k]
  if ($v -match '^(sk-|Bearer\s)') {
    throw "A key-shaped value was passed as -$k. This script never accepts a key as an argument. Aborting without printing it."
  }
}
if ($SecretId -match '^(sk-|Bearer\s)') {
  throw "SecretId looks like a key, not an identifier. Aborting."
}
if ($Region -notmatch '^[a-z]{2}(-gov)?-[a-z]+-\d$') {
  throw "Region '$Region' is not an AWS region identifier."
}

# --- module ---
if (-not (Get-Module -ListAvailable -Name AWS.Tools.SecretsManager)) {
  Write-Host ""
  Write-Host "AWS.Tools.SecretsManager is not installed. It is required because it is the"
  Write-Host "only supported path that passes the secret in-process rather than through"
  Write-Host "argv or a temp file."
  Write-Host ""
  Write-Host "  Install-Module AWS.Tools.SecretsManager -Scope CurrentUser"
  Write-Host ""
  throw "missing module AWS.Tools.SecretsManager"
}
Import-Module AWS.Tools.SecretsManager -ErrorAction Stop

Write-Host ""
Write-Host "Phase 10B.2 — copilot staging secret" -ForegroundColor Cyan
Write-Host "(no secret value is printed by this script, in any mode)"
Write-Host ""

# --------------------------------------------------------------- check mode
if ($Check) {
  try {
    $resp = Get-SECSecretValue -SecretId $SecretId -Region $Region -ErrorAction Stop
    $len = 0
    if ($null -ne $resp.SecretString) { $len = $resp.SecretString.Length }
    # The value is inspected for LENGTH and SHAPE only, and neither the
    # value nor any substring of it is printed.
    if ($len -eq 0) {
      Write-Status 'secret.value' 'missing' 'the secret exists but has no string value'
      exit 1
    }
    $looksJson = $resp.SecretString.TrimStart().StartsWith('{')
    if ($len -lt 20) {
      Write-Status 'secret.value' 'misconfigured' "present but too short to be a bearer ($len chars)"
      exit 1
    }
    Write-Status 'secret.value' 'present' ("shape: {0}, length: {1}" -f $(if ($looksJson) { 'json envelope' } else { 'opaque bearer' }), $len)
    Write-Status 'secret.versionId' 'present' $resp.VersionId
    exit 0
  }
  catch {
    $n = $_.Exception.GetType().Name
    $status = switch -Regex ($n) {
      'ResourceNotFound' { 'missing' }
      'AccessDenied|Unauthoriz|InvalidSignature' { 'denied' }
      'ExpiredToken|TokenRefresh' { 'expired' }
      default { 'misconfigured' }
    }
    # The AWS message is deliberately not printed: it can contain the
    # secret NAME and, for some errors, request context.
    Write-Status 'secret.value' $status "GetSecretValue failed ($n)"
    exit 1
  }
}

# --------------------------------------------------------------- write mode
Write-Host "Paste the OpenAI PROJECT-SCOPED key. Input is hidden and is not echoed," -ForegroundColor Yellow
Write-Host "not logged, and not stored in PowerShell history." -ForegroundColor Yellow
Write-Host ""
$secure = Read-Host -Prompt 'OpenAI project key' -AsSecureString
if ($secure.Length -eq 0) { throw "No value entered. Nothing was written." }

$plain = $null
$bstr = [IntPtr]::Zero
try {
  $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  $plain = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)

  if ($plain.Length -lt 20) { throw "The value is too short to be an API key. Nothing was written." }
  if ($plain -match '\s') { throw "The value contains whitespace. Nothing was written." }
  # A project-scoped key is what this phase requires. Warn, do not block:
  # OpenAI's prefixes change, and blocking on a prefix would age badly.
  if ($plain -notmatch '^sk-') {
    Write-Host "Note: the value does not start with 'sk-'. Continuing — verify it is the project key." -ForegroundColor Yellow
  }

  if ($OpenAiOrganization -or $OpenAiProject) {
    # A JSON envelope. Only these three fields exist; the application's
    # parser refuses any other field rather than ignoring it.
    $payload = [ordered]@{ apiKey = $plain }
    if ($OpenAiOrganization) { $payload['organization'] = $OpenAiOrganization }
    if ($OpenAiProject) { $payload['project'] = $OpenAiProject }
    $body = ($payload | ConvertTo-Json -Compress)
  }
  else {
    $body = $plain
  }

  # In-process. No argv, no temp file, no environment variable.
  $res = Set-SECSecretValue -SecretId $SecretId -SecretString $body -Region $Region -ErrorAction Stop
  Write-Status 'secret.write' 'present' ("new versionId {0}" -f $res.VersionId)
  Write-Host ""
  Write-Host "Written. Next:" -ForegroundColor Green
  Write-Host "  1. Record the secret ARN on the registry row via register_copilot_provider."
  Write-Host "     The ARN, never the value."
  Write-Host "  2. npm run preflight:copilot"
  Write-Host "  3. npm run gate:copilot-synthetic"
}
catch {
  $n = $_.Exception.GetType().Name
  Write-Status 'secret.write' 'denied-or-failed' "($n) — nothing about the value is printed"
  exit 1
}
finally {
  # Scrub every copy we made, in both directions.
  if ($bstr -ne [IntPtr]::Zero) {
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
  if ($null -ne $plain) {
    $plain = $null
  }
  if ($null -ne $body) { $body = $null }
  Remove-Variable plain, body -ErrorAction SilentlyContinue
  [System.GC]::Collect()
  $secure.Dispose()
}
