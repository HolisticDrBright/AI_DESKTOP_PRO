import {test,expect,type Page} from '@playwright/test';
test.skip(process.env.E2E_RECORDING_AWS!=='1','Uses the isolated AWS recording presentation harness.');
// Fictional HTTP receipts. The real cookie refusal is tested separately below;
// actual reviewed-operator SQL authorization has canonical database tests.
const endpoint='**/api/live/recording-cleanup-review';
const id=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const date='2026-09-17T00:00:00Z';
const capabilities={review:true,dispatch:false,storageDeletion:false};
const item=(n=1)=>({recordingId:id(n),patientRecordId:id(999),version:1,reason:'discard',dueAt:date,nextCheckAt:date,
  leaseUntil:null,lastOutcome:null,consecutiveFailures:0,unresolvedAttempts:2,audioDeleted:false,requiresRecheck:true});
const queue={data:{items:[item()],nextAfter:null},capabilities};
const history={data:{recordingId:id(1),runs:[{runId:id(2),version:1,claimedAt:date,leaseUntil:date,leaseActive:false,
  result:{outcome:'unavailable',deleteAcknowledged:null,recordedAt:date,appliedToSchedule:false,nextCheckAt:null},audioDeleted:false,requiresRecheck:true}],nextAfter:null},capabilities};
