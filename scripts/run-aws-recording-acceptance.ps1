param(
  [Parameter(Mandatory = $true)][string]$QualificationTargetPath,
  [Parameter(Mandatory = $true)][string]$DeploymentManifestPath,
  [Parameter(Mandatory = $true)][string]$SyntheticManifestPath,
  [Parameter(Mandatory = $true)][string]$Jurisdiction,
  [ValidateSet('acceptance', 'exploratory')][string]$Mode = 'acceptance',
  [string]$Locale = "en",
  [string]$EncounterId,
  [string]$AudioFile,
  [string]$Region = "us-east-2",
  [switch]$ConfirmSyntheticOnly
)
# Hosted acceptance of encounter recording, transcription and review-only drafting against the reviewed qualification
# target only (docs/aws-qualification-target.md), with fictional audio (a generated tone, or -AudioFile: a fictional
# recording made for this purpose, never a real encounter). No foundation stack is consulted: the API origin, account,
# database, source commit and migration ledger come from the target manifest, the recording qualification stacks are
# verified against it first, and the Node CLI binds to the same manifest itself (its fixture command re-checks the
# database name and the migration ledger before writing the encounter, so the staging database cannot receive it).
# Tokens come from this process's environment; nothing is printed or written except the machine-readable report under
# dist/qualification. Without -EncounterId the acceptance encounter is started (or reused) for the synthetic fixture
# patient through the administrative database path first.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
. (Join-Path $PSScriptRoot 'qualification-target-verify.ps1')
if (-not $ConfirmSyntheticOnly) { throw "Refusing operation: explicitly confirm the synthetic-only boundary." }
$target = Read-QualificationTarget -Path $QualificationTargetPath -Region $Region
$deployment = Assert-QualificationDeploymentManifest -Target $target -DeploymentManifestPath $DeploymentManifestPath -Region $Region
if (-not (Get-Command aws -ErrorAction SilentlyContinue)) { throw "AWS CLI is required. No acceptance request was attempted." }
if (-not $env:CLINICAL_WORKFORCE_ID_TOKEN -or -not $env:CLINICAL_CONSUMER_ID_TOKEN) { throw "Fresh workforce and consumer Cognito ID tokens must be set in this PowerShell process only." }
if ($AudioFile -and -not (Test-Path -LiteralPath $AudioFile)) { throw "AudioFile does not exist." }
$sourceCommit = Assert-QualificationSourceCommit -Target $target
$account = Assert-QualificationAccount -Target $target
Assert-QualificationFoundation -Target $target -Region $Region
Assert-QualificationStacks -Target $target -Candidates @('recording-authority', 'recording-capture', 'recording-transcription', 'recording-drafting', 'recording-cleanup-review') -Region $Region
npm run build:aws-production-clinical-core
if ($LASTEXITCODE -ne 0) { throw "Production migration artifact build failed." }
npm run build:aws-deployment-tools
if ($LASTEXITCODE -ne 0) { throw "Deployment tools build failed." }
try {
  $env:CLINICAL_QUALIFICATION_TARGET = (Resolve-Path -LiteralPath $QualificationTargetPath).Path
  $env:OBSERVED_AWS_ACCOUNT_ID = $account
  $env:SOURCE_COMMIT = $sourceCommit
  $env:ACCEPTANCE_MODE = $Mode
  if (-not $EncounterId) {
    $env:CLINICAL_SYNTHETIC_MANIFEST = $SyntheticManifestPath
    $fixture = node dist/aws-clinical-core/deployment-tools/recordingAcceptance.js fixture | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or -not $fixture.ok) { throw "Acceptance encounter fixture refused or failed." }
    $EncounterId = $fixture.encounterId
    Write-Host "Acceptance encounter $EncounterId in $($fixture.database) (reused: $($fixture.reused))."
  }
  $env:CLINICAL_RECORDING_ENCOUNTER_ID = $EncounterId
  $env:CLINICAL_RECORDING_JURISDICTION = $Jurisdiction
  $env:CLINICAL_RECORDING_LOCALE = $Locale
  if ($AudioFile) { $env:CLINICAL_RECORDING_AUDIO_FILE = $AudioFile }
  node dist/aws-clinical-core/deployment-tools/recordingAcceptance.js run
  if ($LASTEXITCODE -ne 0) { throw "Recording acceptance did not pass; read the report under dist/qualification." }
} finally {
  foreach ($name in 'CLINICAL_QUALIFICATION_TARGET','OBSERVED_AWS_ACCOUNT_ID','SOURCE_COMMIT','ACCEPTANCE_MODE','CLINICAL_SYNTHETIC_MANIFEST','CLINICAL_RECORDING_ENCOUNTER_ID','CLINICAL_RECORDING_JURISDICTION','CLINICAL_RECORDING_LOCALE','CLINICAL_RECORDING_AUDIO_FILE','CLINICAL_WORKFORCE_ID_TOKEN','CLINICAL_CONSUMER_ID_TOKEN') { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
}
Write-Host "Recording acceptance completed ($Mode) against $($target.apiOrigin); tokens were not printed or written. The stored fictional audio stays until its retention deadline (see the report's retained list)."
