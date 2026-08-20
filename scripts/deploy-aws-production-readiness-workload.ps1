[CmdletBinding()]
param(
  [string]$Profile = "ai-production",
  [string]$Region = "us-east-2",
  [string]$FoundationStack = "ai-longevity-production-clinical-foundation",
  [string]$WorkloadStack = "ai-desktop-pro-production-readiness",
  [string]$SourceVersion = "",
  [switch]$ConfirmPhiDisabled
)

$ErrorActionPreference = "Stop"
if (-not $ConfirmPhiDisabled) { throw "Refused: pass -ConfirmPhiDisabled. This workflow never enables PHI." }
if (-not $SourceVersion) { $SourceVersion = (git rev-parse HEAD).Trim() }
if ($SourceVersion -notmatch '^[a-f0-9]{40}$') { throw "SourceVersion must be a full lowercase commit SHA." }

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$templatePath = Join-Path $repoRoot "infra\aws-clinical-core\production-readiness-workload.json"
if ((git -C $repoRoot status --short).Length -ne 0) { throw "Refused: commit and push the exact workload source before deployment." }
$branch = (git -C $repoRoot branch --show-current).Trim()
$remoteHead = (git -C $repoRoot ls-remote origin "refs/heads/$branch").Split("`t")[0].Trim()
if ($remoteHead -ne $SourceVersion) { throw "Refused: local commit does not match the pushed branch head." }

function AwsJson([string[]]$Arguments) {
  $raw = & aws @Arguments --profile $Profile --region $Region --output json
  if ($LASTEXITCODE -ne 0) { throw "AWS command failed: $($Arguments -join ' ')" }
  return $raw | ConvertFrom-Json
}
function StackOutputs([string]$Name) {
  $stack = AwsJson @("cloudformation", "describe-stacks", "--stack-name", $Name)
  $map = @{}
  foreach ($item in $stack.Stacks[0].Outputs) { $map[$item.OutputKey] = $item.OutputValue }
  return $map
}
function StackResource([string]$LogicalId) {
  $item = AwsJson @("cloudformation", "describe-stack-resource", "--stack-name", $FoundationStack, "--logical-resource-id", $LogicalId)
  return $item.StackResourceDetail.PhysicalResourceId
}

$identity = AwsJson @("sts", "get-caller-identity")
if ($identity.Account -ne "173535830222") { throw "Refused: expected the controlled production account." }
$foundation = StackOutputs $FoundationStack
if ($foundation.PhiAllowed -ne "false" -or $foundation.Environment -ne "production-clinical") {
  throw "Refused: the production foundation is not explicitly PHI-blocked."
}

$vpcId = StackResource "ClinicalVpc"
$subnets = @((StackResource "DatabaseSubnetA"), (StackResource "DatabaseSubnetB"))
$routeTables = AwsJson @("ec2", "describe-route-tables", "--filters", "Name=vpc-id,Values=$vpcId", "Name=association.main,Values=true")
$routeTableId = $routeTables.RouteTables[0].RouteTableId
if (-not $routeTableId) { throw "No main private VPC route table was found." }
$vpc = AwsJson @("ec2", "describe-vpcs", "--vpc-ids", $vpcId)
$vpcCidr = $vpc.Vpcs[0].CidrBlock

$repositoryUri = $foundation.DesktopProductionRepositoryUri
$repositoryName = $repositoryUri.Split("/")[-1]
$repositoryArn = "arn:aws:ecr:${Region}:$($identity.Account):repository/$repositoryName"
$clinicalOrigin = $foundation.ApiOrigin.TrimEnd("/")
$clinicalHost = ([Uri]$clinicalOrigin).Host
$clusterName = $foundation.ProductionEcsClusterArn.Split("/")[-1]
$params = @(
  "ParameterKey=VpcId,ParameterValue=$vpcId",
  "ParameterKey=VpcCidr,ParameterValue=$vpcCidr",
  "ParameterKey=PrivateSubnetIds,ParameterValue=$($subnets -join ',')",
  "ParameterKey=PrivateRouteTableId,ParameterValue=$routeTableId",
  "ParameterKey=EcsClusterArn,ParameterValue=$($foundation.ProductionEcsClusterArn)",
  "ParameterKey=EcsClusterName,ParameterValue=$clusterName",
  "ParameterKey=DesktopRepositoryUri,ParameterValue=$repositoryUri",
  "ParameterKey=DesktopRepositoryArn,ParameterValue=$repositoryArn",
  "ParameterKey=TaskExecutionRoleArn,ParameterValue=$($foundation.DesktopProductionTaskExecutionRoleArn)",
  "ParameterKey=ClinicalCoreKeyArn,ParameterValue=$($foundation.ClinicalCoreKeyArn)",
  "ParameterKey=ClinicalApiOrigin,ParameterValue=$clinicalOrigin",
  "ParameterKey=ClinicalApiHost,ParameterValue=$clinicalHost",
  "ParameterKey=WorkforceUserPoolId,ParameterValue=$($foundation.WorkforceUserPoolId)",
  "ParameterKey=WorkforceClientId,ParameterValue=$($foundation.WorkforceUserPoolClientId)",
  "ParameterKey=ConsumerUserPoolId,ParameterValue=$($foundation.ConsumerUserPoolId)",
  "ParameterKey=ConsumerClientId,ParameterValue=$($foundation.ConsumerUserPoolClientId)",
  "ParameterKey=ImageTag,ParameterValue=$SourceVersion",
  "ParameterKey=SourceVersion,ParameterValue=$SourceVersion"
)

