import {test,expect,type Page} from '@playwright/test';
test.skip(process.env.E2E_ONBOARDING!=='1','Dedicated practitioner onboarding UI run required.');
// UI-only fictional HTTP responses for the applicant journey and the clinic's join-request queue. This never certifies
// a hosted applicant API, a Cognito account, a clinic approval or any clinical access.
const requestId='20000000-0000-4000-8000-000000000001',clinic='20000000-0000-4000-8000-000000000002',membership='20000000-0000-4000-8000-000000000003';
const entry=(status:string,extra:Record<string,unknown>={})=>({id:requestId,kind:'join',status,createdAt:'2026-10-15T12:00:00Z',organizationId:clinic,
 decisionReason:null,clinicalAccess:status==='approved'?'unknown':null,...extra});
async function signIn(page:Page){
 const origin='http://localhost:'+(process.env.E2E_PORT??'3114');
 await page.context().addCookies([{name:'aidp_at',value:'fictional-ui-only',url:origin},{name:'aidp_exp',value:String(Date.now()+3600000),url:origin}]);
}
type Answer={status:number;json:unknown}|'abort';
async function application(page:Page,answers:{get:Answer[];post?:Answer[]}){
 const posts:Record<string,unknown>[]=[];
 await page.route('**/api/onboarding/application',async route=>{
  if(route.request().method()==='POST'){
   posts.push(route.request().postDataJSON());
   const next=answers.post?.shift()??{status:503,json:{error:'workforce_application_unavailable'}};
   if(next==='abort'){await route.abort('connectionreset');return;}
   await route.fulfill(next);return;
  }
  const next=answers.get.length>1?answers.get.shift()!:answers.get[0]!;
  if(next==='abort'){await route.abort('connectionreset');return;}
  await route.fulfill(next);
 });
 return posts;
}
const answered=(entries:unknown[],clinicSignIn='current_membership',clinicIds:string[]|null=null)=>({status:200,json:{data:{entries,clinicSignIn,clinicIds}}});

test('with no applicant service, says applications are not open instead of showing no application',async({page})=>{
 await signIn(page);
 await page.goto('/apply');
 await expect(page.getByTestId('applicant-state')).toHaveText("Applications aren't open in this app yet.");
 await expect(page.getByTestId('applicant-steps')).toContainText('Unknown');
 await expect(page.getByTestId('applicant-submit')).toHaveCount(0);
 await expect(page.getByText("You haven't created or joined a clinic yet.")).toHaveCount(0);
});

test('a failed read is never "no application", and an account problem is the account\'s own next step',async({page})=>{
 await signIn(page);
 await application(page,{get:[{status:500,json:{error:'workforce_application_unavailable'}},{status:403,json:{error:'workforce_applicant_mfa_required'}}]});
 await page.goto('/apply');
 await expect(page.getByTestId('applicant-state')).toHaveText("We couldn't check your application.");
 await expect(page.getByText("You haven't created or joined a clinic yet.")).toHaveCount(0);
 await page.getByRole('button',{name:'Check again'}).click();
 await expect(page.getByTestId('applicant-state')).toHaveText("Multi-factor authentication isn't set up.");
 await expect(page.getByTestId('applicant-steps')).toContainText('Not set up');
 await expect(page.getByRole('button',{name:'Send request'})).toHaveCount(0);
});

test('proposes a clinic by keyboard while creating one is not open, and a lost reply is resent as the same request',async({page})=>{
 await signIn(page);
 const posts=await application(page,{get:[answered([]),answered([]),answered([entry('pending',{kind:'create_clinic',organizationId:null})])],
  post:['abort',{status:202,json:{data:{requestId,status:'pending'}}}]});
 await page.goto('/apply');
 await expect(page.getByTestId('applicant-state')).toHaveText("You haven't created or joined a clinic yet.");
 const create=page.getByRole('radio',{name:'Create a new clinic'});
 await page.getByRole('radio',{name:'Request to join an existing clinic'}).check();
 await page.getByRole('radio',{name:'Request to join an existing clinic'}).focus();
 await page.keyboard.press('ArrowUp');
 await expect(create).toBeChecked();
 await expect(page.getByTestId('create-not-offered')).toContainText("Creating a clinic directly isn't open in this app yet.");
 await page.getByLabel('Proposed clinic name').fill('Fictional Proposed Clinic');
 await page.keyboard.press('Enter');
 await expect(page.getByTestId('applicant-journey').getByRole('alert')).toContainText('No answer arrived');
 await page.getByRole('button',{name:'Send proposal'}).press('Enter');
 await expect(page.getByTestId('applicant-state')).toHaveText('Your new-clinic proposal is waiting for review.');
 await expect(page.getByTestId('applicant-state')).toBeFocused();
 expect(posts).toHaveLength(2);
 expect(posts[0]).toEqual(posts[1]);
 expect(posts[0]).toMatchObject({action:'submit',kind:'create_clinic',proposedLabel:'Fictional Proposed Clinic'});
 expect(Object.keys(posts[0]!).sort()).toEqual(['action','kind','proposedLabel','requestId']);
});

