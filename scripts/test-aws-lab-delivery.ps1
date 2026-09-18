param([switch]$ConfirmSyntheticFixtures)
$ErrorActionPreference = 'Stop'
if (-not $ConfirmSyntheticFixtures) { throw 'Explicit temporary synthetic-fixture confirmation required.' }
$account = aws sts get-caller-identity --profile ai-synthetic-member --query Account --output text
if ($LASTEXITCODE -ne 0 -or $account.Trim() -ne '588966314750') { throw 'Synthetic account required.' }
$stack = aws cloudformation describe-stacks --stack-name ai-clinical-core-synthetic-staging-lab-analysis --profile ai-synthetic-member --region us-east-2 --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $stack.Stacks[0].StackStatus -ne 'UPDATE_COMPLETE') { throw 'Reviewed synthetic stack unavailable.' }
$outputs = @{}
foreach ($output in $stack.Stacks[0].Outputs) { $outputs[$output.OutputKey] = $output.OutputValue }
if ($outputs.PhiAllowed -ne 'false' -or $outputs.DataClassification -ne 'synthetic_only') { throw 'Synthetic-only boundary required.' }
$physical = aws cloudformation describe-stack-resource --stack-name ai-clinical-core-synthetic-staging-lab-analysis --logical-resource-id LabJobTable --profile ai-synthetic-member --region us-east-2 --query StackResourceDetail.PhysicalResourceId --output text
if ($LASTEXITCODE -ne 0 -or $physical.Trim() -ne $outputs.LabJobTableName) { throw 'Table mapping mismatch.' }
$previous = @{}
$values = @{ AWS_PROFILE='ai-synthetic-member'; AWS_REGION='us-east-2'; PHI_ALLOWED='false'; CONFIRM_SYNTHETIC_FIXTURES='true'; LAB_JOB_TABLE=$outputs.LabJobTableName }
try {
  foreach ($key in $values.Keys) { $previous[$key] = [Environment]::GetEnvironmentVariable($key,'Process'); [Environment]::SetEnvironmentVariable($key,$values[$key],'Process') }
  & node_modules/.bin/esbuild.cmd src/server/clinical-core/lab-delivery-acceptance.ts --bundle --platform=node --target=node22 --format=cjs --outfile=dist/aws-clinical-core/lab-delivery-acceptance/index.cjs --log-level=warning
  if ($LASTEXITCODE -ne 0) { throw 'Acceptance build failed.' }
  node dist/aws-clinical-core/lab-delivery-acceptance/index.cjs
  if ($LASTEXITCODE -ne 0) { throw 'Synthetic delivery acceptance failed; inspect bounded cleanup report.' }
} finally {
  foreach ($key in $previous.Keys) { [Environment]::SetEnvironmentVariable($key,$previous[$key],'Process') }
}
