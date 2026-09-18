import {test,expect,type Page} from '@playwright/test';
test.skip(process.env.E2E_RECORDING_AWS!=='1','Isolated fictional recording harness only.');
const reviewEndpoint='**/api/live/recording-cleanup-review',executionEndpoint='**/api/live/recording-cleanup-execution';
const id=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const date='2026-09-17T00:00:00Z';
const reviewCapabilities={review:true,dispatch:false,storageDeletion:false};
const capabilities={boundedPass:true,scheduledDispatch:false,holdMutation:false,wholeRecordingErasure:false};
const queue={data:{items:[{recordingId:id(1),patientRecordId:id(99),version:3,reason:'discard',dueAt:date,nextCheckAt:date,
  leaseUntil:null,lastOutcome:null,consecutiveFailures:0,unresolvedAttempts:1,audioDeleted:false,requiresRecheck:true}],nextAfter:null},capabilities:reviewCapabilities};
const history={data:{recordingId:id(1),runs:[],nextAfter:null},capabilities:reviewCapabilities};
const panel=(page:Page)=>page.getByTestId('recording-cleanup-execution');
const confirm=(page:Page)=>panel(page).getByRole('checkbox');
async function open(page:Page){
  await page.route(reviewEndpoint,route=>route.fulfill({json:route.request().postDataJSON().action==='queue'?queue:history}));
  await page.goto('/settings/recording-cleanup');await page.getByRole('button',{name:'Load / refresh cleanup queue'}).click();
  await page.getByRole('button',{name:'Prepare cleanup for '+id(1)}).click();await expect(panel(page)).toBeVisible();
}
async function ready(page:Page){await open(page);await panel(page).getByRole('button',{name:'Check run history before cleanup'}).click();await confirm(page).check();}
test('requires history and explicit confirmation and renders a bounded result without an erasure claim',async({page},info)=>{
  const calls:Record<string,unknown>[]=[];const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route(executionEndpoint,async route=>{const body=route.request().postDataJSON();calls.push(body);await route.fulfill({json:{data:{runId:body.requestId,recordingId:body.recordingId,
    outcome:'needs_recheck',appliedToSchedule:true,nextCheckAt:date,audioDeleted:false,requiresRecheck:true},capabilities}});});
  await open(page);expect(calls).toEqual([]);await expect(confirm(page)).toBeDisabled();
  await expect(panel(page).getByRole('button',{name:'Run one bounded cleanup pass'})).toBeDisabled();
  await panel(page).getByRole('button',{name:'Check run history before cleanup'}).click();
  await expect(panel(page).getByRole('button',{name:'Run one bounded cleanup pass'})).toBeDisabled();
  await confirm(page).check();await panel(page).getByRole('button',{name:'Run one bounded cleanup pass'}).click();
  await expect(panel(page).getByRole('status')).toContainText('Whole-recording erasure is not confirmed');
  expect(calls).toEqual([{recordingId:id(1),version:3,requestId:expect.stringMatching(/^[a-f0-9-]{36}$/),confirmation:'run_bounded_cleanup_pass'}]);
  await expect(panel(page).getByRole('button',{name:/Run one|Retry same/})).toHaveCount(0);
  expect(await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}))).not.toContain(id(1));expect(errors).toEqual([]);
  await page.screenshot({path:info.outputPath('cleanup-execution-result.png'),fullPage:true});
});
test('lost response never automatically retries and an explicit retry preserves the exact request identifier',async({page})=>{
  const calls:Record<string,unknown>[]=[];await page.route(executionEndpoint,async route=>{const body=route.request().postDataJSON();calls.push(body);
    if(calls.length===1)await route.fulfill({status:503,json:{error:'PRIVATE PROVIDER DETAIL'}});
    else await route.fulfill({json:{data:{state:'already_claimed',runId:body.requestId,recordingId:body.recordingId,audioDeleted:false,requiresRecheck:true},capabilities}});
  });
  await ready(page);await panel(page).getByRole('button',{name:'Run one bounded cleanup pass'}).click();
  await expect(panel(page).getByRole('alert')).toContainText('outcome could not be verified');expect(calls).toHaveLength(1);
  await expect(page.getByText('PRIVATE PROVIDER DETAIL')).toHaveCount(0);
  await panel(page).getByRole('button',{name:'Retry same cleanup request'}).click();
  await expect(panel(page).getByRole('status')).toContainText('already claimed');expect(calls).toHaveLength(2);expect(calls[1]).toEqual(calls[0]);
});
test('failed or foreign history does not enable the confirmation',async({page})=>{
  await open(page);await page.route(reviewEndpoint,route=>route.fulfill({json:{...history,data:{...history.data,recordingId:id(5)}}}));
  await panel(page).getByRole('button',{name:'Check run history before cleanup'}).click();
  await expect(panel(page).getByRole('alert')).toContainText('History could not be verified');await expect(confirm(page)).toBeDisabled();
});
test('rejects a substituted receipt and preserves the same retry identifier',async({page})=>{
  await page.route(executionEndpoint,route=>route.fulfill({json:{data:{state:'already_claimed',runId:id(5),recordingId:id(1),audioDeleted:false,requiresRecheck:true},capabilities}}));
  await ready(page);await panel(page).getByRole('button',{name:'Run one bounded cleanup pass'}).click();
  await expect(panel(page).getByRole('alert')).toContainText('outcome could not be verified');await expect(panel(page).getByRole('status')).toHaveCount(0);
  await expect(panel(page).getByRole('button',{name:'Retry same cleanup request'})).toBeEnabled();
});
test('does not offer a new pass when reviewed history shows an active lease',async({page})=>{
  await open(page);await page.route(reviewEndpoint,route=>route.fulfill({json:{...history,data:{...history.data,runs:[{
    runId:id(7),version:3,claimedAt:date,leaseUntil:date,leaseActive:true,result:null,audioDeleted:false,requiresRecheck:true,
  }]}}}));
  await panel(page).getByRole('button',{name:'Check run history before cleanup'}).click();
  await expect(panel(page).getByText(/A recorded lease is active/)).toBeVisible();await expect(confirm(page)).toBeDisabled();
  await expect(panel(page).getByRole('button',{name:'Run one bounded cleanup pass'})).toBeDisabled();
});
test('missing browser request-ID capability does not leave the form stuck or send a request',async({page})=>{
  let calls=0;await page.route(executionEndpoint,async route=>{calls++;await route.abort();});await ready(page);
  await page.evaluate(()=>{Object.defineProperty(crypto,'randomUUID',{configurable:true,value:()=>{throw new Error('unavailable');}});});
  await panel(page).getByRole('button',{name:'Run one bounded cleanup pass'}).click();
  await expect(panel(page).getByRole('alert')).toContainText('No cleanup request was submitted');
  await expect(panel(page).getByRole('button',{name:'Run one bounded cleanup pass'})).toBeEnabled();expect(calls).toBe(0);
});
for(const event of ['alp-workforce-session-change','offline','pagehide','visibilitychange']){
  test('clears execution state on '+event+' and ignores a late acknowledgment',async({page})=>{
    await ready(page);await page.evaluate(()=>{const original=window.fetch;let release!:()=>void;
      window.fetch=(input,init)=>String(input).includes('/api/live/recording-cleanup-execution')?new Promise<Response>(resolve=>{const request=JSON.parse(String(init?.body));
        release=()=>resolve(Response.json({data:{state:'already_claimed',runId:request.requestId,recordingId:request.recordingId,audioDeleted:false,requiresRecheck:true},
          capabilities:{boundedPass:true,scheduledDispatch:false,holdMutation:false,wholeRecordingErasure:false}}));}):original(input,init);
      Object.assign(window,{releaseExecution:()=>release()});});
    await panel(page).getByRole('button',{name:'Run one bounded cleanup pass'}).click();await expect(panel(page).getByRole('button',{name:'Checking cleanup…'})).toBeVisible();
    await page.evaluate(event=>{if(event==='visibilitychange'){Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event(event));}
      else window.dispatchEvent(new Event(event));(window as unknown as {releaseExecution:()=>void}).releaseExecution();},event);
    await expect(panel(page)).toHaveCount(0);await expect(page.getByTestId('recording-cleanup-review').getByRole('status')).toContainText('Any submitted pass may continue');
    await expect(page.getByText(/This request was already claimed/)).toHaveCount(0);
  });
}
test('bounds a nonsettling submission and expires the whole selection without silently starting another',async({page})=>{
  await page.clock.install();await ready(page);
  await page.evaluate(()=>{const original=window.fetch;window.fetch=(input,init)=>String(input).includes('/api/live/recording-cleanup-execution')?new Promise(()=>{}):original(input,init);});
  await panel(page).getByRole('button',{name:'Run one bounded cleanup pass'}).click();await page.clock.fastForward(40001);
  await expect(panel(page).getByRole('alert')).toContainText('outcome could not be verified');await page.clock.fastForward(20001);
  await expect(panel(page)).toHaveCount(0);await expect(page.getByTestId('recording-cleanup-review').getByRole('status')).toContainText('snapshot expired');
});
test('reload restores no local clinical metadata and submits no automatic pass',async({page})=>{
  let calls=0;await page.route(executionEndpoint,async route=>{calls++;await route.fulfill({status:503,json:{error:'unavailable'}});});
  await ready(page);await panel(page).getByRole('button',{name:'Run one bounded cleanup pass'}).click();await expect(panel(page).getByRole('alert')).toBeVisible();
  await page.reload();await expect(panel(page)).toHaveCount(0);expect(calls).toBe(1);
  await expect(page.getByText('Cleanup history has not been loaded.')).toBeVisible();
});
test('the real execution proxy refuses fixture identity without a cookie',async({page})=>{
  await page.goto('/settings/recording-cleanup');const result=await page.evaluate(async ids=>{const response=await fetch('/api/live/recording-cleanup-execution',{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({recordingId:ids[0],version:1,requestId:ids[1],confirmation:'run_bounded_cleanup_pass'})});
    return {status:response.status,cache:response.headers.get('cache-control'),body:await response.json()};},[id(1),id(2)]);
  expect(result).toEqual({status:401,cache:'no-store',body:{error:{code:'unauthenticated'}}});
});
