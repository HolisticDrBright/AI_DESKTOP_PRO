param([ValidateSet('prepare','execute','verify')][string]$Mode='prepare')
$ErrorActionPreference='Stop'
$repoRoot=Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot
$profile='ai-synthetic-staging'; $region='us-east-2'
$stackName='ai-clinical-core-synthetic-staging-authenticated-api'
$changeName='care-message-settlement-b55e774-20260930'
$receiptPath=Join-Path $repoRoot 'dist/settlement-qualification/deployment.json'
function Aws([string[]]$Arguments) {
  $result=& aws.exe @Arguments --profile $profile --region $region --output json
  if($LASTEXITCODE -ne 0){throw 'AWS operation failed; no retry is implicit.'}
  return ($result|ConvertFrom-Json)
}
if((Aws @('sts','get-caller-identity')).Account -ne '588966314750'){throw 'Account refused'}
$current=(git rev-parse HEAD).Trim()
if($current -ne 'b55e7740e2c56fa20fda55ef149f6a7e4f8f0244'){throw 'Source commit changed'}
$foundation=(Aws @('cloudformation','describe-stacks','--stack-name','ai-clinical-core-synthetic-staging')).Stacks[0]
$outputs=@{}; foreach($o in $foundation.Outputs){$outputs[$o.OutputKey]=$o.OutputValue}
if($outputs.PhiAllowed -ne 'false' -or $outputs.DatabaseName -ne 'clinical_core' -or $outputs.ClinicalApiId -ne 'wxv734oi12' -or $outputs.Environment -ne 'synthetic-staging'){throw 'Foundation refused'}
$routes=(Aws @('apigatewayv2','get-routes','--api-id','wxv734oi12')).Items
if(@($routes|Where-Object {$_.RouteKey -match '/programs|\$default|\{proxy\+\}'}).Count -ne 0){throw 'Program or catch-all route present; isolated deployment refused'}
foreach($routeKey in @('POST /clinical-core/consumer/messages','POST /clinical-core/workforce/messages')){
  $found=@($routes|Where-Object {$_.RouteKey -eq $routeKey -and $_.AuthorizationType -eq 'JWT'})
  if($found.Count -ne 1){throw 'Messaging JWT route missing'}
}
if($Mode -eq 'prepare'){
  $verified=Get-Content 'dist/settlement-qualification/verify.json' -Raw|ConvertFrom-Json
  if($verified.verdict -ne 'pass' -or $verified.ledgerAfter -ne 33 -or !$verified.fixtureRollbackVerified -or $verified.sourceCommit -ne $current){throw 'Database verification missing'}
  $configuration=Aws @('lambda','get-function-configuration','--function-name','wxv734oi12-synthetic-identity')
  if($configuration.CodeSha256 -ne 'us3f5CHKenBcPorLtoQZCqi3Z/2mboblP8HRGukLCxM=' -or $configuration.LastUpdateStatus -ne 'Successful'){throw 'Previous Lambda code drift'}
  $stack=(Aws @('cloudformation','describe-stacks','--stack-name',$stackName)).Stacks[0]
  if($stack.StackStatus -ne 'UPDATE_COMPLETE'){throw 'Stack not settled'}
  $p=@{}; foreach($parameter in $stack.Parameters){$p[$parameter.ParameterKey]=$parameter.ParameterValue}
  $bundle=Join-Path $repoRoot 'dist/aws-clinical-core/identity-api/index.js'
  if((Get-FileHash $bundle -Algorithm SHA256).Hash.ToLowerInvariant() -ne '6cec1bcdc82aa1760d16f47359bb3f39e03b09c8a356def804f645943105ae4a'){throw 'Bundle differs from reviewed build'}
  $zip=Join-Path $repoRoot 'dist/settlement-qualification/identity-api-b55e774.zip'
  if(Test-Path -LiteralPath $zip){throw 'Artifact exists; inspect it rather than overwrite'}
  Compress-Archive -LiteralPath $bundle -DestinationPath $zip
  $digest=(Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()
  $key="clinical-core/authenticated-api/$digest.zip"
  & aws.exe s3 cp $zip "s3://$($p.LambdaCodeBucket)/$key" --profile $profile --region $region --sse aws:kms --sse-kms-key-id $p.ClinicalCoreKeyArn --only-show-errors
  if($LASTEXITCODE -ne 0){throw 'Upload failed'}
  $parameters=@($stack.Parameters|ForEach-Object {if($_.ParameterKey -eq 'LambdaCodeKey'){@{ParameterKey=$_.ParameterKey;ParameterValue=$key}}else{@{ParameterKey=$_.ParameterKey;UsePreviousValue=$true}}})
  $parameterPath=Join-Path $repoRoot 'dist/settlement-qualification/api-parameters.json'
  [IO.File]::WriteAllText($parameterPath,($parameters|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
  $change=Aws @('cloudformation','create-change-set','--stack-name',$stackName,'--change-set-name',$changeName,'--change-set-type','UPDATE','--use-previous-template','--parameters',"file://$parameterPath",'--capabilities','CAPABILITY_IAM','--description','Synthetic messaging settlement only; retain 35 routes; programs withheld pending source fixes')
  $record=[ordered]@{sourceCommit=$current;account='588966314750';region=$region;phiAllowed=$false;sourceBundleSha256='6cec1bcdc82aa1760d16f47359bb3f39e03b09c8a356def804f645943105ae4a';artifactSha256=$digest;bucket=$p.LambdaCodeBucket;key=$key;previousKey=$p.LambdaCodeKey;previousCodeSha256=$configuration.CodeSha256;changeSetId=$change.Id;stackId=$change.StackId;templateMode='use-previous-template';programRoutesWithheld=$true;deployed=$false}
  [IO.File]::WriteAllText($receiptPath,($record|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
  $record|ConvertTo-Json -Depth 8
} elseif($Mode -eq 'execute'){
  $record=Get-Content $receiptPath -Raw|ConvertFrom-Json
  $change=Aws @('cloudformation','describe-change-set','--change-set-name',$record.changeSetId,'--stack-name',$stackName)
  if($change.Status -ne 'CREATE_COMPLETE' -or $change.ExecutionStatus -ne 'AVAILABLE'){throw 'Change set not ready'}
  $changes=@($change.Changes|ForEach-Object {$_.ResourceChange})
  if($changes.Count -lt 1 -or $changes.Count -gt 2){throw 'Unexpected change count'}
  foreach($item in $changes){if($item.Action -ne 'Modify' -or $item.LogicalResourceId -notin @('IdentityApiFunction','IdentityApiIntegration') -or $item.Replacement -ne 'False'){throw 'Changeset exceeds code-only scope'}}
  Aws @('cloudformation','execute-change-set','--change-set-name',$record.changeSetId,'--stack-name',$stackName)
  Write-Output 'Reviewed code-only changeset executing. This is not acceptance.'
} else {
  $record=Get-Content $receiptPath -Raw|ConvertFrom-Json
  $stack=(Aws @('cloudformation','describe-stacks','--stack-name',$stackName)).Stacks[0]
  $configuration=Aws @('lambda','get-function-configuration','--function-name','wxv734oi12-synthetic-identity')
  $wanted=[Convert]::ToBase64String([Convert]::FromHexString($record.artifactSha256))
  if($stack.StackStatus -ne 'UPDATE_COMPLETE' -or $configuration.CodeSha256 -ne $wanted -or $configuration.State -ne 'Active' -or $configuration.LastUpdateStatus -ne 'Successful' -or $configuration.Timeout -ne 15 -or $configuration.MemorySize -ne 256){throw 'Deployment not verified'}
  $reservation=Aws @('lambda','get-function-concurrency','--function-name','wxv734oi12-synthetic-identity')
  if($null -ne $reservation.ReservedConcurrentExecutions){throw 'Unexpected reservation change'}
  $record.deployed=$true
  $record|Add-Member -NotePropertyName deployedCodeSha256 -NotePropertyValue $wanted -Force
  $record|Add-Member -NotePropertyName stackStatus -NotePropertyValue $stack.StackStatus -Force
  [IO.File]::WriteAllText($receiptPath,($record|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
  $record|ConvertTo-Json -Depth 8
}