test('a pending join shows its reference and withdraws only after confirmation',async({page})=>{
 await signIn(page);
 const posts=await application(page,{get:[answered([entry('pending')]),answered([entry('withdrawn')])],post:[{status:200,json:{data:{withdrawn:true,duplicate:false}}}]});
 await page.goto('/apply');
 await expect(page.getByTestId('applicant-state')).toHaveText('Your request is waiting for the clinic.');
 await expect(page.getByText(/Reference 20000000/)).toBeVisible();
 await page.getByRole('button',{name:'Withdraw request 20000000'}).click();
 await page.getByRole('group',{name:'Confirm withdrawing request 20000000'}).getByRole('button',{name:'Keep it'}).click();
 expect(posts).toHaveLength(0);
 await page.getByRole('button',{name:'Withdraw request 20000000'}).click();
 await page.getByRole('button',{name:'Yes, withdraw'}).click();
 await expect(page.getByTestId('applicant-state')).toHaveText('You withdrew your request.');
 expect(posts).toEqual([{action:'withdraw',requestId}]);
});

test('an approval is clinical access only when this Desktop and this session say so too',async({page})=>{
 await signIn(page);
 await application(page,{get:[answered([entry('approved',{clinicalAccess:'available',decisionReason:'identity_confirmed_by_clinic'})],'legacy_claims'),
  answered([entry('approved',{clinicalAccess:'held_for_clinic_activation',kind:'create_clinic'})]),
  answered([entry('approved',{clinicalAccess:'available',decisionReason:'identity_confirmed_by_clinic'})],'current_membership',[clinic])]});
 await page.goto('/apply');
 await expect(page.getByTestId('applicant-state')).toHaveText("Approved — clinical access isn't on yet.");
 await expect(page.getByText(/older account settings/)).toBeVisible();
 await page.getByRole('button',{name:'Check again'}).click();
 await expect(page.getByText(/isn't active yet/)).toBeVisible();
 await page.getByRole('button',{name:'Check again'}).click();
 await expect(page.getByTestId('applicant-state')).toHaveText('Clinical access is available.');
 await expect(page.getByRole('link',{name:'Choose your clinic'})).toHaveAttribute('href','/settings#practice-preferences');
});

test('the clinic\'s queue says unavailable when no review service runs, never "no requests"',async({page})=>{
 await signIn(page);
 await page.goto('/settings');
 const card=page.getByTestId('join-requests-card');
 await expect(card.getByTestId('join-requests-unavailable')).toBeVisible();
 await expect(card.getByText('No one has asked to join this clinic.')).toHaveCount(0);
});

test('an admin approves by the applicant\'s address and declines with a reason, by keyboard',async({page})=>{
 await signIn(page);
 const sent:Record<string,unknown>[]=[];
 let listed:Array<Record<string,unknown>>=[{id:requestId,status:'pending',createdAt:'2026-10-15T12:00:00Z',decidedAt:null,decisionReason:null,membershipId:null}];
 await page.route('**/api/live/org/join-requests',async route=>{
  if(route.request().method()==='GET'){await route.fulfill({json:{data:{action:'list',requests:listed}}});return;}
  const body=route.request().postDataJSON() as Record<string,unknown>;sent.push(body);
  if(body.action==='approve'&&body.applicantEmail!=='fictional.applicant@example.test'){await route.fulfill({status:422,json:{error:'applicant_mismatch'}});return;}
  if(body.action==='approve'){listed=[{...listed[0]!,status:'approved',decidedAt:'2026-10-15T13:00:00Z',decisionReason:'identity_confirmed_by_clinic',membershipId:membership}];
   await route.fulfill({json:{data:{action:'approve',requestId,status:'approved',membershipId:membership,duplicate:false}}});return;}
  await route.fulfill({json:{data:{action:'revoke',membershipId:membership,status:'suspended',reason:body.reason,duplicate:false}}});
 });
 await page.goto('/settings');
 const card=page.getByTestId('join-requests-card');
 const row=card.getByRole('listitem',{name:'Request 20000000'});
 await expect(row).toContainText('Waiting for a decision');
 await row.getByLabel("Applicant's email, as they gave it to you").fill('someone.else@example.test');
 await page.keyboard.press('Enter');
 await expect(card.getByRole('alert')).toContainText("doesn't match the applicant's verified account");
 await row.getByLabel("Applicant's email, as they gave it to you").fill('fictional.applicant@example.test');
 await row.getByRole('button',{name:'Approve'}).press('Enter');
 await expect(card.getByRole('status')).toContainText('Request 20000000 approved.');
 await expect(row).toContainText('Approved');
 await row.getByLabel('Reason to remove access granted by request 20000000').selectOption('credentials_lapsed');
 await row.getByRole('button',{name:'Remove access'}).click();
 await expect(card.getByRole('status')).toContainText('Access from request 20000000 removed.');
 expect(sent.map(body=>body.action)).toEqual(['approve','approve','revoke']);
 expect(sent[2]).toEqual({action:'revoke',membershipId:membership,reason:'credentials_lapsed'});
 // The queue never shows who applied.
 await expect(card).not.toContainText('@');
});

test('real routes refuse a missing session and a cross-origin write',async({request,baseURL})=>{
 expect((await request.get('/api/onboarding/application')).status()).toBe(401);
 expect((await request.post('/api/onboarding/application',{headers:{origin:'https://example.org'},data:{action:'withdraw',requestId}})).status()).toBe(403);
 const sameOrigin=await request.post('/api/live/org/join-requests',{headers:{origin:baseURL!},data:{action:'reject',requestId,reason:'not_known_to_clinic'}});
 expect(sameOrigin.status()).toBeGreaterThanOrEqual(400);
});
