param(
  [Parameter(Mandatory = $true)][string]$QualificationTargetPath,
  [Parameter(Mandatory = $true)][string]$DeploymentManifestPath,
  [ValidateSet('acceptance', 'exploratory')][string]$Mode = 'acceptance',
  [int]$ScheduledCleanupWaitMinutes = 0,
  [string]$Region = "us-east-2",
  [switch]$ConfirmSyntheticOnly
)
# Hosted acceptance of the personal-storage export job and its retention actions against the reviewed qualification
# target only (docs/aws-qualification-target.md; the target manifest is a filled copy of
# infra/aws-clinical-core/qualification-target.example.json). No foundation stack is consulted: the API origin, account,
# database, export bucket, source commit and migration ledger all come from the manifest, the personal-storage and
# privacy-operations qualification stacks are verified against it first, and the Node CLI binds to the same manifest
# itself. Tokens come from this process's environment (consumer, workforce, a second consumer and a stale consumer token
# for the acceptance matrix); nothing is printed or written except the machine-readable report under dist/qualification.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
. (Join-Path $PSScriptRoot 'qualification-target-verify.ps1')
if (-not $ConfirmSyntheticOnly) { throw "Refusing operation: explicitly confirm the synthetic-only boundary." }
$target = Read-QualificationTarget -Path $QualificationTargetPath -Region $Region
$deployment = Assert-QualificationDeploymentManifest -Target $target -DeploymentManifestPath $DeploymentManifestPath -Region $Region
if (-not (Get-Command aws -ErrorAction SilentlyContinue)) { throw "AWS CLI is required. No acceptance request was attempted." }
if (-not $env:CLINICAL_WORKFORCE_ID_TOKEN -or -not $env:CLINICAL_CONSUMER_ID_TOKEN) { throw "Fresh consumer and workforce Cognito ID tokens must be set in this PowerShell process only." }
if ($Mode -eq 'acceptance' -and (-not $env:CLINICAL_FOREIGN_CONSUMER_ID_TOKEN -or -not $env:CLINICAL_STALE_CONSUMER_ID_TOKEN)) { throw "Acceptance mode needs a second consumer token and a legitimately issued stale consumer token as well; use -Mode exploratory for a partial run." }
$sourceCommit = Assert-QualificationSourceCommit -Target $target
$account = Assert-QualificationAccount -Target $target
Assert-QualificationFoundation -Target $target -Region $Region
Assert-QualificationStacks -Target $target -Candidates @('personal-storage', 'privacy-operations') -Region $Region
npm run build:aws-production-clinical-core
if ($LASTEXITCODE -ne 0) { throw "Production migration artifact build failed." }
npm run build:aws-deployment-tools
if ($LASTEXITCODE -ne 0) { throw "Deployment tools build failed." }
try {
  $env:CLINICAL_QUALIFICATION_TARGET = (Resolve-Path -LiteralPath $QualificationTargetPath).Path
  $env:OBSERVED_AWS_ACCOUNT_ID = $account
  $env:SOURCE_COMMIT = $sourceCommit
  $env:ACCEPTANCE_MODE = $Mode
  # Pass -ScheduledCleanupWaitMinutes only when the retention sweep is released and active: the run then waits for the
  # schedule to record the removal of the copy the owner's own pass left pending, and fails if it never does.
  if ($ScheduledCleanupWaitMinutes -gt 0) {
    if ($ScheduledCleanupWaitMinutes -gt 180) { throw "ScheduledCleanupWaitMinutes must be 180 or fewer." }
    $env:SCHEDULED_CLEANUP_WAIT_MINUTES = "$ScheduledCleanupWaitMinutes"
  }
  node dist/aws-clinical-core/deployment-tools/exportRetentionAcceptance.js
  if ($LASTEXITCODE -ne 0) { throw "Export and retention acceptance did not pass; read the report under dist/qualification." }
} finally {
  foreach ($name in 'CLINICAL_QUALIFICATION_TARGET','OBSERVED_AWS_ACCOUNT_ID','SOURCE_COMMIT','ACCEPTANCE_MODE','SCHEDULED_CLEANUP_WAIT_MINUTES','CLINICAL_WORKFORCE_ID_TOKEN','CLINICAL_CONSUMER_ID_TOKEN','CLINICAL_FOREIGN_CONSUMER_ID_TOKEN','CLINICAL_STALE_CONSUMER_ID_TOKEN') { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
}
Write-Host "Export and retention acceptance completed ($Mode) against $($target.apiOrigin); tokens were not printed or written."
