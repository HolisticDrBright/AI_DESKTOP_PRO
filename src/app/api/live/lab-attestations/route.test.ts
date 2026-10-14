import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const session=vi.hoisted(()=>vi.fn());
vi.mock('@/server/session',()=>({getRequestSession:session}));
vi.mock('@/adapters/mode',()=>({USE_LIVE_API:true}));
import {POST as attestPOST} from './route';
import {POST as reviewPOST} from './review/route';
import {LAB_OBSERVATION_ATTESTATION_CANDIDATE_SHA256,LAB_RESULT_TRANSFER_V2_CANDIDATE_SHA256} from '@/server/clinical-core/lab-observation-attestation';
import {LAB_ATTESTATION_REVIEW_CANDIDATE_SHA256} from '@/server/clinical-core/lab-attestation-review';
import {boundAttestation,labAttestationReview,type LabAttestationReview} from '@/contracts/labAttestationReview';

/** The Desktop's same-origin bridge to the reviewer attestation service: disabled by default, bounded, strict, and
 * never relaying anything it could not parse as being about the reading on screen. Fictional values only. */
const upstream=vi.fn();
const host='penrnyupn3.us-east-2.awsapprunner.com';
const AWS='https://abcdefghij.execute-api.us-east-2.amazonaws.com';
const patientId='11111111-1111-4111-8111-111111111111',observationId='22222222-2222-4222-8222-222222222222';
const DOC='d'.repeat(64);
const view:LabAttestationReview=labAttestationReview.parse({contract:'lab-attestation-review/1',patientRecordId:patientId,observationId,
 reading:{marker:'Ferritin',value:420,valueText:'420',unit:'ng/mL',observedAt:'2026-10-01T09:00:00.000Z'},reviewStatus:'accepted',
 transfer:{contract:'lab-result/2',origin:'uploaded_report_analysis',documents:[DOC],reportedVerification:'analysis_cross_checked',appAssessment:null,laboratoryFlag:null},
 supersededBy:null,verification:{observationId,state:'needs_human_review',current:null,rangeVerified:false,history:[]},attestable:true,blockedBy:null,readingRevision:'a'.repeat(64)});
const attestationId='33333333-3333-4333-8333-333333333333';
const verifiedView={...view,readingRevision:'b'.repeat(64),verification:{observationId,state:'verified',current:attestationId,rangeVerified:false,
 history:[{attestationId,outcome:'verified',scope:'measured_value',documentSha256:DOC,reviewerRole:'practitioner',supersedes:null,attestedAt:'2026-10-14T00:00:00Z'}]}};
const statement=()=>boundAttestation(view,{requestId:'44444444-4444-4444-8444-444444444444',outcome:'verified',
 restated:{marker:'Ferritin',value:420,unit:'ng/mL',observedAt:'2026-10-01T09:00:00.000Z'},documentSha256:DOC});
const receipt=()=>({attestationId,observationId,outcome:'verified',scope:'measured_value',rangeVerified:false,attestedAt:'2026-10-14T00:00:00Z',duplicate:false,
 patientRecordId:patientId,view:verifiedView});
const evidence=(parts:Record<string,unknown>={})=>JSON.stringify({contract:'lab-attestation-review-activation/1',enabled:true,target:'production-clinical',
 transferCandidateSha256:LAB_RESULT_TRANSFER_V2_CANDIDATE_SHA256,attestationCandidateSha256:LAB_OBSERVATION_ATTESTATION_CANDIDATE_SHA256,
 reviewCandidateSha256:LAB_ATTESTATION_REVIEW_CANDIDATE_SHA256,evidenceSha256:'e'.repeat(64),reviewedBy:'FICTIONAL REVIEW FIXTURE',reviewedAt:'2026-10-14T00:00:00Z',...parts});