function Deploy([string]$DeployService) {
  & aws cloudformation deploy --profile $Profile --region $Region --stack-name $WorkloadStack --template-file $templatePath --capabilities CAPABILITY_NAMED_IAM --no-fail-on-empty-changeset --parameter-overrides @params "ParameterKey=DeployService,ParameterValue=$DeployService"
  if ($LASTEXITCODE -ne 0) { throw "Production readiness workload stack deployment failed." }
}

Deploy "false"
$workload = StackOutputs $WorkloadStack
$build = AwsJson @("codebuild", "start-build", "--project-name", $workload.BuildProjectName)
$buildId = $build.build.id
do {
  Start-Sleep -Seconds 10
  $state = AwsJson @("codebuild", "batch-get-builds", "--ids", $buildId)
  $status = $state.builds[0].buildStatus
} while ($status -in @("IN_PROGRESS", "QUEUED"))
if ($status -ne "SUCCEEDED") { throw "Exact-commit production image build or refusal smoke test failed: $status" }

$scanDeadline = (Get-Date).AddMinutes(15)
do {
  Start-Sleep -Seconds 10
  $scan = AwsJson @("ecr", "describe-image-scan-findings", "--repository-name", $repositoryName, "--image-id", "imageTag=$SourceVersion")
  $scanStatus = $scan.imageScanStatus.status
} while ($scanStatus -in @("IN_PROGRESS", "PENDING") -and (Get-Date) -lt $scanDeadline)
if ($scanStatus -ne "COMPLETE") { throw "ECR image scan did not complete: $scanStatus" }
$critical = [int]($scan.imageScanFindings.findingSeverityCounts.CRITICAL ?? 0)
$high = [int]($scan.imageScanFindings.findingSeverityCounts.HIGH ?? 0)
if ($critical -ne 0 -or $high -ne 0) { throw "Image refused: ECR found $critical critical and $high high findings." }

Deploy "true"
$workload = StackOutputs $WorkloadStack
& aws ecs wait services-stable --profile $Profile --region $Region --cluster $foundation.ProductionEcsClusterArn --services $workload.ServiceName
if ($LASTEXITCODE -ne 0) { throw "ECS readiness service did not stabilize." }
$service = AwsJson @("ecs", "describe-services", "--cluster", $foundation.ProductionEcsClusterArn, "--services", $workload.ServiceName)
$tasks = AwsJson @("ecs", "list-tasks", "--cluster", $foundation.ProductionEcsClusterArn, "--service-name", $workload.ServiceName)
$taskDetails = AwsJson (@("ecs", "describe-tasks", "--cluster", $foundation.ProductionEcsClusterArn, "--tasks") + @($tasks.taskArns))
if ($service.services[0].runningCount -ne 1 -or $taskDetails.tasks[0].healthStatus -ne "HEALTHY") {
  throw "ECS task is not RUNNING and HEALTHY."
}

[ordered]@{
  ok = $true
  account = $identity.Account
  environment = "production-clinical"
  phiAllowed = $false
  workloadMode = "readiness_only"
  sourceVersion = $SourceVersion
  imageScan = @{ critical = $critical; high = $high }
  runningTasks = $service.services[0].runningCount
  taskHealth = $taskDetails.tasks[0].healthStatus
  publicIngress = $false
} | ConvertTo-Json -Depth 4
