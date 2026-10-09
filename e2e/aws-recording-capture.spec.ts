import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
test.skip(process.env.E2E_RECORDING_AWS !== '1', 'Dedicated AWS recording presentation configuration required.');
// Actual Chromium MediaRecorder + generated audio; fictional HTTP authority and
// object receipts. This is NOT hosted AWS, provider, consent or physical evidence.
const encounterId='11111111-1111-4111-8111-111111111111', recordingId='22222222-2222-4222-8222-222222222222';
const sessionId='33333333-3333-4333-8333-333333333333', patientId='aaaaaaaa-1111-2222-3333-444444444401';
const participantId='44444444-4444-4444-8444-444444444444', consentId='55555555-5555-4555-8555-555555555555';
const path=`/patients/${patientId}/encounter/${encounterId}`;
type Probe = Window & { captureTracks: MediaStreamTrack[]; captureRequests: number };
async function fixture(page:Page, refusal=false) {
  const chunks:Buffer[]=[], commands:Record<string,unknown>[]=[], starts:Record<string,unknown>[]=[];
  let version=0,status='capturing',disposition:string|null=null,withdrawn=false, stoppedAtWithdrawal=false;
  await page.addInitScript(()=>{
    const probe=window as unknown as Probe;probe.captureTracks=[];probe.captureRequests=0;
    const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia=async constraints=>{
      probe.captureRequests++; const stream=await original(constraints);
      probe.captureTracks.push(...stream.getTracks());return stream;
    };
  });
  await page.route('**/api/live/emr/encounter?*',route=>route.fulfill({json:{data:{
    encounter:{encounterId,patientId,status:'in_progress',appointmentId:null,visitType:null,startedAt:null,endedAt:null,statusReason:null},notes:[]}}}));
  await page.route('**/api/live/scribe/authority',async route=>{
    const q=route.request().postDataJSON();
    if(q.action==='withdrawConsent') {
      stoppedAtWithdrawal=await page.evaluate(()=>(window as unknown as Probe).captureTracks.every(t=>t.readyState==='ended'));
      withdrawn=true; await route.fulfill({json:{data:{withdrawn:true},capabilities:{consentManagement:true,audioCapture:false,reason:'audio_transport_not_configured'}}});return;
    }
    expect(q.action).toBe('workspace');
    await route.fulfill({json:{data:{encounterId,encounterStatus:'in_progress',activeCapture:null,consentReleases:[],participants:[{
      id:participantId,kind:'patient',displayName:'Fictional Participant',canSelfConsent:true,joinedAt:new Date().toISOString(),
      consents:[{id:consentId,scope:'recording',releaseId:sessionId,status:withdrawn?'withdrawn':'granted',effective:!withdrawn,
        grantedAt:new Date().toISOString(),withdrawnAt:withdrawn?new Date().toISOString():null}]}]},
      capabilities:{consentManagement:true,audioCapture:false,reason:'audio_transport_not_configured'}}});
  });
  await page.route('**/api/live/scribe/capture/*',async route=>{
    const req=route.request(),op=new URL(req.url()).pathname.split('/').at(-1);
    const now=Date.now(),expiry=new Date(now+120000).toISOString(),deadline=new Date(now+3600000).toISOString();
    if(refusal || withdrawn && ['readiness','start','segment'].includes(op!)) {await route.fulfill({status:403,json:{error:'DO NOT RENDER RAW DETAILS'}});return;}
    let data:unknown;
    if(op==='segment') {
      const bytes=req.postDataBuffer()!;expect(bytes.length).toBeGreaterThan(0);
      expect(req.headers()['x-alp-sequence']).toBe(String(chunks.length));
      const sha256=createHash('sha256').update(bytes).digest('hex');expect(req.headers()['x-alp-sha256']).toBe(sha256);
      chunks.push(bytes);data={segmentId:consentId,recordingId,sequence:chunks.length-1,sha256,bytes:bytes.length,authorityEpoch:1,status:'stored'};
    } else {
      const q=req.postDataJSON();
      if(op==='readiness')data={encounterId,ready:true,authorityEpoch:1,checkedAt:new Date(now).toISOString(),expiresAt:new Date(now+30000).toISOString(),
        maxRecordingBytes:10000000,maxSegmentBytes:1000000,maxSegments:4096,audioRetentionHours:24,contentTypes:['audio/webm'],captureStarted:false,processingRequested:false};
      else if(op==='start'){starts.push(q);data={...q,recordingId,sessionId,status:'capturing',replayed:false,captureToken:'a'.repeat(64),credentialVersion:0,authorityEpoch:1,expiresAt:expiry,deletionDeadline:deadline};}
      else if(op==='state')data={recordingId,sessionId,status,credentialVersion:version,authorityEpoch:1,currentAuthorityEpoch:1,tokenExpiresAt:expiry,
        deletionDeadline:deadline,storedSegments:chunks.length,pendingSegments:0,reservedBytes:chunks.reduce((n,b)=>n+b.length,0),nextSequence:chunks.length,
        inventorySha256:'b'.repeat(64),disposition,processingRequested:false,audioDeleted:false};
      else if(op==='command') {
        commands.push(q);expect(q.expectedVersion).toBe(version);version++;
        status=q.action==='pause'?'paused':['finish','discard'].includes(q.action)?'closed':'capturing';
        if(status==='closed'){expect(q.inventorySha256).toBe('b'.repeat(64));disposition=q.action;}
        data={...q,statusAtCommand:status,credentialVersion:version,expiresAt:expiry,processingRequested:false,audioDeleted:false,replayed:false,
          captureToken:status==='capturing'?'a'.repeat(64):null,requiresCredentialRecovery:false};delete (data as Record<string,unknown>).expectedVersion;
      } else throw new Error('Unexpected capture operation');
    }
    await route.fulfill({json:{data}});
  });
  await page.goto(path);
  await page.getByLabel('Consent locale').fill('en-US');await page.getByLabel('Reviewed jurisdiction').fill('FICTIONAL');
  await page.getByRole('button',{name:'Load consent workspace'}).click();
  await expect(page.getByRole('button',{name:'Check recording readiness'})).toBeEnabled();
  const start=async()=>{
    await page.getByRole('button',{name:'Check recording readiness'}).click();
    await page.getByRole('checkbox',{name:/I understand the unsent-audio loss risk/}).check();
    await page.getByRole('button',{name:'Start recording',exact:true}).click();
    await expect(page.getByTestId('aws-capture-status')).toHaveText('Recording');
    await expect.poll(()=>page.evaluate(()=>(window as unknown as Probe).captureTracks.some(t=>t.readyState==='live'))).toBe(true);
  };
  return {chunks,commands,starts,start,stoppedAtWithdrawal:()=>stoppedAtWithdrawal};
}
const stopped=(page:Page)=>expect.poll(()=>page.evaluate(()=>(window as unknown as Probe).captureTracks.every(t=>t.readyState==='ended'))).toBe(true);