async function open(page:Page){await page.goto('/settings/recording-cleanup');await expect(page.getByRole('heading',{name:'Recording cleanup review',exact:true})).toBeVisible();}
const load=(page:Page)=>page.getByRole('button',{name:'Load / refresh cleanup queue'}).click();
const review=(page:Page)=>page.getByTestId('recording-cleanup-review');
test('Settings links to read-only queue and history with honest unknown outcomes',async({page},info)=>{
  const calls:unknown[]=[];const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route(endpoint,async route=>{const body=route.request().postDataJSON();calls.push(body);await route.fulfill({json:body.action==='queue'?queue:history});});
  await page.goto('/settings');await page.getByRole('link',{name:/Recording cleanup review/}).click();
  await expect(page.getByRole('heading',{name:'Recording cleanup review',exact:true})).toBeVisible();
  expect(calls).toEqual([]);await load(page);
  await expect(page.getByRole('heading',{name:'Recording '+id(1),exact:true})).toBeVisible();
  await expect(page.getByText('No run outcome recorded · unresolved version attempts: 2')).toBeVisible();
  await page.getByRole('button',{name:'Review runs for '+id(1)}).click();
  await expect(page.getByRole('heading',{name:'Run history',exact:true})).toBeVisible();
  await expect(page.getByText('Exact-version delete acknowledgments: Unknown. Whole-recording erasure: not confirmed.')).toBeVisible();
  await expect(page.getByText('Patient reference: '+id(999))).toHaveCount(0);
  await expect(page.getByRole('button',{name:/^(Delete|Run worker|Remove hold|Approve)/})).toHaveCount(0);
  expect(calls).toEqual([{action:'queue'},{action:'history',recordingId:id(1)}]);expect(errors).toEqual([]);
  expect(await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}))).not.toContain(id(1));
  await page.screenshot({path:info.outputPath('recording-cleanup-history.png'),fullPage:true});
});
test('paginates without retaining prior pages or asserting complete erasure',async({page})=>{
  const calls:unknown[]=[];await page.route(endpoint,async route=>{const body=route.request().postDataJSON();calls.push(body);
    await route.fulfill({json:{data:body.after?{items:[],nextAfter:null}:{items:Array.from({length:25},(_,i)=>item(i+1)),nextAfter:id(25)},capabilities}});});
  await open(page);await load(page);await page.getByRole('button',{name:'Next queue page'}).click();
  await expect(page.getByText(/No queued recordings were returned/)).toBeVisible();
  await expect(page.getByText(/This is not confirmation that all recordings were deleted/)).toBeVisible();
  await expect(page.getByRole('button',{name:/Review runs for/})).toHaveCount(0);
  expect(calls).toEqual([{action:'queue'},{action:'queue',after:id(25)}]);
});
test('error and forbidden responses do not become empty queues or expose upstream details',async({page})=>{
  let status=503;await page.route(endpoint,route=>route.fulfill({status,json:{error:{message:'DO_NOT_DISPLAY_PRIVATE_DETAIL'}}}));
  await open(page);await load(page);await expect(review(page).getByRole('alert')).toContainText('No cleanup completion is confirmed');
  await expect(page.getByText(/No queued recordings were returned/)).toHaveCount(0);
  status=403;await load(page);await expect(review(page).getByRole('alert')).toContainText('reviewed cleanup-operator assignment');
  status=401;await load(page);await expect(review(page).getByRole('alert')).toContainText('Sign in again');
  await expect(page.getByText('DO_NOT_DISPLAY_PRIVATE_DETAIL')).toHaveCount(0);
});
test('refuses mismatched history and unsupported deletion claims',async({page})=>{
  await page.route(endpoint,route=>route.fulfill({json:route.request().postDataJSON().action==='queue'?queue:
    {...history,data:{...history.data,recordingId:id(3)}}}));
  await open(page);await load(page);await page.getByRole('button',{name:'Review runs for '+id(1)}).click();
  await expect(review(page).getByRole('alert')).toContainText('response could not be verified');
  await expect(page.getByRole('heading',{name:'Run history',exact:true})).toHaveCount(0);
});
for(const event of ['alp-workforce-session-change','offline','pagehide','visibilitychange']){
  test('clears sensitive review on '+event,async({page})=>{
    await page.route(endpoint,route=>route.fulfill({json:queue}));await open(page);await load(page);
    await expect(page.getByText('Patient reference: '+id(999))).toBeVisible();
    await page.evaluate(event=>{if(event==='visibilitychange'){Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event(event));}
      else window.dispatchEvent(new Event(event));},event);
    await expect(page.getByText('Patient reference: '+id(999))).toHaveCount(0);await expect(review(page).getByRole('status')).toContainText('Review cleared');
  });
}
test('session invalidation refuses a late response even when fetch ignores cancellation',async({page})=>{
  await open(page);
  await page.evaluate(queue=>{const original=window.fetch;let release!:()=>void;
    window.fetch=(input,init)=>String(input).includes('/api/live/recording-cleanup-review')?new Promise<Response>(resolve=>{release=()=>resolve(new Response(JSON.stringify(queue),{headers:{'content-type':'application/json'}}));}):original(input,init);
    Object.assign(window,{releaseCleanupResponse:()=>release()});},queue);
  await load(page);await expect(page.getByRole('button',{name:'Loading review…'})).toBeVisible();
  await page.evaluate(()=>{window.dispatchEvent(new Event('alp-workforce-session-change'));(window as unknown as {releaseCleanupResponse:()=>void}).releaseCleanupResponse();});
  await expect(review(page).getByRole('status')).toContainText('Review cleared');await expect(page.getByText('Patient reference: '+id(999))).toHaveCount(0);
});
test('expires snapshots and independently bounds a never-settling request',async({page})=>{
  await page.route(endpoint,route=>route.fulfill({json:queue}));await open(page);await page.clock.install();await load(page);
  await expect(page.getByText('Patient reference: '+id(999))).toBeVisible();await page.clock.fastForward(60001);
  await expect(review(page).getByRole('status')).toContainText('snapshot expired');await expect(page.getByText('Patient reference: '+id(999))).toHaveCount(0);
  await page.evaluate(()=>{const original=window.fetch;window.fetch=(input,init)=>String(input).includes('/api/live/recording-cleanup-review')?new Promise(()=>{}):original(input,init);});
  await load(page);await page.clock.fastForward(20001);await expect(review(page).getByRole('alert')).toContainText('No cleanup completion is confirmed');
  await expect(page.getByRole('button',{name:'Load / refresh cleanup queue'})).toBeEnabled();
});
test('real proxy refuses fixture identity without a workforce cookie',async({page})=>{
  await open(page);const result=await page.evaluate(async()=>{const response=await fetch('/api/live/recording-cleanup-review',{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'queue'})});
    return {status:response.status,cache:response.headers.get('cache-control'),data:await response.json()};});
  expect(result).toEqual({status:401,cache:'no-store',data:{error:{code:'unauthenticated'}}});
});
