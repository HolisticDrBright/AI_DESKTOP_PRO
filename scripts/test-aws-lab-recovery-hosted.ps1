param([switch]$ConfirmSyntheticOnly,[switch]$CreateSyntheticTestUsers,[switch]$TestUploadRoundTrip,[switch]$TestLateUploadCleanup,[switch]$TestActiveCancellation,[switch]$TestLegacyInventoryMigration,[switch]$TestReviewedContext,[string]$Profile='ai-synthetic-member')
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$common=@('--profile',$Profile,'--region','us-east-2','--no-cli-pager')
function AwsJson([string[]]$Arguments){
  $raw=& aws @Arguments @common --output json
  if($LASTEXITCODE -ne 0){throw 'AWS test operation failed.'}
  if($raw){return ($raw|ConvertFrom-Json)}
}
if(-not $ConfirmSyntheticOnly -or -not $CreateSyntheticTestUsers){throw 'Explicit synthetic-only/test-identity confirmation required.'}
if($TestLateUploadCleanup -and -not $TestUploadRoundTrip){throw 'Late-upload verification requires the fixture-upload switch.'}
if($TestActiveCancellation -and (-not $TestUploadRoundTrip -or -not $TestLateUploadCleanup)){throw 'Cancellation acceptance requires the upload and late-cleanup checks.'}
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
$documentBucket=($resources|Where-Object LogicalResourceId -eq 'LabDocumentsBucket').PhysicalResourceId
$indexes=(AwsJson @('dynamodb','describe-table','--table-name',$table)).Table.GlobalSecondaryIndexes
if(@($indexes|Where-Object {$_.IndexName -eq 'LabOwnerInventory' -and $_.IndexStatus -eq 'ACTIVE'}).Count -ne 1){throw 'Recovery index is not ACTIVE.'}
if($TestLateUploadCleanup -and @($indexes|Where-Object {$_.IndexName -eq 'LabCleanupDue' -and $_.IndexStatus -eq 'ACTIVE'}).Count -ne 1){throw 'Cleanup index is not ACTIVE.'}
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
function PutFixture($Target,[byte[]]$Bytes){
  $uri=[uri]$Target.uploadUrl
  if($Target.method -ne 'PUT' -or $uri.Scheme -ne 'https' -or $uri.Port -ne 443 -or $uri.UserInfo -or $uri.Fragment -or
    $uri.Host -ne "$documentBucket.s3.us-east-2.amazonaws.com" -or
    -not $uri.AbsolutePath.EndsWith("/$jobId/$documentId/synthetic-recovery.pdf")){throw 'Untrusted upload target.'}
  $request=[System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Put,$uri)
  $request.Content=[System.Net.Http.ByteArrayContent]::new($Bytes)
  foreach($header in $Target.requiredHeaders.PSObject.Properties){
    if($header.Name -eq 'content-type'){$request.Content.Headers.ContentType=[System.Net.Http.Headers.MediaTypeHeaderValue]::new($header.Value)}
    elseif($header.Name -in @('x-amz-server-side-encryption','x-amz-server-side-encryption-aws-kms-key-id','x-amz-meta-job-id','x-amz-meta-document-id','x-amz-checksum-sha256','if-none-match')){
      $null=$request.Headers.TryAddWithoutValidation($header.Name,[string]$header.Value)
    }else{throw 'Unexpected upload header.'}
  }
  try{
    $response=$client.SendAsync($request).GetAwaiter().GetResult()
    try{$script:lastHttpStatus=[int]$response.StatusCode;return [int]$response.StatusCode}finally{$response.Dispose()}
  }finally{$request.Dispose()}
}
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
  $reviewedContext=@{ageYears=40;sex='male';pregnancyStatus='not_applicable';nursing=$false;
    mainComplaint=$null;complaintDuration=$null;complaintSeverity=0;conditions=@();medications=@();allergies=@();topSymptomSignals=@();
    lifestyle=@{sleepHours=7;sleepQuality=0;stressLevel=0;dietType='omnivore';exerciseFrequency=0}}
  if($TestReviewedContext){
    # Negative requests cannot dispatch a worker: the context binding must fail
    # before request-ledger creation. Successful saved-plan dispatch is unit-tested,
    # not exercised here, because it would run the provider.
    foreach($mode in @('mismatch','missing-context')){
      $invalidPlan=@{request=@{id=[guid]::NewGuid().ToString();createdAt=[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')};
        panelId=[guid]::NewGuid().ToString();panelName='Synthetic context refusal';testDate='2026-09-01';
        dataClassification='synthetic_only';attestsSyntheticOnly=$true;sourceContextSha256=('a'*64);
        biomarkers=@(@{markerId='fictional';canonicalName='Fictional';value=1;unit='widgets';labMin=$null;labMax=$null})}
      if($mode -eq 'mismatch'){$invalidPlan.patientContext=$reviewedContext}
      $refused=CallApi 'POST' '/requests/saved' $a $invalidPlan
      Check ($refused.Status -eq 400) "reviewed context $mode refused before dispatch"
      $missing=CallApi 'GET' "/requests/$($invalidPlan.request.id)" $a
      Check ($missing.Status -eq 404) "reviewed context $mode created no durable request"
    }
  }
  $capability=CallApi 'GET' '/request-recovery' $a
  Check ($capability.Status -eq 200 -and $capability.Json.data.contractVersion -eq 'lab-request-recovery/1') 'real Cognito capability contract'
  $documentId=[guid]::NewGuid().ToString()
  $fixture=[Text.Encoding]::UTF8.GetBytes('%PDF-1.4 synthetic upload recovery fixture only')
  $requestBody=@{request=@{id=[guid]::NewGuid().ToString();createdAt=[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')};
    panelId=[guid]::NewGuid().ToString();dataClassification='synthetic_only';attestsSyntheticOnly=$true;
    documents=@(@{clientDocumentId=$documentId;fileName='synthetic-recovery.pdf';contentType='application/pdf';byteSize=$fixture.Length;
      checksumSHA256=[Convert]::ToBase64String([Security.Cryptography.SHA256]::HashData($fixture))})}
  if($TestReviewedContext){$requestBody.patientContext=$reviewedContext}
  $created=CallApi 'POST' '/requests/documents' $a $requestBody
  Check ($created.Status -in @(200,201) -and $created.Json.data.contractVersion -eq 'lab-request-recovery/1') 'durable request creation without worker start'
  $jobId=$created.Json.data.jobId
  if($TestReviewedContext){
    $storedContext=AwsJson @('dynamodb','get-item','--table-name',$table,'--consistent-read','--key',(@{pk=@{S="job#$jobId"}}|ConvertTo-Json -Compress),
      '--projection-expression','patientContext, #state','--expression-attribute-names','{"#state":"state"}')
    Check ($storedContext.Item.patientContext.M.complaintSeverity.N -eq '0' -and $storedContext.Item.'state'.S -eq 'awaiting_upload') 'explicit zero severity retained without worker start'
  }
  if($TestLegacyInventoryMigration){
    # Only the fixture just created by this invocation is made legacy-shaped.
    # Its idempotency ledger, owner, source context and lifetime are unchanged.
    $key=@{pk=@{S="job#$jobId"}}|ConvertTo-Json -Compress
    $names=@{'#state'='state';'#request'='recoveryRequest';'#id'='id'}|ConvertTo-Json -Compress
    $values=@{':await'=@{S='awaiting_upload'};':request'=@{S=$requestBody.request.id}}|ConvertTo-Json -Compress
    $null=AwsJson @('dynamodb','update-item','--table-name',$table,'--key',$key,
      '--update-expression','REMOVE inventoryOwner, inventoryOrder',
      '--condition-expression','#state = :await AND #request.#id = :request AND attribute_exists(inventoryOwner) AND attribute_exists(inventoryOrder)',
      '--expression-attribute-names',$names,'--expression-attribute-values',$values)
    $indexMissing=$false
    for($attempt=0;$attempt -lt 10;$attempt++){
      $before=CallApi 'GET' '/inventory' $a
      if($before.Status -eq 200 -and @($before.Json.data.jobs|Where-Object jobId -eq $jobId).Count -eq 0){$indexMissing=$true;break}
      Start-Sleep -Seconds 1
    }
    Check $indexMissing 'legacy-shaped fixture initially absent from inventory'
    $stillOwned=CallApi 'GET' "/jobs/$jobId" $a
    Check ($stillOwned.Status -eq 200) 'legacy job remains recoverable by original identifier'
    $migrationDirectory=Join-Path $PSScriptRoot '../test-results/lab-inventory-migration'
    $null=New-Item -ItemType Directory -Path $migrationDirectory -Force
    $planFile=Join-Path $migrationDirectory ([guid]::NewGuid().ToString('N')+'.json')
    $source=(& git rev-parse HEAD).Trim()
    $rawPlan=& node scripts/migrate-lab-inventory.mjs plan --confirm-synthetic-only --profile $Profile --source $source --file $planFile --only-job $jobId
    if($LASTEXITCODE -ne 0){throw 'Synthetic fixture migration plan failed.'}
    $planReport=$rawPlan|ConvertFrom-Json
    $migrationPlan=Get-Content -LiteralPath $planFile -Raw|ConvertFrom-Json
    Check ($planReport.candidates -eq 1 -and @($migrationPlan.entries).Count -eq 1 -and $migrationPlan.entries[0].pk -eq "job#$jobId") 'reviewed migration selects only this new fixture'
    $actualHash=(Get-FileHash -LiteralPath $planFile -Algorithm SHA256).Hash.ToLowerInvariant()
    Check ($actualHash -ceq $planReport.sha256) 'exact migration plan bytes verified'
    $rawApply=& node scripts/migrate-lab-inventory.mjs apply --confirm-synthetic-only --profile $Profile --source $source --file $planFile --approved-sha256 $actualHash
    if($LASTEXITCODE -ne 0){throw 'Synthetic fixture migration apply failed.'}
    $migrationResult=$rawApply|ConvertFrom-Json
    Check ($migrationResult.indexed -eq 1 -and $migrationResult.conflicts -eq 0) 'metadata-only migration conditionally indexed fixture'
    $rawReplay=& node scripts/migrate-lab-inventory.mjs apply --confirm-synthetic-only --profile $Profile --source $source --file $planFile --approved-sha256 $actualHash
    if($LASTEXITCODE -ne 0){throw 'Synthetic fixture migration replay failed.'}
    Check (($rawReplay|ConvertFrom-Json).alreadyIndexed -eq 1) 'reviewed migration safely replays without another update'
    # Existing checks below verify owner visibility and second-user exclusion.
  }
  if($TestLateUploadCleanup){
    $workerName=($resources|Where-Object LogicalResourceId -eq 'LabWorkerFunction').PhysicalResourceId
    $outputDirectory=Join-Path $PSScriptRoot '../test-results/hosted-lab-cleanup'
    $null=New-Item -ItemType Directory -Path $outputDirectory -Force
    $outputPath=Join-Path $outputDirectory ([guid]::NewGuid().ToString('N')+'.json')
    $invocation=AwsJson @('lambda','invoke','--function-name',$workerName,'--cli-binary-format','raw-in-base64-out',
      '--payload',(@{jobId=$jobId;pass=0;fail=$true;failureCategory='internal_failure'}|ConvertTo-Json -Compress),$outputPath)
    if($invocation.PSObject.Properties.Name -contains 'FunctionError'){throw 'Synthetic failure-callback check failed.'}
    $callback=Get-Content -LiteralPath $outputPath -Raw|ConvertFrom-Json
    Check ($callback.skipped -eq $true -and $callback.jobId -eq $jobId) 'worker failure callback cannot alter an awaiting-upload job'
  }
  $again=CallApi 'POST' '/requests/documents' $a $requestBody
  Check ($again.Status -in @(200,201) -and $again.Json.data.jobId -eq $jobId) 'same request returns same job'
  # JSON roundtripping parses ISO strings as DateTime and trims fractional zeros
  # (.040Z -> .04Z), unintentionally changing the immutable request identity.
  $changed=$requestBody.Clone()
  $changed.documents=@($requestBody.documents|ForEach-Object {$_.Clone()})
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
  if($TestUploadRoundTrip){
    $target=$resume.Json.data.documents[0]
    Check ((PutFixture $target $fixture) -eq 200) 'encrypted checksum-bound fixture uploaded'
    Check ((PutFixture $target $fixture) -eq 412) 'existing object cannot be overwritten'
    $remote=CallApi 'POST' "/jobs/$jobId/resume-upload" $a
    Check ($remote.Status -eq 200 -and @($remote.Json.data.documents).Count -eq 0 -and
      @($remote.Json.data.uploadedDocuments).Count -eq 1 -and
      $remote.Json.data.uploadedDocuments[0].clientDocumentId -eq $documentId) 'remote receipt recovered from verified stored object'
    # Never call complete-upload: this smoke must not invoke the analysis worker.
  }
  if($TestActiveCancellation){
    # ONLY this newly created fixture. An unexpired lease makes Pass0 refuse
    # before any document/provider access; no complete-upload route is called.
    $key=@{pk=@{S="job#$jobId"}}|ConvertTo-Json -Compress
    $names=@{'#state'='state';'#request'='recoveryRequest';'#id'='id'}|ConvertTo-Json -Compress
    $values=@{':await'=@{S='awaiting_upload'};':queued'=@{S='queued'};':request'=@{S=$requestBody.request.id};
      ':token'=@{S='synthetic-cancellation-fixture'};':until'=@{N=([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+600000).ToString()}}|ConvertTo-Json -Compress
    $null=AwsJson @('dynamodb','update-item','--table-name',$table,'--key',$key,
      '--update-expression','SET #state = :queued, leaseToken = :token, leaseUntil = :until',
      '--condition-expression','#state = :await AND #request.#id = :request','--expression-attribute-names',$names,'--expression-attribute-values',$values)
    $machine=($stack.Outputs|Where-Object OutputKey -eq 'LabStateMachineArn').OutputValue
    $execution=AwsJson @('stepfunctions','start-execution','--state-machine-arn',$machine,'--name',"lab-$jobId",'--input',(@{jobId=$jobId}|ConvertTo-Json -Compress))
    $state=AwsJson @('stepfunctions','describe-execution','--execution-arn',$execution.executionArn,'--query','status')
    Check ($state -eq 'RUNNING') 'synthetic lease-fenced workflow is running without model access'
    $other=CallApi 'POST' "/jobs/$jobId/cancel" $b @{confirmRemoveUnfinishedAnalysis=$true}
    Check ($other.Status -eq 404) 'second user cannot cancel the active workflow'
    $invalid=CallApi 'POST' "/jobs/$jobId/cancel" $a @{confirmRemoveUnfinishedAnalysis=$false}
    Check ($invalid.Status -eq 400) 'cancellation requires explicit removal confirmation'
    $deleted=CallApi 'POST' "/jobs/$jobId/cancel" $a @{confirmRemoveUnfinishedAnalysis=$true}
    Check ($deleted.Status -eq 200 -and $deleted.Json.data.contractVersion -eq 'lab-cancellation/1' -and $deleted.Json.data.cancelled -eq $true) 'owned active job cancellation acknowledged'
    $state=AwsJson @('stepfunctions','describe-execution','--execution-arn',$execution.executionArn,'--query','status')
    Check ($state -eq 'ABORTED') 'AWS confirms the exact workflow stopped'
    $retry=CallApi 'POST' "/jobs/$jobId/cancel" $a @{confirmRemoveUnfinishedAnalysis=$true}
    Check ($retry.Status -eq 200 -and $retry.Json.data.cancelled -eq $true) 'lost cancellation acknowledgement can be retried'
  }else{
    $deleted=CallApi 'DELETE' "/jobs/$jobId" $a
    Check ($deleted.Status -eq 200) 'owned test job deleted without analysis'
  }
  if($TestUploadRoundTrip){
    $objectKey=[uri]::UnescapeDataString(([uri]$target.uploadUrl).AbsolutePath.TrimStart('/'))
    $remaining=AwsJson @('s3api','list-object-versions','--bucket',$documentBucket,'--prefix',$objectKey)
    $versions=@();$markers=@()
    if($remaining.PSObject.Properties.Name -contains 'Versions'){$versions=@($remaining.Versions)}
    if($remaining.PSObject.Properties.Name -contains 'DeleteMarkers'){$markers=@($remaining.DeleteMarkers)}
    Check ($versions.Count -eq 0 -and $markers.Count -eq 0) 'fixture object versions removed'
    if($TestLateUploadCleanup){
      Check ($deleted.Json.data.cleanupStatus -eq 'late_upload_watch') 'durable late-upload watch acknowledged'
      $ledger=AwsJson @('dynamodb','get-item','--table-name',$table,'--consistent-read','--key',(@{pk=@{S="cleanup#$jobId"}}|ConvertTo-Json -Compress))
      $names=@($ledger.Item.PSObject.Properties.Name|Sort-Object)
      Check (($names -join ',') -eq 'cleanupDue,cleanupPartition,contractVersion,lastVerifiedAt,organizationId,ownerSub,personId,pk,requestedAt') 'cleanup record contains metadata only and has no expiry'
      Check ((PutFixture $target $fixture) -eq 200) 'previously issued URL can produce a late fixture after deletion'
      $removedAutomatically=$false
      for($attempt=0;$attempt -lt 50;$attempt++){
        Start-Sleep -Seconds 5
        $remaining=AwsJson @('s3api','list-object-versions','--bucket',$documentBucket,'--prefix',$objectKey)
        $versions=@();$markers=@()
        if($remaining.PSObject.Properties.Name -contains 'Versions'){$versions=@($remaining.Versions)}
        if($remaining.PSObject.Properties.Name -contains 'DeleteMarkers'){$markers=@($remaining.DeleteMarkers)}
        if($versions.Count -eq 0 -and $markers.Count -eq 0){$removedAutomatically=$true;break}
      }
      Check $removedAutomatically 'late fixture removed automatically without a second delete request'
      $absent=CallApi 'GET' "/jobs/$jobId" $a
      Check ($absent.Status -eq 404) 'late upload does not resurrect the deleted analysis'
    }
  }
  $jobId=$null
  Write-Host "Hosted synthetic checks passed: $($passed.Count). Fixture upload enabled: $TestUploadRoundTrip. No AI generations, email sends, or real data."
}finally{
  if($jobId -and $tokens.Count){
    try{
      $cleanup=if($TestActiveCancellation){CallApi 'POST' "/jobs/$jobId/cancel" $tokens[0] @{confirmRemoveUnfinishedAnalysis=$true}}else{CallApi 'DELETE' "/jobs/$jobId" $tokens[0]}
      Write-Host "Test-job cleanup HTTP: $($cleanup.Status)"
    }catch{Write-Warning 'Test-job cleanup needs operator review; no forced deletion attempted.'}
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
