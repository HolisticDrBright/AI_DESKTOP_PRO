param(
  [Parameter(Mandatory = $true)][string]$QualificationTargetPath,
  [Parameter(Mandatory = $true)][string]$DeploymentManifestPath,
  [string]$InventoryPath,
  [ValidateSet('acceptance', 'exploratory')][string]$Mode = 'acceptance',
  [string]$Region = "us-east-2",
  [switch]$ConfirmSyntheticOnly
)
# Hosted acceptance of the reviewed voice shutdown (drain) transition, against the reviewed qualification target only.
# The owned-voice candidate must already be in the drain posture: PHI false, Activation=draining, qualification execution
# disabled (the policy refuses qualification execution while draining, so a drain deployment serves no one at all).
# -InventoryPath names a JSON array of two read-only inventory reports from
# `node dist/aws-clinical-core/owned-voice/inventory.cjs --read-only <account> <region> <stack>`, taken apart in time
# after old invocations ended, each with an `observedAt` timestamp added. Acceptance mode requires them.
# This run proves refusals and records what remains. It never certifies erasure, and no report it writes claims to.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
. (Join-Path $PSScriptRoot 'qualification-target-verify.ps1')
if (-not $ConfirmSyntheticOnly) { throw "Refusing operation: explicitly confirm the synthetic-only boundary." }
$target = Read-QualificationTarget -Path $QualificationTargetPath -Region $Region
$deployment = Assert-QualificationDeploymentManifest -Target $target -DeploymentManifestPath $DeploymentManifestPath -Region $Region
if (-not (Get-Command aws -ErrorAction SilentlyContinue)) { throw "AWS CLI is required. No acceptance request was attempted." }
if (-not $env:CLINICAL_WORKFORCE_ID_TOKEN -or -not $env:CLINICAL_CONSUMER_ID_TOKEN) { throw "Fresh consumer and workforce Cognito ID tokens must be set in this PowerShell process only." }
if ($Mode -eq 'acceptance' -and -not $InventoryPath) { throw "Acceptance mode needs -InventoryPath: two read-only inventory reports taken apart in time; use -Mode exploratory for a refusal-only run." }
if ($InventoryPath -and -not (Test-Path -LiteralPath $InventoryPath)) { throw "InventoryPath does not exist." }
$sourceCommit = Assert-QualificationSourceCommit -Target $target
$account = Assert-QualificationAccount -Target $target
Assert-QualificationFoundation -Target $target -Region $Region
Assert-QualificationStacks -Target $target -Candidates @('owned-voice') -Region $Region -Posture 'drain'
npm run build:aws-production-clinical-core
if ($LASTEXITCODE -ne 0) { throw "Production migration artifact build failed." }
npm run build:aws-deployment-tools
if ($LASTEXITCODE -ne 0) { throw "Deployment tools build failed." }
try {
  $env:CLINICAL_QUALIFICATION_TARGET = (Resolve-Path -LiteralPath $QualificationTargetPath).Path
  $env:OBSERVED_AWS_ACCOUNT_ID = $account
  $env:SOURCE_COMMIT = $sourceCommit
  $env:ACCEPTANCE_MODE = $Mode
  if ($InventoryPath) { $env:CLINICAL_VOICE_INVENTORIES = (Resolve-Path -LiteralPath $InventoryPath).Path }
  node dist/aws-clinical-core/deployment-tools/voiceShutdownAcceptance.js
  if ($LASTEXITCODE -ne 0) { throw "Voice shutdown acceptance did not pass; read the report under dist/qualification." }
} finally {
  foreach ($name in 'CLINICAL_QUALIFICATION_TARGET','OBSERVED_AWS_ACCOUNT_ID','SOURCE_COMMIT','ACCEPTANCE_MODE','CLINICAL_VOICE_INVENTORIES','CLINICAL_WORKFORCE_ID_TOKEN','CLINICAL_CONSUMER_ID_TOKEN') { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
}
Write-Host "Voice shutdown acceptance completed ($Mode) against $($target.apiOrigin). Refusals and retained inventory are recorded; nothing is certified as erased."
