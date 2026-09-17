import {test,expect} from '@playwright/test';
// Browser presentation contract only: fictional HTTP responses. Real API/SQL
// ownership and resolution are exercised by owned-privacy-safety.database.test.
const id='11111111-1111-4111-8111-111111111111',owner='22222222-2222-4222-8222-222222222222';
const row={privacyRequestId:id,ownerId:owner,kind:'correction',status:'submitted',
  submittedAt:'2026-09-17T00:00:00Z',updatedAt:'2026-09-17T00:00:00Z'};
const detail={...row,legalHold:false,fulfillment:[],correction:{target:{collection:'wellness_profiles',
  recordId:'33333333-3333-4333-8333-333333333333',expectedRevision:1,expectedPayloadSha256:'a'.repeat(64),
  field:'height_cm',requestSha256:'b'.repeat(64)},reason:'Fictional height entry correction',requestedValue:180,
  originalAvailable:true,originalValue:170,currentRevision:2,currentDeleted:false,currentValue:180,resolution:null}};
test('privacy UI distinguishes sign-in refusal from an empty queue',async({page})=>{
  await page.route('**/api/live/privacy-operations',route=>route.fulfill({status:401,json:{error:'reauth_required'}}));
  const response=await page.goto('/settings/privacy-operations');
  expect(response?.headers()['content-security-policy']).toContain("connect-src 'self'");
  expect(response?.headers()['referrer-policy']).toBe('no-referrer');
  await expect(page.getByRole('heading',{name:'Privacy operations',exact:true})).toBeVisible();
  await expect(page.getByText('Request history has not been loaded.')).toBeVisible();
  await page.getByRole('button',{name:'Load / refresh assigned requests'}).click();
  await expect(page.getByRole('alert').filter({hasText:'Sign out and sign in again'})).toBeVisible();
  await expect(page.getByText('No assigned requests match this view.')).toHaveCount(0);
});
test('reviews exact fictional fields and requires confirmation before verified resolution',async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const calls:Record<string,unknown>[]=[];
  await page.route('**/api/live/privacy-operations',async route=>{
    const body=route.request().postDataJSON();calls.push(body);
    const data=body.action==='list'?{items:[row],nextAfter:null}:body.action==='detail'?detail:
      {...detail,status:'completed',correction:{...detail.correction,resolution:{outcome:'applied',appliedRevision:2,
        appliedPayloadSha256:'c'.repeat(64),evidenceSha256:'d'.repeat(64),explanation:body.explanation,resolvedAt:'2026-09-17T01:00:00Z'}}};
    await route.fulfill({json:{data}});
  });
  await page.goto('/settings/privacy-operations');
  await page.getByRole('button',{name:'Load / refresh assigned requests'}).click();
  await page.getByRole('button',{name:'Review request'}).click();
  await expect(page.getByText('Fictional height entry correction')).toBeVisible();
  await page.getByLabel('Saved successor revision').fill('2');
  await page.getByLabel('Explanation visible to the consumer').fill('Verified fictional change');
  const save=page.getByRole('button',{name:'Record verified decision'});
  await expect(save).toBeDisabled();
  await page.getByRole('checkbox',{name:/I reviewed this exact request/}).check();
  await expect(save).toBeEnabled();
  await page.screenshot({path:info.outputPath('privacy-review.png'),fullPage:true});
  await save.click();
  await expect(page.getByRole('status').filter({hasText:'Decision verified and recorded'})).toBeVisible();
  expect(calls.filter(c=>c.action==='resolve')).toEqual([{action:'resolve',privacyRequestId:id,outcome:'applied',
    appliedRevision:2,explanation:'Verified fictional change'}]);
  await expect(save).toHaveCount(0);
  expect(errors).toEqual([]);
  await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));});
  await expect(page.getByRole('heading',{name:'Request review'})).toHaveCount(0);
});
test('held requests remain readable but cannot be resolved',async({page})=>{
  await page.route('**/api/live/privacy-operations',async route=>{
    const body=route.request().postDataJSON();
    await route.fulfill({json:{data:body.action==='list'?{items:[{...row,status:'held'}],nextAfter:null}:{...detail,status:'held',legalHold:true}}});
  });
  await page.goto('/settings/privacy-operations');
  await page.getByRole('button',{name:'Load / refresh assigned requests'}).click();
  await page.getByRole('button',{name:'Review request'}).click();
  await expect(page.getByRole('alert').filter({hasText:'Legal hold active'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Record verified decision'})).toHaveCount(0);
});

test('personal purge requires the exact preview and confirmation, retaining the command after an uncertain response',async({page},info)=>{
  const calls:Record<string,unknown>[]=[],errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const deletion={...row,kind:'deletion'};
  const preview={privacyRequestId:id,policyVersion:'fictional-policy',policySha256:'a'.repeat(64),inventorySha256:'b'.repeat(64),
    records:4,consents:2,activePlans:1,planHistory:3,completeAccountDeletion:false,policyContent:'Fictional reviewed purge policy — test only.'};
  await page.route('**/api/live/privacy-operations',async route=>{
    const body=route.request().postDataJSON();calls.push(body);
    if(body.action==='purgePersonal'&&calls.filter(c=>c.action==='purgePersonal').length===1){
      await route.fulfill({status:503,json:{error:'service_unavailable'}});return;
    }
    const base=Object.fromEntries(Object.entries(preview).filter(([key])=>key!=='policyContent'));
    const data=body.action==='list'?{items:[deletion],nextAfter:null}:body.action==='detail'?{...deletion,legalHold:false,fulfillment:[],correction:null}:
      body.action==='previewPersonalPurge'?preview:{...base,commandId:body.commandId,outcome:'purged',verifiedAt:'2026-09-17T01:00:00Z',evidenceSha256:'c'.repeat(64)};
    await route.fulfill({json:{data}});
  });
  await page.goto('/settings/privacy-operations');
  await page.getByRole('button',{name:'Load / refresh assigned requests'}).click();
  await page.getByRole('button',{name:'Review request'}).click();
  await page.getByLabel('Approved purge policy version').fill('fictional-policy');
  await page.getByRole('button',{name:'Preview exact deletion'}).click();
  await expect(page.getByText(preview.policyContent)).toBeVisible();
  const save=page.getByRole('button',{name:'Confirm personal-history deletion / retry same command'});
  await expect(save).toBeDisabled();
  await page.getByLabel('Type PURGE PERSONAL HISTORY').fill('yes');await expect(save).toBeDisabled();
  await page.getByLabel('Type PURGE PERSONAL HISTORY').fill('PURGE PERSONAL HISTORY');
  await page.screenshot({path:info.outputPath('privacy-purge-preview.png'),fullPage:true});
  await save.click();
  await expect(page.getByRole('alert').filter({hasText:'No completion is confirmed'})).toBeVisible();
  await save.click();
  await expect(page.getByText('Complete account deletion: no.')).toBeVisible();
  const commands=calls.filter(c=>c.action==='purgePersonal');expect(commands).toHaveLength(2);expect(commands[0]).toEqual(commands[1]);
  expect(commands[0]).toMatchObject({privacyRequestId:id,policySha256:preview.policySha256,inventorySha256:preview.inventorySha256,confirmation:'PURGE PERSONAL HISTORY'});
  await expect(save).toHaveCount(0);expect(errors).toEqual([]);
  await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));});
  await expect(page.getByText('Complete account deletion: no.')).toHaveCount(0);
});

