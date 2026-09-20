param(
  [Parameter(Mandatory = $true)][string]$FoundationStackName,
  [Parameter(Mandatory = $true)][string]$DeploymentManifestPath,
  [Parameter(Mandatory = $true)][string]$SyntheticManifestPath,
  [Parameter(Mandatory = $true)][string]$Jurisdiction,
  [string]$Locale = "en",
  [string]$EncounterId,
  [string]$AudioFile,
  [string]$Region = "us-east-2",
  [switch]$ConfirmSyntheticOnly
)
# Hosted acceptance of encounter recording, transcription and review-only drafting against the synthetic account only,
# with fictional audio (a generated tone, or -AudioFile: a fictional recording made for this purpose, never a real encounter).
# Tokens come from this process's environment (set by run-aws-synthetic-live-acceptance.ps1's token step or an equivalent);
# nothing is printed or written except the machine-readable report under dist/qualification.
# Without -EncounterId the acceptance encounter is started (or reused) for the synthetic fixture patient through the
# administrative database path first.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
if (-not $ConfirmSyntheticOnly) { throw "Refusing operation: explicitly confirm the synthetic-only boundary." }
if (-not (Get-Command aws -ErrorAction SilentlyContinue)) { throw "AWS CLI is required. No acceptance request was attempted." }
if (-not $env:CLINICAL_WORKFORCE_ID_TOKEN -or -not $env:CLINICAL_CONSUMER_ID_TOKEN) { throw "Fresh workforce and consumer Cognito ID tokens must be set in this PowerShell process only." }
$deployment = Get-Content -Raw -LiteralPath $DeploymentManifestPath | ConvertFrom-Json
$account = aws sts get-caller-identity --query Account --output text
if ($LASTEXITCODE -ne 0) { throw "AWS identity lookup failed." }
if ($account -ne $deployment.aws_account_id -or $account -eq "173535830222") { throw "AWS account does not match the reviewed synthetic manifest, or is the production account." }
if ($Region -ne $deployment.aws_region) { throw "AWS region does not match the reviewed manifest." }
$outputs = aws cloudformation describe-stacks --stack-name $FoundationStackName --region $Region --query "Stacks[0].Outputs" --output json | ConvertFrom-Json
function Output([string]$key) { $entry = $outputs | Where-Object OutputKey -eq $key; if (-not $entry) { throw "Foundation output $key is missing." }; return $entry.OutputValue }
if ((Output 'PhiAllowed') -ne 'false' -or (Output 'DataClassification') -ne 'synthetic_only' -or (Output 'Environment') -ne 'synthetic-staging') { throw "Foundation stack is not the reviewed synthetic-only boundary." }
if ($AudioFile -and -not (Test-Path -LiteralPath $AudioFile)) { throw "AudioFile does not exist." }
npm run build:aws-production-clinical-core
if ($LASTEXITCODE -ne 0) { throw "Production migration artifact build failed." }
npm run build:aws-deployment-tools
if ($LASTEXITCODE -ne 0) { throw "Deployment tools build failed." }
try {
  $env:EXPECTED_AWS_ACCOUNT_ID = $deployment.aws_account_id
  $env:OBSERVED_AWS_ACCOUNT_ID = $account
  $env:AWS_REGION = $Region
  if (-not $EncounterId) {
    $env:CLINICAL_SYNTHETIC_MANIFEST = $SyntheticManifestPath
    $env:CLINICAL_DATABASE_CLUSTER_ARN = Output 'DatabaseClusterArn'
    $env:CLINICAL_DATABASE_SECRET_ARN = Output 'DatabaseSecretArn'
    $env:CLINICAL_DATABASE_NAME = Output 'DatabaseName'
    $fixture = node dist/aws-clinical-core/deployment-tools/recordingAcceptance.js fixture | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or -not $fixture.ok) { throw "Acceptance encounter fixture failed." }
    $EncounterId = $fixture.encounterId
    Write-Host "Acceptance encounter $EncounterId (reused: $($fixture.reused))."
  }
  $env:CLINICAL_API_ORIGIN = Output 'ApiOrigin'
  $env:CLINICAL_RECORDING_ENCOUNTER_ID = $EncounterId
  $env:CLINICAL_RECORDING_JURISDICTION = $Jurisdiction
  $env:CLINICAL_RECORDING_LOCALE = $Locale
  if ($AudioFile) { $env:CLINICAL_RECORDING_AUDIO_FILE = $AudioFile }
  $env:SOURCE_COMMIT = (git rev-parse HEAD).Trim()
  node dist/aws-clinical-core/deployment-tools/recordingAcceptance.js run
  if ($LASTEXITCODE -ne 0) { throw "Recording acceptance did not pass; read the report under dist/qualification." }
} finally {
  foreach ($name in 'CLINICAL_API_ORIGIN','EXPECTED_AWS_ACCOUNT_ID','OBSERVED_AWS_ACCOUNT_ID','AWS_REGION','SOURCE_COMMIT','CLINICAL_SYNTHETIC_MANIFEST','CLINICAL_DATABASE_CLUSTER_ARN','CLINICAL_DATABASE_SECRET_ARN','CLINICAL_DATABASE_NAME','CLINICAL_RECORDING_ENCOUNTER_ID','CLINICAL_RECORDING_JURISDICTION','CLINICAL_RECORDING_LOCALE','CLINICAL_RECORDING_AUDIO_FILE','CLINICAL_WORKFORCE_ID_TOKEN','CLINICAL_CONSUMER_ID_TOKEN') { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
}
Write-Host "Recording acceptance completed; tokens were not printed or written. The stored fictional audio stays until its retention deadline (see the report's retained list)."
