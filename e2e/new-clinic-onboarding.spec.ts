import {test,expect,type Page,type Route} from '@playwright/test';
test.skip(process.env.E2E_ONBOARDING!=='1','Dedicated practitioner onboarding UI run required.');
// The new screens: the two doors on /apply (create a new clinic, request to join an existing one), the clinic choice
// after sign-in, and the platform operator console. The shipped build is checked against the real, blocked routes; every
// other answer is a fictional page.route reply. This never certifies a hosted applicant or operator API, a Cognito
// account, a clinic, or any clinical access.
const clinic='30000000-0000-4000-8000-000000000001',other='30000000-0000-4000-8000-000000000002',proposal='30000000-0000-4000-8000-000000000003';
async function signIn(page:Page){
 const origin='http://localhost:'+(process.env.E2E_PORT??'3114');
 await page.context().addCookies([{name:'aidp_at',value:'fictional-ui-only',url:origin},{name:'aidp_exp',value:String(Date.now()+3600000),url:origin}]);
}
type Answer={status:number;json:unknown}|'abort';
async function live(page:Page,url:string,handlers:{get?:()=>Answer;post?:(body:Record<string,unknown>,count:number)=>Answer}){
 const posts:Record<string,unknown>[]=[];
 await page.route(url,async(route:Route)=>{
  const post=route.request().method()==='POST';
  let next:Answer;
  if(post){const body=route.request().postDataJSON() as Record<string,unknown>;posts.push(body);next=handlers.post?handlers.post(body,posts.length):{status:503,json:{error:'workforce_application_unavailable'}};}
  else next=handlers.get?handlers.get():{status:503,json:{error:'workforce_application_unavailable'}};
  if(next==='abort'){await route.abort('connectionreset');return;}
  await route.fulfill(next);
 });
 return posts;
}
const noApplication={status:200,json:{data:{entries:[],clinicSignIn:'current_membership',clinicIds:null}}};
const noClinic={status:200,json:{data:{clinic:null,clinicSignIn:'current_membership',inSession:null}}};
const created=(extra:Record<string,unknown>={},inSession:boolean|null=true,clinicSignIn='current_membership')=>({status:200,json:{data:{clinic:{requestId:proposal,organizationId:clinic,
 status:'active',suspensionReason:null,clinicalAccess:'available',createdAt:'2026-10-16T12:00:00Z',...extra},clinicSignIn,inSession}}});

