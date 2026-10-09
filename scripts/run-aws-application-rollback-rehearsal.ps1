param(
  [Parameter(Mandatory = $true)][string]$StackName,
  [Parameter(Mandatory = $true)][string]$ArtifactBucket,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9!_.*''()/\-]{1,1024}$')][string]$PreviousLambdaCodeKey,
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-f0-9]{64}$')][string]$PreviousArtifactSha256,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$PreviousSourceVersion,
  [string]$FoundationStackName = "ai-longevity-production-clinical-foundation",
  [string]$AwsProfile = "ai-production",
  [string]$Region = "us-east-2",
  [string]$OutputPath = "",
  [switch]$ConfirmApplicationRollbackRehearsal,
  [switch]$ExecuteChangeSet
)

# Application rollback rehearsal for one Lambda extension stack.
# Rolls the stack's LambdaCodeKey back to a previously deployed, hash-verified
# artifact while every other parameter keeps its previous value. Without
# -ExecuteChangeSet the change set is created and described only. The stack
# must remain PHI-disabled; the rehearsal records timings as recovery evidence.

$ErrorActionPreference = "Stop"
$expectedAccount = "173535830222"
$rollbackStartedAt = [DateTimeOffset]::UtcNow

if (-not $ConfirmApplicationRollbackRehearsal) {
  throw "Refusing operation: explicitly confirm the application rollback rehearsal."
}
if (-not (Get-Command aws -ErrorAction SilentlyContinue)) {
  throw "AWS CLI is required. No cloud operation was attempted."
}
$account = aws sts get-caller-identity --profile $AwsProfile --query Account --output text
if ($LASTEXITCODE -ne 0 -or $account -ne $expectedAccount) { throw "Application rollback rehearsal requires account $expectedAccount." }
$env:AWS_PROFILE = $AwsProfile
$env:AWS_REGION = $Region

$foundation = aws cloudformation describe-stacks --stack-name $FoundationStackName --query "Stacks[0].Outputs" --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "Production foundation lookup failed." }
$phi = ($foundation | Where-Object OutputKey -eq "PhiAllowed").OutputValue
if ($phi -ne "false") { throw "Refusing rehearsal: PhiAllowed must be false." }

# 1. The previous artifact must exist and hash to the recorded value.
$artifactPath = Join-Path $env:TEMP ("rollback-artifact-" + [guid]::NewGuid().ToString("N") + ".zip")
try {
  aws s3api head-object --bucket $ArtifactBucket --key $PreviousLambdaCodeKey --output json | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Previous artifact $PreviousLambdaCodeKey is not present in $ArtifactBucket." }
  aws s3api get-object --bucket $ArtifactBucket --key $PreviousLambdaCodeKey $artifactPath | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Previous artifact download failed." }
  $actualSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $artifactPath).Hash.ToLowerInvariant()
  if ($actualSha -ne $PreviousArtifactSha256) { throw "Previous artifact hash mismatch; refusing to roll back to unverified code." }
} finally {
  Remove-Item -LiteralPath $artifactPath -Force -ErrorAction SilentlyContinue
}

