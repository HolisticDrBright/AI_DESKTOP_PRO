$ErrorActionPreference = 'Stop'
$runner = Join-Path $PSScriptRoot 'prepare-aws-qualification-target.ps1'
$tokens = $null
$parseErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile($runner, [ref]$tokens, [ref]$parseErrors) > $null
if ($parseErrors.Count) { throw 'qualification_runner_parse_failed' }

# Credential-free test: all external commands are intercepted; no AWS or database call is possible.
function aws {
  $global:QualificationRunnerTestCalls++
  if ($args[0] -eq 'sts') {
    $global:LASTEXITCODE=0
    return (@{ Account='588966314750'; Arn=$global:QualificationRunnerTestArn; UserId='fictional-session' } | ConvertTo-Json -Compress)
  }
  if ($args[0] -eq 'cloudformation') {
    $global:LASTEXITCODE=0
    return '[{"OutputKey":"PhiAllowed","OutputValue":"false"},{"OutputKey":"DatabaseName","OutputValue":"clinical_core"},{"OutputKey":"DatabaseClusterArn","OutputValue":"fictional-cluster"},{"OutputKey":"DatabaseSecretArn","OutputValue":"fictional-secret"}]'
  }
  throw 'unexpected_external_call'
}
function npm { $global:QualificationRunnerTestCalls++; $global:LASTEXITCODE=0 }
function node {
  $global:QualificationRunnerTestCalls++; $global:LASTEXITCODE=0
  if ($args[-1] -eq 'inspect') { return '{"safeToApply":true}' }
}
$manifest = Join-Path $PSScriptRoot '../infra/aws-clinical-core/deployment-manifest.example.json'
function Get-Content {
  # Supply a fictional target manifest without touching or manufacturing an approval file.
  '{"aws_account_id":"588966314750","aws_region":"us-east-2"}'
}
$passed=0
$global:QualificationRunnerTestArn='arn:aws:sts::588966314750:assumed-role/QualificationOperator/fictional-session'
foreach ($testCommand in @('apply','inspect','create','fixtures')) {
  foreach ($targetName in @('postgres','clinical_core','rdsadmin','template0','template1','unrelated','qualification;drop','Qualification_upper')) {
    $global:QualificationRunnerTestCalls=0
    $refused=$false
    $caught='none'
    try {
      & $runner -Command $testCommand -FoundationStackName fictional -DeploymentManifestPath $manifest -SyntheticManifestPath fictional -QualificationDatabaseName $targetName -ConfirmQualificationTarget *> $null
    } catch {
      $caught=$_.Exception.Message
      $refused=$caught -eq 'qualification_name_refused'
    }
    if (-not $refused -or $global:QualificationRunnerTestCalls -ne 0) { throw "Invalid target reached the runner: $testCommand / $targetName; external calls=$global:QualificationRunnerTestCalls; result=$caught" }
    $passed++
  }
}
$global:QualificationRunnerTestArn='arn:aws:iam::588966314750:root'
$global:QualificationRunnerTestCalls=0
$caught='none'
try {
  & $runner -Command inspect -FoundationStackName fictional -DeploymentManifestPath $manifest -QualificationDatabaseName clinical_core_qualification *> $null
} catch { $caught=$_.Exception.Message }
if ($caught -ne 'qualification_operator_principal_refused' -or $global:QualificationRunnerTestCalls -ne 1) {
  throw "Root qualification operator was not refused immediately: $caught; external calls=$global:QualificationRunnerTestCalls"
}
$passed++
$global:QualificationRunnerTestArn='arn:aws:sts::588966314750:assumed-role/QualificationOperator/fictional-session'
Write-Host "Qualification runner syntax, 32 pre-network name refusals and one root-principal refusal passed (external calls intercepted)."
