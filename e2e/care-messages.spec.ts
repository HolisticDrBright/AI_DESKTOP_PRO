import {test,expect,type Page} from '@playwright/test';
test.skip(process.env.E2E_CARE_MESSAGES!=='1','Dedicated synthetic care messaging UI run required.');
// UI-only fictional HTTP responses. This never certifies hosted AWS delivery.
const id='10000000-0000-4000-8000-000000000001',connectionId='10000000-0000-4000-8000-000000000002';
const thread={threadId:id,connectionId,patientRecordId:'10000000-0000-4000-8000-000000000003',sequence:'1',subject:'Fictional lesson question',createdAt:'2026-09-29T10:00:00Z',updatedAt:'2026-09-29T10:00:00Z'};
async function setup(page:Page){
 const origin='http://localhost:'+(process.env.E2E_PORT??'3114');
 await page.context().addCookies([{name:'aidp_at',value:'fictional-ui-only',url:origin},{name:'aidp_exp',value:String(Date.now()+3600000),url:origin}]);
 const state={refuse:0,failSend:true,sends:[] as Record<string,unknown>[],errors:[] as string[]};
 page.on('pageerror',error=>state.errors.push(error.message));
 await page.route('**/api/live/care-messages',async route=>{
  const input=route.request().postDataJSON();
  if(state.refuse){await route.fulfill({status:state.refuse,json:{error:'private-refusal-detail'}});return;}
  if(input.action==='send'){
   state.sends.push(input);
   if(state.failSend){state.failSend=false;await route.fulfill({status:503,json:{error:'private-error'}});return;}
   await route.fulfill({json:{data:{action:'send',threadId:id,messageId:id,duplicate:true,status:'stored',receivedAt:thread.createdAt}}});return;
  }
  await route.fulfill({json:{data:input.action==='list'?{action:'list',threads:[thread],nextBefore:null}:{action:'read',thread,messages:[{messageId:id,sequence:'1',body:'Fictional message from the app.',sender:'consumer',createdAt:thread.createdAt}],nextBefore:null}}});
 });
 await page.goto('/inbox');
 const panel=page.getByRole('region',{name:'Patient app messages'});
 await expect(panel).toBeVisible();
 await panel.getByRole('button',{name:'Load / refresh app messages'}).click();
 await panel.getByRole('button',{name:/Fictional lesson question/}).click();
 await expect(panel.getByText('Fictional message from the app.')).toBeVisible();
 await page.screenshot({path:test.info().outputPath('care-messages.png'),fullPage:false});
 return {state,panel};
}
test('reads the app thread and retries an interrupted reply without changing its key or content',async({page})=>{
 const {state,panel}=await setup(page);
 await panel.getByLabel('Reply to patient').fill('Fictional practitioner response.');
 await panel.getByRole('button',{name:'Send reply',exact:true}).click();
 await expect(panel.getByRole('alert')).toContainText('No delivery is confirmed');
 await expect(panel.getByLabel('Reply to patient')).toBeDisabled();
 await panel.getByRole('button',{name:'Retry same reply'}).click();
 await expect(panel.getByRole('status')).toContainText('does not mean the patient has read it');
 expect(state.sends).toHaveLength(2);expect(state.sends[0]).toEqual(state.sends[1]);expect(state.errors).toEqual([]);
});
test('removes opened messages and drafts on revoked authorization',async({page})=>{
 const {state,panel}=await setup(page);await panel.getByLabel('Reply to patient').fill('Private fictional draft.');
 state.refuse=403;
 await panel.getByRole('button',{name:'Send reply',exact:true}).click();
 await expect(panel.getByRole('alert')).toContainText('Access changed');
 await expect(panel.getByText('Fictional message from the app.')).toHaveCount(0);
 await expect(panel.getByLabel('Reply to patient')).toHaveCount(0);
 await expect(panel).not.toContainText('private-refusal-detail');
});
test('clears conversation text on a cross-tab session change',async({page})=>{
 const {panel}=await setup(page);
 await page.evaluate(()=>window.dispatchEvent(new Event('alp-workforce-session-change')));
 await expect(panel.getByText('Fictional message from the app.')).toHaveCount(0);
 await expect(panel.getByRole('alert')).toContainText('Session changed');
});
test('real proxy refuses missing session and cross-origin mutation',async({request,baseURL})=>{
 const same=await request.post('/api/live/care-messages',{headers:{origin:baseURL!},data:{action:'list'}});
 expect(same.status()).toBe(401);
 const other=await request.post('/api/live/care-messages',{headers:{origin:'https://example.org'},data:{action:'list'}});
 expect(other.status()).toBe(403);
});