# 2. Record the current key so the rehearsal can be re-forwarded exactly.
$current = aws cloudformation describe-stacks --stack-name $StackName --query "Stacks[0].Parameters" --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "Stack lookup failed." }
$ReForwardLambdaCodeKey = ($current | Where-Object ParameterKey -eq "LambdaCodeKey").ParameterValue
if (-not $ReForwardLambdaCodeKey) { throw "Stack does not expose LambdaCodeKey." }
$parameters = @()
foreach ($entry in $current) {
  if ($entry.ParameterKey -eq "LambdaCodeKey") { $parameters += @{ ParameterKey = "LambdaCodeKey"; ParameterValue = $PreviousLambdaCodeKey } }
  else { $parameters += @{ ParameterKey = $entry.ParameterKey; UsePreviousValue = $true } }
}
$parameterPath = Join-Path $env:TEMP ("rollback-parameters-" + [guid]::NewGuid().ToString("N") + ".json")
$changeSetName = "rollback-rehearsal-" + $rollbackStartedAt.ToUnixTimeSeconds()
try {
  $parameters | ConvertTo-Json -Compress -Depth 4 | ForEach-Object { [IO.File]::WriteAllText($parameterPath, $_, (New-Object Text.UTF8Encoding($false))) }
  aws cloudformation create-change-set --stack-name $StackName --change-set-name $changeSetName --use-previous-template `
    --parameters ("file://" + $parameterPath.Replace("\", "/")) --capabilities CAPABILITY_IAM --output json | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Change set creation failed." }
  aws cloudformation wait change-set-create-complete --stack-name $StackName --change-set-name $changeSetName
  $changes = aws cloudformation describe-change-set --stack-name $StackName --change-set-name $changeSetName --output json | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw "Change set description failed." }
  $touched = @($changes.Changes | ForEach-Object { $_.ResourceChange.LogicalResourceId })
  if ($touched | Where-Object { $_ -notmatch "Function$" }) { throw "Refusing: rollback change set touches resources other than Lambda functions: $($touched -join ', ')" }
} finally {
  Remove-Item -LiteralPath $parameterPath -Force -ErrorAction SilentlyContinue
}

$executed = $false
$functionShas = @()
if ($ExecuteChangeSet) {
  aws cloudformation execute-change-set --stack-name $StackName --change-set-name $changeSetName | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Change set execution failed." }
  aws cloudformation wait stack-update-complete --stack-name $StackName
  if ($LASTEXITCODE -ne 0) { throw "Stack update did not complete; investigate before re-forwarding." }
  $executed = $true
  $functions = aws cloudformation list-stack-resources --stack-name $StackName --query "StackResourceSummaries[?ResourceType=='AWS::Lambda::Function'].PhysicalResourceId" --output json | ConvertFrom-Json
  foreach ($function in $functions) {
    $configuration = aws lambda get-function-configuration --function-name $function --output json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw "Function configuration lookup failed for $function." }
    $functionShas += @{ function = $function; CodeSha256 = $configuration.CodeSha256 }
  }
} else {
  aws cloudformation delete-change-set --stack-name $StackName --change-set-name $changeSetName | Out-Null
}

$rollbackCompletedAt = [DateTimeOffset]::UtcNow
$evidence = [ordered]@{
  schemaVersion = "application-rollback-rehearsal/1"
  account = $account
  region = $Region
  stackName = $StackName
  phiAllowed = $false
  previousLambdaCodeKey = $PreviousLambdaCodeKey
  previousArtifactSha256 = $PreviousArtifactSha256
  previousSourceVersion = $PreviousSourceVersion
  reForwardLambdaCodeKey = $ReForwardLambdaCodeKey
  changeSetName = $changeSetName
  changedResources = $touched
  executed = $executed
  functionCodeSha256 = $functionShas
  rollbackStartedAt = $rollbackStartedAt.ToString("o")
  rollbackCompletedAt = $rollbackCompletedAt.ToString("o")
  recoveryTimeSeconds = [math]::Round(($rollbackCompletedAt - $rollbackStartedAt).TotalSeconds, 1)
}
$payload = $evidence | ConvertTo-Json -Depth 6
$evidenceSha256 = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($payload))).Replace("-", "").ToLowerInvariant()
$evidence["evidenceSha256"] = $evidenceSha256
$final = $evidence | ConvertTo-Json -Depth 6
if ($OutputPath) { [IO.File]::WriteAllText($OutputPath, $final, (New-Object Text.UTF8Encoding($false))) }
Write-Output $final
if ($executed) { Write-Output "Rollback executed. Re-forward with LambdaCodeKey=$ReForwardLambdaCodeKey after review." }
else { Write-Output "Change set reviewed and deleted; nothing was changed. Re-run with -ExecuteChangeSet to rehearse the rollback." }