test('requires successful readiness and explicit acknowledgment before any microphone request',async({page})=>{
  await fixture(page,true);await page.getByRole('button',{name:'Check recording readiness'}).click();
  await expect(page.getByRole('alert').filter({hasText:'Recording access or consent was refused'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Start recording',exact:true})).toHaveCount(0);
  expect(await page.evaluate(()=>(window as unknown as Probe).captureRequests)).toBe(0);
  await expect(page.getByText('DO NOT RENDER RAW DETAILS')).toHaveCount(0);
});
test('records actual generated chunks, pauses, resumes one container and finishes all receipts',async({page},info)=>{
  const f=await fixture(page);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.getByRole('button',{name:'Check recording readiness'}).click();
  await expect(page.getByRole('button',{name:'Start recording',exact:true})).toBeDisabled();
  expect(await page.evaluate(()=>(window as unknown as Probe).captureRequests)).toBe(0);
  await f.start();await expect.poll(()=>f.chunks.length).toBeGreaterThan(0);
  await page.getByRole('button',{name:'Pause recording',exact:true}).click();await stopped(page);
  await expect(page.getByRole('button',{name:'Resume recording',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Resume recording',exact:true}).click();
  await expect(page.getByTestId('aws-capture-status')).toHaveText('Recording');
  await page.getByRole('button',{name:'Finish recording',exact:true}).click();
  await expect(page.getByTestId('aws-capture-status')).toHaveText('Capture finished');await stopped(page);
  expect(f.starts).toHaveLength(1);expect(f.commands.map(c=>c.action)).toEqual(['pause','resume','finish']);
  const bytes=Buffer.concat(f.chunks);expect(bytes.subarray(0,4).toString('hex')).toBe('1a45dfa3');
  expect(bytes.indexOf(Buffer.from('1a45dfa3','hex'),4)).toBe(-1);
  await expect(page.getByTestId('aws-capture-receipts')).toContainText('Buffered bytes: 0');
  expect(errors).toEqual([]);await page.screenshot({path:info.outputPath('aws-capture-finished.png'),fullPage:true});
});
test('stops before consent withdrawal and preserves the capture across workspace reload',async({page})=>{
  const f=await fixture(page);await f.start();await expect.poll(()=>f.chunks.length).toBeGreaterThan(0);
  await page.getByLabel('Withdrawal reason').fill('Fictional withdrawal');
  await page.getByRole('button',{name:'Withdraw recording consent for Fictional Participant'}).click();
  await expect.poll(f.stoppedAtWithdrawal).toBe(true);await stopped(page);
  await expect(page.getByTestId('aws-capture-receipts')).toBeVisible();
  expect(f.starts).toHaveLength(1);expect(f.commands.filter(c=>c.action==='finish')).toHaveLength(0);
});
test('workforce invalidation clears local capture and cannot auto-resume',async({page})=>{
  const f=await fixture(page);await f.start();
  const other=await page.context().newPage();await other.goto('/today');
  await other.evaluate(()=>localStorage.setItem('alp-workforce-session-change',crypto.randomUUID()));
  await expect(page.getByRole('alert').filter({hasText:'Your workforce session changed'})).toBeVisible();await stopped(page);
  await expect(page.getByRole('button',{name:'Resume recording',exact:true})).toHaveCount(0);
  expect(f.starts).toHaveLength(1);await other.close();
});
test('uncertain binary request retains exact bytes and retries explicitly without restarting the microphone',async({page})=>{
  const f=await fixture(page),requests:{bytes:Buffer;headers:Record<string,string>}[]=[];
  await page.route('**/api/live/scribe/capture/segment',async route=>{
    requests.push({bytes:route.request().postDataBuffer()!,headers:route.request().headers()});
    if(requests.length===1)await route.fulfill({status:503,json:{error:'fictional failure'}});
    else await route.fallback();
  });
  await f.start();await expect(page.getByRole('button',{name:'Retry original recording request'})).toBeVisible();await stopped(page);
  await page.getByRole('button',{name:'Retry original recording request'}).click();
  await expect(page.getByTestId('aws-capture-status')).toHaveText('Paused — microphone off');
  expect(requests).toHaveLength(2);expect(requests[0].bytes.equals(requests[1].bytes)).toBe(true);
  for(const header of ['x-alp-sequence','x-alp-sha256','x-alp-capture-token','x-alp-session-id'])
    expect(requests[0].headers[header]).toBe(requests[1].headers[header]);
  expect(f.chunks).toHaveLength(1);await stopped(page);
  await page.getByRole('button',{name:'Finish recording',exact:true}).click();
  await expect(page.getByTestId('aws-capture-status')).toHaveText('Capture finished');
});
test('cancels a pending start, stops permission tracks and never auto-constructs a recorder after late success',async({page})=>{
  await fixture(page);
  let started=false,release:()=>void=()=>{};
  const hold=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/api/live/scribe/capture/start',async route=>{
    started=true;await hold;await route.fallback().catch(()=>{});
  });
  await page.getByRole('button',{name:'Check recording readiness'}).click();
  await page.getByRole('checkbox',{name:/I understand the unsent-audio loss risk/}).check();
  await page.getByRole('button',{name:'Start recording',exact:true}).click();
  await expect.poll(()=>started).toBe(true);
  await page.getByRole('button',{name:'Cancel pending recording action'}).click();
  await expect(page.getByTestId('aws-capture-status')).toHaveText('Outcome uncertain — microphone off');await stopped(page);
  release();
  await expect(page.getByRole('button',{name:'Retry original recording request'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Start recording',exact:true})).toHaveCount(0);
});
test('offline interrupt stops tracks; leaving the encounter disposes the capture owner',async({page})=>{
  const f=await fixture(page);await f.start();
  await page.evaluate(()=>window.dispatchEvent(new Event('offline')));await stopped(page);
  await expect(page.getByTestId('aws-capture-status')).toHaveText('Paused — microphone off');
  await page.getByRole('link',{name:'Today',exact:true}).first().click();
  await expect(page.getByRole('region',{name:'AWS audio capture'})).toHaveCount(0);await stopped(page);
});
