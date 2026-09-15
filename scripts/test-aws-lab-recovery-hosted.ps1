param([switch]$ConfirmSyntheticOnly,[switch]$CreateSyntheticTestUsers,[string]$Profile='ai-synthetic-member')
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$common=@('--profile',$Profile,'--region','us-east-2','--no-cli-pager')
function AwsJson([string[]]$Arguments){
  $raw=& aws @Arguments @common --output json
  if($LASTEXITCODE -ne 0){throw 'AWS test operation failed.'}
  if($raw){return ($raw|ConvertFrom-Json)}
}
if(-not $ConfirmSyntheticOnly -or -not $CreateSyntheticTestUsers){throw 'Explicit synthetic-only/test-identity confirmation required.'}
if((AwsJson @('sts','get-caller-identity')).Account -ne '588966314750'){throw 'Wrong account.'}
$foundation=(AwsJson @('cloudformation','describe-stacks','--stack-name','ai-clinical-core-synthetic-staging')).Stacks[0]
foreach($pair in @(@('PhiAllowed','false'),@('DataClassification','synthetic_only'),@('Environment','synthetic-staging'))){
  if(@($foundation.Outputs|Where-Object {$_.OutputKey -eq $pair[0] -and $_.OutputValue -eq $pair[1]}).Count -ne 1){throw 'Synthetic posture unavailable.'}
}
$stack=(AwsJson @('cloudformation','describe-stacks','--stack-name','ai-clinical-core-synthetic-staging-lab-analysis')).Stacks[0]
if($stack.StackStatus -ne 'UPDATE_COMPLETE'){throw 'Wait for the reviewed update to complete.'}
$p=@{};foreach($entry in $stack.Parameters){$p[$entry.ParameterKey]=$entry.ParameterValue}
$resources=(AwsJson @('cloudformation','describe-stack-resources','--stack-name',$stack.StackName)).StackResources
$table=($resources|Where-Object LogicalResourceId -eq 'LabJobTable').PhysicalResourceId
$indexes=(AwsJson @('dynamodb','describe-table','--table-name',$table)).Table.GlobalSecondaryIndexes
if(@($indexes|Where-Object {$_.IndexName -eq 'LabOwnerInventory' -and $_.IndexStatus -eq 'ACTIVE'}).Count -ne 1){throw 'Recovery index is not ACTIVE.'}
$origin="https://$($p['ClinicalApiId']).execute-api.us-east-2.amazonaws.com"
$prefix='/clinical-core/consumer/labs'
$users=[System.Collections.Generic.List[string]]::new()
$tokens=[System.Collections.Generic.List[string]]::new()
$handler=[System.Net.Http.HttpClientHandler]::new()
$handler.AllowAutoRedirect=$false
$client=[System.Net.Http.HttpClient]::new($handler)
$client.Timeout=[TimeSpan]::FromSeconds(30)
$jobId=$null
$passed=[System.Collections.Generic.List[string]]::new()
$script:lastHttpStatus=0
function CallApi([string]$Method,[string]$Path,[string]$Token,[object]$Body=$null){
  $request=[System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($Method),$origin+$prefix+$Path)
  if($Token){$request.Headers.Authorization=[System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer',$Token)}
  if($null -ne $Body){$request.Content=[System.Net.Http.StringContent]::new(($Body|ConvertTo-Json -Depth 12 -Compress),[Text.Encoding]::UTF8,'application/json')}
  try{
    $response=$client.SendAsync($request).GetAwaiter().GetResult()
    try{
      $raw=$response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      if($raw.Length -gt 200000){throw 'Oversized test response.'}
      $data=$null;try{$data=$raw|ConvertFrom-Json}catch{}
      $script:lastHttpStatus=[int]$response.StatusCode
      return @{Status=[int]$response.StatusCode;Json=$data}
    }finally{$response.Dispose()}
  }finally{$request.Dispose()}
}
function Check([bool]$Condition,[string]$Name){if(-not $Condition){throw "Hosted check failed: $Name (HTTP $script:lastHttpStatus)"};$passed.Add($Name);Write-Host "PASS $Name"}
try{
  $anonymous=CallApi 'GET' '/request-recovery' ''
  Check ($anonymous.Status -eq 401) 'anonymous capability access denied'
  $org=[guid]::NewGuid().ToString()
  for($i=0;$i -lt 2;$i++){
    $username='release-'+[guid]::NewGuid().ToString('N')+'@example.invalid'
    $person=[guid]::NewGuid().ToString()
    $null=AwsJson @('cognito-idp','admin-create-user','--user-pool-id',$p['ConsumerUserPoolId'],'--username',$username,
      '--message-action','SUPPRESS','--user-attributes',"Name=custom:synthetic_attested,Value=true","Name=custom:organization_id,Value=$org","Name=custom:person_id,Value=$person")
    $users.Add($username)
    $password='Syn!'+[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(36))+'7a'
    $null=AwsJson @('cognito-idp','admin-set-user-password','--user-pool-id',$p['ConsumerUserPoolId'],'--username',$username,'--password',$password,'--permanent')
    $auth=AwsJson @('cognito-idp','admin-initiate-auth','--user-pool-id',$p['ConsumerUserPoolId'],'--client-id',$p['ConsumerUserPoolClientId'],
      '--auth-flow','ADMIN_USER_PASSWORD_AUTH','--auth-parameters',"USERNAME=$username,PASSWORD=$password")
    $password=$null
    $tokens.Add($auth.AuthenticationResult.IdToken);$auth=$null
  }
  $a=$tokens[0];$b=$tokens[1]
  $capability=CallApi 'GET' '/request-recovery' $a
  Check ($capability.Status -eq 200 -and $capability.Json.data.contractVersion -eq 'lab-request-recovery/1') 'real Cognito capability contract'
  $documentId=[guid]::NewGuid().ToString()
  $fixture=[Text.Encoding]::UTF8.GetBytes('%PDF-1.4 synthetic upload recovery fixture only')
  $requestBody=@{request=@{id=[guid]::NewGuid().ToString();createdAt=[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')};
    panelId=[guid]::NewGuid().ToString();dataClassification='synthetic_only';attestsSyntheticOnly=$true;
    documents=@(@{clientDocumentId=$documentId;fileName='synthetic-recovery.pdf';contentType='application/pdf';byteSize=$fixture.Length;
      checksumSHA256=[Convert]::ToBase64String([Security.Cryptography.SHA256]::HashData($fixture))})}
  $created=CallApi 'POST' '/requests/documents' $a $requestBody
  Check ($created.Status -in @(200,201) -and $created.Json.data.contractVersion -eq 'lab-request-recovery/1') 'durable request creation without worker start'
  $jobId=$created.Json.data.jobId
  $again=CallApi 'POST' '/requests/documents' $a $requestBody
  Check ($again.Status -in @(200,201) -and $again.Json.data.jobId -eq $jobId) 'same request returns same job'
  $changed=($requestBody|ConvertTo-Json -Depth 12|ConvertFrom-Json)
  $changed.documents[0].fileName='changed-synthetic-file.pdf'
  $conflict=CallApi 'POST' '/requests/documents' $a $changed
  Check ($conflict.Status -eq 409) 'changed request input refused'
  $other=CallApi 'GET' "/requests/$($requestBody.request.id)" $b
  Check ($other.Status -in @(403,404)) 'second user cannot discover request'
  $other=CallApi 'GET' "/jobs/$jobId/recovery" $b
  Check ($other.Status -in @(403,404)) 'second user cannot read recovery'
  $other=CallApi 'POST' "/jobs/$jobId/resume-upload" $b
  Check ($other.Status -in @(403,404)) 'second user cannot obtain upload URL'
  $owned=CallApi 'GET' "/jobs/$jobId/recovery" $a
  Check ($owned.Status -eq 200 -and $owned.Json.data.job.jobId -eq $jobId) 'owner can recover original metadata'
  $resume=CallApi 'POST' "/jobs/$jobId/resume-upload" $a
  Check ($resume.Status -eq 200 -and @($resume.Json.data.documents).Count -eq 1 -and @($resume.Json.data.uploadedDocuments).Count -eq 0) 'missing-object detection and upload renewal'
  $other=CallApi 'GET' '/inventory' $b
  Write-Host "Second-user inventory HTTP: $($other.Status)"
  Check ($other.Status -eq 200 -and @($other.Json.data.jobs|Where-Object jobId -eq $jobId).Count -eq 0) 'second-user inventory isolation'
  $visible=$false
  for($attempt=0;$attempt -lt 10;$attempt++){
    $owned=CallApi 'GET' '/inventory' $a
    if($owned.Status -ne 200){break}
    if(@($owned.Json.data.jobs|Where-Object jobId -eq $jobId).Count -eq 1){$visible=$true;break}
    Start-Sleep -Seconds 1
  }
  Check $visible 'owned job appears in live index'
  $deleted=CallApi 'DELETE' "/jobs/$jobId" $a
  Check ($deleted.Status -eq 200) 'owned empty test job deleted without analysis'
  $jobId=$null
  Write-Host "Hosted synthetic checks passed: $($passed.Count). No uploads, AI generations, email sends, or real data."
}finally{
  if($jobId -and $tokens.Count){
    try{$cleanup=CallApi 'DELETE' "/jobs/$jobId" $tokens[0];Write-Host "Test-job cleanup HTTP: $($cleanup.Status)"}catch{Write-Warning 'Test-job cleanup needs operator review; no forced deletion attempted.'}
  }
  $disabled=0
  foreach($username in $users){
    try{$null=AwsJson @('cognito-idp','admin-user-global-sign-out','--user-pool-id',$p['ConsumerUserPoolId'],'--username',$username)}catch{Write-Warning 'Test-session revocation needs review.'}
    try{$null=AwsJson @('cognito-idp','admin-disable-user','--user-pool-id',$p['ConsumerUserPoolId'],'--username',$username);$disabled++}catch{Write-Warning 'Test-identity disable needs review.'}
  }
  $tokens.Clear();$a=$null;$b=$null;$password=$null;$client.Dispose()
  Write-Host "Disabled $disabled of $($users.Count) newly created synthetic test identities; audit history retained."
  if($disabled -ne $users.Count){throw 'Synthetic test identity cleanup incomplete.'}
}
