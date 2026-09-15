param(
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{40}$')][string]$ExpectedSourceCommit,
  [string]$Profile = 'ai-synthetic-member',
  [switch]$ConfirmSyntheticOnly
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$region = 'us-east-2'
$stackName = 'ai-clinical-core-synthetic-staging-lab-analysis'
$common = @('--profile',$Profile,'--region',$region,'--no-cli-pager')
function AwsJson([string[]]$Arguments) {
  $raw = & aws @Arguments @common --output json
  if ($LASTEXITCODE -ne 0) { throw 'AWS operation failed; no automatic retry or replacement deployment.' }
  return ($raw | ConvertFrom-Json)
}
if (-not $ConfirmSyntheticOnly) { throw 'Explicit synthetic-only confirmation required.' }
$head = (& git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $head -ne $ExpectedSourceCommit) { throw 'Source commit mismatch.' }
if (& git status --porcelain --untracked-files=no) { throw 'Tracked worktree changes must be committed before release.' }
$account = AwsJson @('sts','get-caller-identity')
if ($account.Account -ne '588966314750') { throw 'Wrong AWS account. This script never deploys production.' }
$foundation = (AwsJson @('cloudformation','describe-stacks','--stack-name','ai-clinical-core-synthetic-staging')).Stacks[0]
foreach ($pair in @(@('PhiAllowed','false'),@('DataClassification','synthetic_only'),@('Environment','synthetic-staging'))) {
  $output = @($foundation.Outputs | Where-Object OutputKey -eq $pair[0])
  if ($output.Count -ne 1 -or $output[0].OutputValue -ne $pair[1]) { throw 'Synthetic foundation posture is not verified.' }
}
$stack = (AwsJson @('cloudformation','describe-stacks','--stack-name',$stackName)).Stacks[0]
if ($stack.StackStatus -notin @('CREATE_COMPLETE','UPDATE_COMPLETE','UPDATE_ROLLBACK_COMPLETE')) { throw 'Stack is not idle.' }
$live = (AwsJson @('cloudformation','get-template','--stack-name',$stackName)).TemplateBody
if ($live -is [string]) { $live = $live | ConvertFrom-Json }
$candidate = Get-Content -LiteralPath 'infra/aws-clinical-core/lab-analysis-extension.json' -Raw | ConvertFrom-Json
$parameters = @{}
foreach ($parameter in $stack.Parameters) { $parameters[$parameter.ParameterKey] = $parameter.ParameterValue }
$resourceMap = @{}
foreach ($resource in (AwsJson @('cloudformation','describe-stack-resources','--stack-name',$stackName)).StackResources) {
  $resourceMap[$resource.LogicalResourceId] = $resource.PhysicalResourceId
}
# Preserve even out-of-band edits by refusing drift, rather than silently erasing them.
foreach ($logical in @('LabApiFunction','LabWorkerFunction','LabSyntheticAuthorizerFunction')) {
  $actual = AwsJson @('lambda','get-function-configuration','--function-name',$resourceMap[$logical])
  $declared = $live.Resources.$logical.Properties.Environment.Variables
  if (@($actual.Environment.Variables.PSObject.Properties).Count -ne @($declared.PSObject.Properties).Count) { throw "Environment drift in $logical." }
  foreach ($property in $declared.PSObject.Properties) {
    $value = $property.Value
    if ($value -isnot [string]) {
      if ($value.PSObject.Properties.Name -contains 'Ref') {
        if ($parameters.ContainsKey($value.Ref)) { $value = $parameters[$value.Ref] }
        elseif ($resourceMap.ContainsKey($value.Ref)) { $value = $resourceMap[$value.Ref] }
        else { throw 'Unresolved deployment reference.' }
      } elseif ($value.PSObject.Properties.Name -contains 'Fn::Sub') {
        $value = $value.'Fn::Sub'
        $value = $value.Replace('${AWS::Partition}','aws').Replace('${AWS::Region}',$region).Replace('${AWS::AccountId}',$account.Account)
        foreach ($key in $parameters.Keys) { $value = $value.Replace('${'+$key+'}',$parameters[$key]) }
        if ($value.Contains('${')) { throw 'Unresolved deployment substitution.' }
      } else { throw 'Unknown environment expression.' }
    }
    if ($actual.Environment.Variables.PSObject.Properties.Name -notcontains $property.Name -or $actual.Environment.Variables.($property.Name) -cne $value) {
      throw "Environment value drift in $logical. No values printed."
    }
  }
}
foreach ($name in $live.Resources.PSObject.Properties.Name) {
  if ($candidate.Resources.PSObject.Properties.Name -notcontains $name) { throw 'Candidate would remove a resource.' }
}
foreach ($name in $parameters.Keys) {
  if ($candidate.Parameters.PSObject.Properties.Name -notcontains $name) { throw 'Candidate removed an existing parameter.' }
}
foreach ($name in $candidate.Parameters.PSObject.Properties.Name) {
  if (-not $parameters.ContainsKey($name) -and $name -notin @('KnowledgeReleaseMode','KnowledgeReleaseBucket','KnowledgeReleaseKey','KnowledgeReleaseObjectVersion','KnowledgeReleaseSha256','KnowledgeSourcePackageSha256','KnowledgeSignerPublicKeyPem')) { throw 'Unreviewed new parameter.' }
}
if ($candidate.Parameters.KnowledgeReleaseMode.Default -ne 'disabled') { throw 'Knowledge activation is not authorized.' }
& npm run typecheck
if ($LASTEXITCODE -ne 0) { throw 'Typecheck failed.' }
& npm run build:aws-lab-analysis
if ($LASTEXITCODE -ne 0) { throw 'Lab build failed.' }
$artifactDir = Join-Path $root ('dist/aws-clinical-core/releases/' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $artifactDir
$keys = @{}
foreach ($kind in @('api','worker')) {
  $zip = Join-Path $artifactDir "$kind.zip"
  Compress-Archive -LiteralPath (Join-Path $root "dist/aws-clinical-core/lab-analysis/$kind/index.js") -DestinationPath $zip
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant()
  $keys[$kind] = "clinical-core/lab-analysis/$kind-$hash.zip"
  & aws s3 cp $zip "s3://$($parameters['LambdaCodeBucket'])/$($keys[$kind])" @common --only-show-errors --sse aws:kms --sse-kms-key-id $parameters['ClinicalCoreKeyArn'] --metadata "source-commit=$head"
  if ($LASTEXITCODE -ne 0) { throw 'Artifact upload failed.' }
  Write-Host "$kind artifact SHA256: $hash"
}
$preserved = @($stack.Parameters | Where-Object ParameterKey -notin @('ApiCodeKey','WorkerCodeKey') | ForEach-Object { "ParameterKey=$($_.ParameterKey),UsePreviousValue=true" })
$preserved += "ParameterKey=ApiCodeKey,ParameterValue=$($keys['api'])"
$preserved += "ParameterKey=WorkerCodeKey,ParameterValue=$($keys['worker'])"
$name = 'recovery-' + $head.Substring(0,12) + '-' + (Get-Date -Format 'yyyyMMddHHmmss')
$result = AwsJson (@('cloudformation','create-change-set','--stack-name',$stackName,'--change-set-name',$name,
  '--change-set-type','UPDATE','--template-body','file://infra/aws-clinical-core/lab-analysis-extension.json',
  '--capabilities','CAPABILITY_IAM','--description',"Synthetic recovery source $head; preserve existing parameters; PHI remains disabled",
  '--parameters') + $preserved)
Write-Host "Prepared change set: $name"
Write-Host "Source: $head"
Write-Host 'NOT EXECUTED. Review removals/replacements/IAM, then execute this exact change set separately.'
