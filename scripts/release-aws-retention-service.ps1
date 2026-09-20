param(
  [Parameter(Mandatory = $true)][ValidateSet('inspect','release','revoke')][string]$Command,
  [Parameter(Mandatory = $true)][string]$FoundationStackName,
  [Parameter(Mandatory = $true)][string]$DeploymentManifestPath,
  [string]$ReleaseVersion,
  [string]$ServicePersonId,
  [string]$ServiceSubject,
  [string]$ApprovedByPersonId,
  [string]$PolicyEvidenceSha256,
  [string]$Region = "us-east-2",
  [switch]$ConfirmRetentionOperatingPolicyApproved
)
# Manages the retention service release row that lets the scheduled export retention sweep act.
# `inspect` is read-only. `release` and `revoke` require the reviewed operating-policy approval to be confirmed here and,
# for `release`, the same evidence hash that the privacy-operations stack carries as RetentionScheduleEvidenceSha256.
# The AWS account is pinned with STS against the reviewed deployment manifest; the production account is refused unless the
# manifest itself names it, and PHI posture is read from the foundation stack rather than assumed. No secret is printed.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
if (-not (Get-Command aws -ErrorAction SilentlyContinue)) { throw "AWS CLI is required. Nothing was attempted." }
if ($Command -ne 'inspect' -and -not $ConfirmRetentionOperatingPolicyApproved) { throw "Refusing $Command: confirm that the retention operating policy was approved and name its reviewed evidence." }
if ($Command -eq 'release' -and (-not $ReleaseVersion -or -not $ServicePersonId -or -not $ServiceSubject -or -not $ApprovedByPersonId -or -not $PolicyEvidenceSha256)) { throw "release needs -ReleaseVersion, -ServicePersonId, -ServiceSubject, -ApprovedByPersonId and -PolicyEvidenceSha256." }
if ($Command -eq 'revoke' -and -not $ReleaseVersion) { throw "revoke needs -ReleaseVersion." }
$deployment = Get-Content -Raw -LiteralPath $DeploymentManifestPath | ConvertFrom-Json
$account = aws sts get-caller-identity --query Account --output text
if ($LASTEXITCODE -ne 0) { throw "AWS identity lookup failed." }
if ($account -ne $deployment.aws_account_id) { throw "AWS account does not match the reviewed deployment manifest." }
if ($Region -ne $deployment.aws_region) { throw "AWS region does not match the reviewed manifest." }
$outputs = aws cloudformation describe-stacks --stack-name $FoundationStackName --region $Region --query "Stacks[0].Outputs" --output json | ConvertFrom-Json
function Output([string]$key) { $entry = $outputs | Where-Object OutputKey -eq $key; if (-not $entry) { throw "Foundation output $key is missing." }; return $entry.OutputValue }
$phiAllowed = Output 'PhiAllowed'
if ($phiAllowed -notin @('true','false')) { throw "Foundation stack does not state the PHI posture." }
if ($Command -eq 'release' -and $PolicyEvidenceSha256 -ne $deployment.retention_schedule_evidence_sha256) { throw "PolicyEvidenceSha256 does not match retention_schedule_evidence_sha256 in the reviewed deployment manifest." }
npm run build:aws-retention-service-release-operator
if ($LASTEXITCODE -ne 0) { throw "Operator build failed." }
try {
  $env:PHI_ALLOWED = $phiAllowed
  $env:EXPECTED_AWS_ACCOUNT_ID = $deployment.aws_account_id
  $env:AWS_REGION = $Region
  $env:CLINICAL_DATABASE_CLUSTER_ARN = Output 'DatabaseClusterArn'
  $env:CLINICAL_DATABASE_SECRET_ARN = Output 'DatabaseSecretArn'
  $env:CLINICAL_DATABASE_NAME = Output 'DatabaseName'
  if ($Command -ne 'inspect') { $env:CONFIRM_RETENTION_OPERATING_POLICY_APPROVED = 'true'; $env:RETENTION_RELEASE_VERSION = $ReleaseVersion }
  if ($Command -eq 'release') {
    $env:RETENTION_SERVICE_PERSON_ID = $ServicePersonId
    $env:RETENTION_SERVICE_SUBJECT = $ServiceSubject
    $env:RETENTION_APPROVED_BY_PERSON_ID = $ApprovedByPersonId
    $env:RETENTION_POLICY_EVIDENCE_SHA256 = $PolicyEvidenceSha256
  }
  node dist/aws-clinical-core/retention-service-release-operator/index.cjs $Command
  if ($LASTEXITCODE -ne 0) { throw "Retention service release operator refused or failed; the printed category says why." }
} finally {
  foreach ($name in 'PHI_ALLOWED','EXPECTED_AWS_ACCOUNT_ID','CLINICAL_DATABASE_CLUSTER_ARN','CLINICAL_DATABASE_SECRET_ARN','CLINICAL_DATABASE_NAME','CONFIRM_RETENTION_OPERATING_POLICY_APPROVED','RETENTION_RELEASE_VERSION','RETENTION_SERVICE_PERSON_ID','RETENTION_SERVICE_SUBJECT','RETENTION_APPROVED_BY_PERSON_ID','RETENTION_POLICY_EVIDENCE_SHA256') { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
}
Write-Host "Retention service release operator finished ($Command). Record the printed JSON with the deployment evidence."