test.describe('the two doors on /apply',()=>{
 test('shipped: creating a clinic is not open here, the held proposal is offered, and only fictional names are invited',async({page})=>{
  await signIn(page);
  await live(page,'**/api/onboarding/application',{get:()=>noApplication});
  await page.goto('/apply');
  await expect(page.getByTestId('applicant-state')).toHaveText("You haven't created or joined a clinic yet.");
  await expect(page.getByRole('radio',{name:'Create a new clinic'})).toBeChecked();
  await expect(page.getByRole('radio',{name:'Request to join an existing clinic'})).toBeVisible();
  await expect(page.getByTestId('create-not-offered')).toContainText("Creating a clinic directly isn't open in this app yet.");
  await expect(page.getByRole('button',{name:'Create clinic'})).toHaveCount(0);
  await expect(page.getByLabel('Proposed clinic name')).toBeVisible();
  await expect(page.getByTestId('synthetic-clinic-notice')).toContainText('Fictional test records only.');
  await expect(page.getByTestId('applicant-steps')).toContainText('Not open in this app');
  await page.getByRole('radio',{name:'Request to join an existing clinic'}).check();
  await expect(page.getByLabel('Clinic code')).toBeVisible();
 });

 test('creates a clinic by keyboard; a lost reply is resent as the same request and never makes a second clinic',async({page})=>{
  await signIn(page);
  await live(page,'**/api/onboarding/application',{get:()=>noApplication});
  let made=false;
  const posts=await live(page,'**/api/onboarding/clinic-bootstrap',{get:()=>made?created():noClinic,
   post:(body,count)=>{if(count===1)return 'abort';made=true;return {status:200,json:{data:{requestId:body.requestId,organizationId:clinic,membershipId:other,status:'active',clinicalAccess:'available',duplicate:true}}};}});
  const switches=await live(page,'**/api/auth/org',{post:()=>({status:200,json:{data:{activeOrgId:clinic,name:'Fictional New Clinic'}}})});
  await page.goto('/apply');
  await expect(page.getByTestId('applicant-journey')).toHaveAttribute('data-new-clinic','none');
  await page.getByLabel('Clinic name').fill('Fictional New Clinic');
  await expect(page.getByTestId('synthetic-clinic-notice')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('applicant-journey').getByRole('alert')).toContainText('No confirmed answer arrived');
  await page.getByRole('button',{name:'Create clinic'}).press('Enter');
  await expect(page.getByTestId('applicant-state')).toHaveText('Your clinic is ready.');
  await expect(page.getByTestId('applicant-state')).toBeFocused();
  await expect(page.getByTestId('applicant-journey').getByRole('status')).toContainText('already created by your earlier attempt');
  await expect(page.getByText(/You're the owner of this new clinic .*records only\. This build is for fictional test records only: don't enter real patient information\./)).toBeVisible();
  expect(posts).toHaveLength(2);
  expect(posts[0]).toEqual(posts[1]);
  expect(Object.keys(posts[0]!).sort()).toEqual(['clinicLabel','requestId']);
  expect(posts[0]).toMatchObject({clinicLabel:'Fictional New Clinic'});
  await page.getByRole('button',{name:'Open your clinic'}).click();
  await expect.poll(()=>switches.length).toBe(1);
  expect(switches[0]).toEqual({organizationId:clinic});
  // The app's home ('/', which opens Today) in the clinic the server selected.
  await page.waitForURL(url=>url.pathname==='/'||url.pathname==='/today');
 });

 test('names each refusal, and a retry after an account switch is a conflict that starts a fresh attempt',async({page})=>{
  await signIn(page);
  await live(page,'**/api/onboarding/application',{get:()=>noApplication});
  const replies:Answer[]=['abort',{status:409,json:{error:'workforce_clinic_bootstrap_conflict'}},{status:409,json:{error:'workforce_clinic_bootstrap_exists'}},
   {status:403,json:{error:'workforce_applicant_mfa_required'}},{status:503,json:{error:'workforce_clinic_bootstrap_not_released'}}];
  const posts=await live(page,'**/api/onboarding/clinic-bootstrap',{get:()=>noClinic,post:(_body,count)=>replies[count-1]!});
  await page.goto('/apply');
  await page.getByLabel('Clinic name').fill('Fictional Retry Clinic');
  const create=page.getByRole('button',{name:'Create clinic'});
  const alert=page.getByTestId('applicant-journey').getByRole('alert');
  await create.click();
  await expect(alert).toContainText('No confirmed answer arrived');
  await create.click();
  await expect(alert).toContainText("This retry doesn't match the first attempt");
  await create.click();
  await expect(alert).toContainText('This account has already created a clinic. Nothing new was created.');
  await create.click();
  await expect(alert).toContainText("Multi-factor authentication isn't set up on this account. Nothing was created.");
  await create.click();
  await expect(alert).toContainText("Creating a clinic isn't open in this app yet. Nothing was created.");
  // The lost reply's resend keeps its id; the conflict ends that attempt, so the next one is new.
  expect(posts[1]!.requestId).toBe(posts[0]!.requestId);
  expect(posts[2]!.requestId).not.toBe(posts[1]!.requestId);
 });

 test('a created clinic that is suspended, or not yet in this session, is never shown as ready',async({page})=>{
  await signIn(page);
  await live(page,'**/api/onboarding/application',{get:()=>noApplication});
  let shown=0;
  const states:Answer[]=[created({status:'suspended',suspensionReason:'identity_not_verified',clinicalAccess:'not_available'}),
   created({},null),created({},true,'legacy_claims'),{status:500,json:{error:'workforce_application_unavailable'}}];
  await live(page,'**/api/onboarding/clinic-bootstrap',{get:()=>states[shown]!});
  await page.goto('/apply');
  await expect(page.getByTestId('applicant-state')).toHaveText('Your clinic is suspended.');
  await expect(page.getByText(/Identity not verified.*no way to reinstate/)).toBeVisible();
  await expect(page.getByRole('button',{name:'Open your clinic'})).toHaveCount(0);
  await page.getByRole('radio',{name:'Create a new clinic'}).check();
  await expect(page.getByTestId('create-not-offered')).toContainText('already created its clinic');
  shown=1;
  await page.getByRole('button',{name:'Check again'}).click();
  await expect(page.getByText(/Your session doesn't list your new clinic yet/)).toBeVisible();
  shown=2;
  await page.getByRole('button',{name:'Check again'}).click();
  await expect(page.getByText(/older account settings, which can't include a new clinic/)).toBeVisible();
  shown=3;
  await page.getByRole('button',{name:'Check again'}).click();
  await expect(page.getByTestId('applicant-journey')).toHaveAttribute('data-new-clinic','unknown');
  await expect(page.getByTestId('create-not-offered')).toContainText("We couldn't check whether this account already has a clinic");
  await expect(page.getByRole('button',{name:'Create clinic'})).toHaveCount(0);
  await expect(page.getByTestId('applicant-steps')).toContainText('Unknown');
 });
});

test.describe('choosing a clinic after sign-in',()=>{
 const listed=(organizations:unknown[],pending:unknown[]=[])=>({status:200,json:{data:{mode:'live',organizations,activeOrgId:null,pending}}});
 test('several clinics: nothing is chosen for the practitioner; the choice is sent and the return path kept',async({page})=>{
  await signIn(page);
  const posts=await live(page,'**/api/auth/org',{get:()=>listed([{organizationId:clinic,name:'Fictional A',role:'owner'},{organizationId:other,name:'Fictional B',role:'staff'}],
   [{organizationId:proposal,name:'Fictional Pending'}]),post:()=>({status:200,json:{data:{activeOrgId:other,name:'Fictional B'}}})});
  await page.goto('/select-clinic?next=%2Fpatients');
  await expect(page.getByTestId('clinic-chooser-state')).toHaveText('Choose the clinic to work in');
  const open=page.getByTestId('clinic-chooser-form').getByRole('button',{name:'Open clinic'});
  await expect(open).toBeDisabled();
  await expect(page.getByRole('radio',{name:'Fictional A'})).not.toBeChecked();
  await expect(page.getByRole('radio',{name:'Fictional B'})).not.toBeChecked();
  await expect(page.getByTestId('clinic-chooser-pending')).toContainText('Fictional Pending');
  await expect(page.getByRole('radio',{name:/Fictional Pending/})).toHaveCount(0);
  await page.getByRole('radio',{name:'Fictional B'}).check();
  await open.click();
  await page.waitForURL(url=>url.pathname==='/patients');
  expect(posts).toEqual([{organizationId:other}]);
 });

 test('a failed read is not "no clinic"; no clinic leads to the two doors',async({page})=>{
  await signIn(page);
  let readable=false;
  await live(page,'**/api/auth/org',{get:()=>readable?listed([]):{status:503,json:{error:{code:'unavailable',message:'x'}}}});
  await page.goto('/select-clinic');
  await expect(page.getByTestId('clinic-chooser-state')).toHaveText("We couldn't read your clinics.");
  await expect(page.getByText("This doesn't mean you have none.")).toBeVisible();
  readable=true;
  await page.getByRole('button',{name:'Check again'}).click();
  await expect(page.getByTestId('clinic-chooser-state')).toHaveText("This account isn't an active member of any clinic yet.");
  await expect(page.getByRole('link',{name:'Create or join a clinic'})).toHaveAttribute('href','/apply');
 });
});

test.describe('the platform operator console',()=>{
 test('shipped: not released, and no form to sign in, review or suspend',async({page})=>{
  await page.goto('/operator');
  await expect(page.getByTestId('operator-state')).toHaveText("The operator console isn't released in this build.");
  const console=page.getByTestId('operator-console');
  await expect(console.getByRole('button')).toHaveCount(0);
  await expect(console.getByRole('textbox')).toHaveCount(0);
 });

 test('a separate sign-in, held approval, and suspension with a closed reason, recorded and never reinstated',async({page})=>{
  let signedIn=false,approved=false,suspended=false;
  const session=await live(page,'**/api/operator/session',{get:()=>({status:200,json:{data:{signedIn,mfaPending:false}}}),
   post:body=>{if('code' in body){signedIn=true;return {status:200,json:{data:{signedIn:true}}};}return {status:202,json:{data:{mfaRequired:true}}};}});
  const pendingProposal={id:proposal,status:'pending',createdAt:'2026-10-16T10:00:00Z',decidedAt:null,proposedLabel:'Fictional Proposed Clinic',decisionReason:null};
  const decisions=await live(page,'**/api/operator/clinic-proposals',{get:()=>({status:200,json:{data:{proposals:[approved
    ?{...pendingProposal,status:'approved',decidedAt:'2026-10-16T11:00:00Z',decisionReason:'clinic_proposal_verified'}:pendingProposal]}}}),
   post:()=>{approved=true;return {status:200,json:{data:{action:'approve',requestId:proposal,status:'approved',organizationId:other,membershipId:clinic,decisionReason:'clinic_proposal_verified',activation:'held',duplicate:false}}};}});
  const active={organizationId:clinic,clinicLabel:'Fictional Bootstrapped Clinic',status:'active',createdAt:'2026-10-16T09:00:00Z',suspendedAt:null,suspensionReason:null,
   events:[{action:'bootstrapped',reason:null,occurredAt:'2026-10-16T09:00:00Z',operator:null,byCaller:false}]};
  const suspensions=await live(page,'**/api/operator/bootstrapped-clinics',{get:()=>({status:200,json:{data:{clinics:[suspended
    ?{...active,status:'suspended',suspendedAt:'2026-10-16T12:00:00Z',suspensionReason:'security_concern',
      events:[...active.events,{action:'suspended',reason:'security_concern',occurredAt:'2026-10-16T12:00:00Z',operator:'0123456789abcdef',byCaller:true}]}:active]}}}),
   post:()=>{suspended=true;return {status:200,json:{data:{organizationId:clinic,status:'suspended',reason:'security_concern',duplicate:false}}};}});
  await page.goto('/operator');
  await expect(page.getByTestId('operator-state')).toHaveText('Operator sign-in');
  await expect(page.getByText("This isn't your practitioner sign-in.")).toBeVisible();
  await page.getByLabel('Operator email').fill('fictional.operator@example.test');
  await page.getByLabel('Password').fill('fictional-password');
  await page.getByRole('button',{name:'Continue'}).click();
  await page.getByLabel('Authenticator code').fill('123456');
  await page.getByRole('button',{name:'Verify and sign in'}).click();
  await expect(page.getByTestId('operator-state')).toContainText('Signed in as a platform operator');
  expect(session).toEqual([{email:'fictional.operator@example.test',password:'fictional-password'},{code:'123456'}]);

  const row=page.getByRole('listitem',{name:'Proposal 30000000'});
  await row.getByRole('button',{name:'Approve'}).click();
  await page.getByRole('group',{name:'Confirm approving proposal 30000000'}).getByRole('button',{name:'Yes, approve (held)'}).click();
  await expect(page.getByText(/approved\. The clinic is held: nobody has patient access/)).toBeVisible();
  await expect(row).toContainText('Proposal verified');
  expect(decisions).toEqual([{action:'approve',requestId:proposal}]);

  const clinicRow=page.getByRole('listitem',{name:'Clinic 30000000'});
  await expect(clinicRow.getByRole('button',{name:'Suspend'})).toBeDisabled();
  await clinicRow.getByLabel('Reason to suspend Fictional Bootstrapped Clinic').selectOption('security_concern');
  await clinicRow.getByRole('button',{name:'Suspend'}).click();
  await page.getByRole('group',{name:'Confirm suspending Fictional Bootstrapped Clinic'}).getByRole('button',{name:'Yes, suspend'}).click();
  await expect(page.getByText('Fictional Bootstrapped Clinic suspended: A security concern.')).toBeVisible();
  await expect(clinicRow).toContainText('A security concern — by operator 0123456789abcdef (you)');
  await expect(clinicRow).toContainText('No reinstatement process is defined.');
  await expect(page.getByRole('button',{name:/reinstate/i})).toHaveCount(0);
  expect(suspensions).toEqual([{organizationId:clinic,reason:'security_concern'}]);
 });

 test('a failed list is not an empty one, and a refused operator is sent back to sign in',async({page})=>{
  let refused=false;
  await live(page,'**/api/operator/session',{get:()=>({status:200,json:{data:{signedIn:!refused,mfaPending:false}}})});
  await live(page,'**/api/operator/clinic-proposals',{get:()=>({status:503,json:{error:'platform_operator_unavailable'}})});
  await live(page,'**/api/operator/bootstrapped-clinics',{get:()=>{refused=true;return {status:403,json:{error:'platform_operator_refused'}};}});
  await page.goto('/operator');
  await expect(page.getByTestId('operator-state')).toHaveText('Operator sign-in');
  await expect(page.getByTestId('operator-sign-in').getByRole('alert')).toContainText('Your operator sign-in ended or was refused');
 });
});

test('the shipped routes refuse: the new-clinic door and every operator route are not released',async({request,baseURL})=>{
 const create=await request.post('/api/onboarding/clinic-bootstrap',{headers:{origin:baseURL!},data:{requestId:proposal,clinicLabel:'Fictional Clinic'}});
 expect(create.status()).toBe(503);
 expect(await create.json()).toEqual({error:'workforce_clinic_bootstrap_not_released'});
 for(const path of ['/api/operator/session','/api/operator/clinic-proposals','/api/operator/bootstrapped-clinics']){
  const answer=await request.get(path);
  expect(answer.status(),path).toBe(503);
  expect(await answer.json(),path).toEqual({error:'platform_operator_not_released'});
 }
});