function req(path:'review'|'attest',body:unknown,headers:Record<string,string>={}){
 return new Request(`http://0.0.0.0:3000/api/live/lab-attestations${path==='review'?'/review':''}`,{method:'POST',
  headers:{host,origin:'https://'+host,'sec-fetch-site':'same-origin','content-type':'application/json',...headers},body:typeof body==='string'?body:JSON.stringify(body)});
}
const call=(path:'review'|'attest',body:unknown,headers?:Record<string,string>)=>(path==='review'?reviewPOST:attestPOST)(req(path,body,headers));
const reviewBody={patientId,observationId};
beforeEach(()=>{
 vi.clearAllMocks();vi.stubGlobal('fetch',upstream);
 vi.stubEnv('CLINICAL_AWS_WORKFORCE_API_ORIGIN',AWS);
 vi.stubEnv('CLINICAL_CONTRACT_FIXTURE','');
 vi.stubEnv('CLINICAL_LAB_ATTESTATION_ACTIVATION','');
 session.mockResolvedValue({signedIn:true,token:'fictional-workforce-token'});
 upstream.mockImplementation(async(url:string)=>Response.json({data:url.endsWith('/review')?view:receipt()}));
});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});

describe('disabled by default',()=>{
 it.each([['absent',''],['malformed','{not json'],['disabled',JSON.stringify({contract:'lab-attestation-review-activation/1',enabled:false})],
  ['naming another review candidate',evidence({reviewCandidateSha256:'f'.repeat(64)})],['naming another attestation candidate',evidence({attestationCandidateSha256:'f'.repeat(64)})],
  ['for another target',evidence({target:'synthetic-staging'})]])('refuses both routes with no network call when evidence is %s',async(_name,value)=>{
  vi.stubEnv('CLINICAL_LAB_ATTESTATION_ACTIVATION',value);
  for(const [path,body] of [['review',reviewBody],['attest',statement()]] as const){
   const response=await call(path,body);
   expect(response.status).toBe(409);
   expect(await response.json()).toEqual({error:{code:'lab_attestation_disabled'}});
  }
  expect(upstream).not.toHaveBeenCalled();
 });
});