test('a stale deletion preview is discarded, and held deletion requests offer no purge action',async({page})=>{
  let held=false;
  const deletion={...row,kind:'deletion'};
  await page.route('**/api/live/privacy-operations',async route=>{
    const body=route.request().postDataJSON();
    if(body.action==='purgePersonal'){await route.fulfill({status:409,json:{error:'conflict'}});return;}
    const data=body.action==='list'?{items:[deletion],nextAfter:null}:body.action==='detail'?{...deletion,legalHold:held,fulfillment:[],correction:null}:
      {privacyRequestId:id,policyVersion:'fictional',policySha256:'a'.repeat(64),inventorySha256:'b'.repeat(64),records:1,consents:1,activePlans:0,planHistory:0,
        completeAccountDeletion:false,policyContent:'Fictional policy'};
    await route.fulfill({json:{data}});
  });
  await page.goto('/settings/privacy-operations');
  await page.getByRole('button',{name:'Load / refresh assigned requests'}).click();await page.getByRole('button',{name:'Review request'}).click();
  await page.getByLabel('Approved purge policy version').fill('fictional');await page.getByRole('button',{name:'Preview exact deletion'}).click();
  await page.getByLabel('Type PURGE PERSONAL HISTORY').fill('PURGE PERSONAL HISTORY');
  await page.getByRole('button',{name:'Confirm personal-history deletion / retry same command'}).click();
  await expect(page.getByRole('alert').filter({hasText:'inventory or policy changed'})).toBeVisible();
  await expect(page.getByLabel('Type PURGE PERSONAL HISTORY')).toHaveCount(0);
  held=true;await page.getByRole('button',{name:'Refresh deletion request'}).click();
  await expect(page.getByRole('alert').filter({hasText:'Legal hold active'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Preview exact deletion'})).toHaveCount(0);
});
