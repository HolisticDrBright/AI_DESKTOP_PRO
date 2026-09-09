param([switch]$ConfirmSyntheticOnly)
$ErrorActionPreference = 'Stop'
if (-not $ConfirmSyntheticOnly) { throw 'Synthetic-only confirmation required.' }
$taskRoot = Split-Path -Parent $PSScriptRoot
Set-Location $taskRoot
$profileName = 'ai-synthetic-member'
$regionName = 'us-east-2'
$stackName = 'ai-clinical-core-synthetic-staging-lab-analysis'
$account = aws sts get-caller-identity --profile $profileName --query Account --output text
if ($LASTEXITCODE -ne 0 -or $account -ne '588966314750') { throw 'Unexpected AWS account.' }
$stack = (aws cloudformation describe-stacks --stack-name $stackName --profile $profileName --region $regionName --output json | ConvertFrom-Json).Stacks[0]
if ($LASTEXITCODE -ne 0 -or $stack.StackStatus -notin @('UPDATE_COMPLETE', 'CREATE_COMPLETE')) { throw 'Stack is not ready for an update.' }
if (($stack.Outputs | Where-Object OutputKey -eq PhiAllowed).OutputValue -ne 'false' -or ($stack.Outputs | Where-Object OutputKey -eq DataClassification).OutputValue -ne 'synthetic_only') { throw 'Stack is not synthetic-only.' }
function ExistingParameter([string]$name) {
  $value = ($stack.Parameters | Where-Object ParameterKey -eq $name).ParameterValue
  if (-not $value) { throw "Missing parameter: $name" }
  return $value
}
if ((ExistingParameter ClinicalApiId) -ne 'wxv734oi12') { throw 'Unexpected synthetic API.' }
$artifactBucket = ExistingParameter LambdaCodeBucket
$kmsArn = ExistingParameter ClinicalCoreKeyArn
npm run typecheck
if ($LASTEXITCODE -ne 0) { throw 'Typecheck failed.' }
npm run build:aws-lab-analysis
if ($LASTEXITCODE -ne 0) { throw 'Lab bundle build failed.' }
$releaseId = [guid]::NewGuid().ToString('N')
$apiZip = Join-Path $taskRoot "dist/aws-clinical-core/lab-api-$releaseId.zip"
$workerZip = Join-Path $taskRoot "dist/aws-clinical-core/lab-worker-$releaseId.zip"
Compress-Archive -LiteralPath (Join-Path $taskRoot 'dist/aws-clinical-core/lab-analysis/api/index.js') -DestinationPath $apiZip
Compress-Archive -LiteralPath (Join-Path $taskRoot 'dist/aws-clinical-core/lab-analysis/worker/index.js') -DestinationPath $workerZip
$apiKey = 'clinical-core/lab-analysis/api-' + (Get-FileHash -LiteralPath $apiZip -Algorithm SHA256).Hash.ToLowerInvariant() + '.zip'
$workerKey = 'clinical-core/lab-analysis/worker-' + (Get-FileHash -LiteralPath $workerZip -Algorithm SHA256).Hash.ToLowerInvariant() + '.zip'
aws s3 cp $apiZip "s3://$artifactBucket/$apiKey" --profile $profileName --region $regionName --only-show-errors --sse aws:kms --sse-kms-key-id $kmsArn
if ($LASTEXITCODE -ne 0) { throw 'API upload failed.' }
aws s3 cp $workerZip "s3://$artifactBucket/$workerKey" --profile $profileName --region $regionName --only-show-errors --sse aws:kms --sse-kms-key-id $kmsArn
if ($LASTEXITCODE -ne 0) { throw 'Worker upload failed.' }
# Existing stack parameters are retained. No identity/provider configuration is reset.
aws cloudformation deploy --stack-name $stackName --template-file 'infra/aws-clinical-core/lab-analysis-extension.json' --profile $profileName --region $regionName --capabilities CAPABILITY_IAM --no-execute-changeset --parameter-overrides "ApiCodeKey=$apiKey" "WorkerCodeKey=$workerKey"
if ($LASTEXITCODE -ne 0) { throw 'Change-set preparation failed.' }
$sets = aws cloudformation list-change-sets --stack-name $stackName --profile $profileName --region $regionName --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Change-set lookup failed.' }
$set = $sets.Summaries | Sort-Object CreationTime -Descending | Select-Object -First 1
$change = aws cloudformation describe-change-set --change-set-name $set.ChangeSetId --profile $profileName --region $regionName --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $change.Status -ne 'CREATE_COMPLETE') { throw 'Change set is not executable.' }
if (($change.Parameters | Where-Object ParameterKey -eq ApiCodeKey).ParameterValue -ne $apiKey -or ($change.Parameters | Where-Object ParameterKey -eq WorkerCodeKey).ParameterValue -ne $workerKey) { throw 'Change set does not match this release.' }
foreach ($previous in $stack.Parameters) {
  if ($previous.ParameterKey -in @('ApiCodeKey', 'WorkerCodeKey')) { continue }
  $next = $change.Parameters | Where-Object ParameterKey -eq $previous.ParameterKey
  if ($next.ParameterValue -ne $previous.ParameterValue) { throw "Existing configuration changed: $($previous.ParameterKey)" }
}
$allowedResources = @('LabApiFunction', 'LabWorkerFunction', 'LabWorkerRole', 'LabSyntheticAuthorizerFunction')
foreach ($item in $change.Changes) {
  $resource = $item.ResourceChange
  if ($resource.Action -ne 'Modify' -or $resource.Replacement -ne 'False' -or $resource.LogicalResourceId -notin $allowedResources) { throw "Unexpected resource change: $($resource.LogicalResourceId). Inspect before executing." }
}
aws cloudformation execute-change-set --change-set-name $set.ChangeSetId --profile $profileName --region $regionName
if ($LASTEXITCODE -ne 0) { throw 'Change-set execution failed.' }
[pscustomobject]@{ Stack = $stackName; ChangeSet = $set.ChangeSetId; ApiCodeKey = $apiKey; WorkerCodeKey = $workerKey; State = 'UPDATE_REQUESTED'; PhiAllowed = $false } | Format-List
# Deliberately non-blocking: verify UPDATE_COMPLETE and deployed digests before hosted tests.