describe('with activation evidence on a deployment',()=>{
 beforeEach(()=>vi.stubEnv('CLINICAL_LAB_ATTESTATION_ACTIVATION',evidence()));
 it('sends the review as the contract to the pinned workforce route with the session token, and relays the parsed view',async()=>{
  const response=await call('review',reviewBody);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store, private');
  expect((await response.json()).data).toEqual(view);
  const [url,init]=upstream.mock.calls[0] as [string,RequestInit];
  expect(url).toBe(`${AWS}/clinical-core/workforce/lab-attestations/review`);
  expect(init).toMatchObject({method:'POST',redirect:'error',cache:'no-store'});
  expect((init.headers as Record<string,string>).authorization).toBe('Bearer fictional-workforce-token');
  expect(JSON.parse(String(init.body))).toEqual({contract:'lab-attestation-review/1',patientRecordId:patientId,observationId});
 });
 it('sends the bound attestation unchanged and relays a receipt only when it is about this reading',async()=>{
  const response=await call('attest',statement());
  expect(response.status).toBe(200);
  expect((await response.json()).data).toMatchObject({attestationId,patientRecordId:patientId,outcome:'verified'});
  expect(JSON.parse(String((upstream.mock.calls[0] as [string,RequestInit])[1].body))).toEqual(statement());
  for(const wrong of [{patientRecordId:'55555555-5555-4555-8555-555555555555'},{outcome:'refuted'},{observationId:'66666666-6666-4666-8666-666666666666'}]){
   upstream.mockResolvedValueOnce(Response.json({data:{...receipt(),...wrong}}));
   expect((await call('attest',statement())).status).toBe(503);
  }
  upstream.mockResolvedValueOnce(Response.json({data:{...view,patientRecordId:'55555555-5555-4555-8555-555555555555'}}));
  expect((await call('review',reviewBody)).status).toBe(503);
 });
 it.each<Record<string,string>>([{origin:'https://evil.example'},{origin:''},{host:''},{'sec-fetch-site':'cross-site'},
  {origin:'https://evil.example','x-forwarded-host':'evil.example'}])('refuses an unsafe origin before reading credentials: %o',async headers=>{
  for(const path of ['review','attest'] as const)expect((await call(path,path==='review'?reviewBody:statement(),headers)).status).toBe(403);
  expect(session).not.toHaveBeenCalled();expect(upstream).not.toHaveBeenCalled();
 });
 it('requires a signed-in session',async()=>{
  session.mockResolvedValue({signedIn:false,token:null});
  expect((await call('review',reviewBody)).status).toBe(401);
  expect((await call('attest',statement())).status).toBe(401);
  expect(upstream).not.toHaveBeenCalled();
 });
 it('refuses a client "verified" boolean, a signature, a range, a flag, extra keys and an oversized body before anything leaves',async()=>{
  const base=statement();
  for(const body of [{...base,verified:true},{...base,attestation:{...base.attestation,verified:true}},{...base,attestation:{...base.attestation,signature:'Dr. Fictional'}},
   {...base,attestation:{...base.attestation,reading:{...base.attestation.reading,flag:'H'}}},{...base,rangeVerified:true},{...base,organizationId:patientId},
   {...base,attestation:{...base.attestation,outcome:'looks fine'}},'x'.repeat(9000),'{not json'])
   expect((await call('attest',body)).status).toBe(400);
  for(const body of [{...reviewBody,organizationId:patientId},{patientId},{patientId:'not-a-uuid',observationId},'x'.repeat(2000)])
   expect((await call('review',body)).status).toBe(400);
  expect(upstream).not.toHaveBeenCalled();
 });
 it('relays only decided refusals in the closed vocabulary; anything else is unavailable, and no service text is shown',async()=>{
  for(const [status,code] of [[409,'lab_attestation_stale'],[409,'lab_attestation_reading_superseded'],[404,'lab_attestation_review_refused'],
   [403,'clinical_role_required'],[409,'lab_attestation_document_mismatch'],[400,'lab_attestation_invalid']] as const){
   upstream.mockResolvedValueOnce(Response.json({error:{code}},{status}));
   const response=await call('attest',statement());
   expect([response.status,await response.json()]).toEqual([status,{error:{code}}]);
  }
  for(const reply of [Response.json({error:{code:'private backend detail'}},{status:409}),Response.json({error:{code:'lab_attestation_stale'}},{status:500}),
   new Response('<html>gateway</html>',{status:502,headers:{'content-type':'text/html'}}),Response.json({data:{...receipt(),view:{...verifiedView,verified:true}}})]){
   upstream.mockResolvedValueOnce(reply);
   const response=await call('attest',statement());
   expect(response.status).toBe(503);
   expect(JSON.stringify(await response.json())).not.toMatch(/private|gateway/);
  }
  upstream.mockResolvedValueOnce(Response.json({},{status:401}));
  expect(await (await call('review',reviewBody)).json()).toEqual({error:{code:'reauth_required'}});
  upstream.mockRejectedValueOnce(new TypeError('fetch failed'));
  expect((await call('review',reviewBody)).status).toBe(503);
 });
 it('refuses an unpinned service origin rather than sending a reviewer token anywhere else',async()=>{
  for(const origin of ['http://abcdefghij.execute-api.us-east-2.amazonaws.com','https://evil.example','https://abcdefghij.execute-api.us-east-2.amazonaws.com/path','']){
   vi.stubEnv('CLINICAL_AWS_WORKFORCE_API_ORIGIN',origin);
   expect((await call('review',reviewBody)).status).toBe(503);
  }
  expect(upstream).not.toHaveBeenCalled();
 });
});

describe('the local contract fixture',()=>{
 it('reaches only the loopback fixture backend, with its own credential, and needs no deployment evidence',async()=>{
  vi.stubEnv('CLINICAL_CONTRACT_FIXTURE','1');vi.stubEnv('CLINICAL_SUPABASE_URL','http://127.0.0.1:3999');vi.stubEnv('CLINICAL_SUPABASE_ANON_KEY','stub');
  expect((await call('review',reviewBody)).status).toBe(200);
  const [url,init]=upstream.mock.calls[0] as [string,RequestInit];
  expect(url).toBe('http://127.0.0.1:3999/clinical-core/workforce/lab-attestations/review');
  expect((init.headers as Record<string,string>).apikey).toBe('stub');
 });
 it('is never used for a hosted backend',async()=>{
  vi.stubEnv('CLINICAL_CONTRACT_FIXTURE','1');vi.stubEnv('CLINICAL_SUPABASE_URL','https://urcjiehlxoehievobezf.supabase.co');vi.stubEnv('CLINICAL_SUPABASE_ANON_KEY','stub');
  expect((await call('review',reviewBody)).status).toBe(409);
  expect(upstream).not.toHaveBeenCalled();
 });
});
