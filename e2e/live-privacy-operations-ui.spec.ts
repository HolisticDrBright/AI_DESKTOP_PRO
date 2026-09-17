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
