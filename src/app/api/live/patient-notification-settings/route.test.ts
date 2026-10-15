import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {defaultNotificationPreferences} from '@/contracts/patientNotifications';
const session=vi.hoisted(()=>vi.fn());
vi.mock('@/server/session',()=>({getRequestSession:session}));
vi.mock('@/adapters/mode',()=>({USE_LIVE_API:true}));
import {POST} from './route';
/**
 * The clinic's read-only view of a linked patient's reminder and notice choices, through
 * the workforce proxy. Fictional people only.
 */
const upstream=vi.fn();
const host='penrnyupn3.us-east-2.awsapprunner.com';
const connectionId='44444444-4444-4444-8444-444444444444';
const view={contract:'patient-notifications/1',connectionId,preferences:defaultNotificationPreferences(),timeZone:'America/Los_Angeles',
 textConsent:{phoneLastTwo:'01',wordingVersion:'text-consent/1',agreedAt:'2026-10-01T16:00:00.000Z'},textStopped:false,pushAvailable:false};
function req(body:unknown={action:'read',connectionId},headers:Record<string,string>={}){
 return new Request('http://0.0.0.0:3000/api/live/patient-notification-settings',{method:'POST',headers:{host,origin:'https://'+host,
  'sec-fetch-site':'same-origin','content-type':'application/json',...headers},body:JSON.stringify(body)});
}
beforeEach(()=>{
 vi.clearAllMocks();vi.stubGlobal('fetch',upstream);
 vi.stubEnv('NOTIFICATION_PREFERENCES_ENABLED','true');
 vi.stubEnv('CLINICAL_AWS_WORKFORCE_API_ORIGIN','https://abcdefghij.execute-api.us-east-2.amazonaws.com');
 session.mockResolvedValue({token:'fictional-workforce-token'});
 upstream.mockResolvedValue(Response.json({data:view}));
});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});

it('switched off, answers 404 before reading the session or calling anything',async()=>{
 for(const value of [undefined,'false','TRUE','1']){
  if(value===undefined)vi.stubEnv('NOTIFICATION_PREFERENCES_ENABLED',undefined as unknown as string);else vi.stubEnv('NOTIFICATION_PREFERENCES_ENABLED',value);
  expect((await POST(req())).status,String(value)).toBe(404);
 }
 expect(session).not.toHaveBeenCalled();expect(upstream).not.toHaveBeenCalled();
});
it('reads through the workforce route with the exchanged token and returns the read-only view',async()=>{
 const response=await POST(req());
 expect(response.status).toBe(200);
 expect(await response.json()).toEqual({data:view});
 const [url,init]=upstream.mock.calls[0] as [string,RequestInit];
 expect(url).toBe('https://abcdefghij.execute-api.us-east-2.amazonaws.com/clinical-core/workforce/notifications/settings');
 expect((init.headers as Record<string,string>).authorization).toBe('Bearer fictional-workforce-token');
 expect(JSON.parse(String(init.body))).toEqual({action:'read',connectionId});
});
it('has no request that changes a choice: anything but a read is refused before anything leaves the process',async()=>{
 for(const body of [{action:'save',connectionId,preferences:defaultNotificationPreferences()},{action:'consent',connectionId,phone:'+15555550101'},
  {action:'withdraw',connectionId},{action:'read'},{action:'read',connectionId,phone:'+15555550101'},{action:'read',connectionId:'not-a-uuid'}]){
  expect((await POST(req(body))).status,JSON.stringify(body)).toBe(400);
 }
 expect(upstream).not.toHaveBeenCalled();
});
it('refuses unsafe origins and a missing session before calling upstream',async()=>{
 expect((await POST(req(undefined,{origin:'https://evil.example'}))).status).toBe(403);
 session.mockResolvedValue({token:null});
 expect((await POST(req())).status).toBe(401);
 expect(upstream).not.toHaveBeenCalled();
});
it('a failure is 503, never an empty set of choices; a refusal passes through',async()=>{
 for(const status of [401,403]){
  upstream.mockResolvedValueOnce(new Response('{}',{status,headers:{'content-type':'application/json'}}));
  expect((await POST(req())).status).toBe(status);
 }
 for(const reply of [new Response('{}',{status:503,headers:{'content-type':'application/json'}}),new Response('{}',{status:500}),
  Response.json({data:{...view,textConsent:{phone:'+15555550101'}}}),Response.json({data:{...view,pushAvailable:true}}),Response.json({})]){
  upstream.mockResolvedValueOnce(reply);
  const response=await POST(req());
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({error:'service_unavailable'});
 }
 upstream.mockRejectedValueOnce(new Error('network'));
 expect((await POST(req())).status).toBe(503);
});
it('an answer about a different patient is not an answer about this one',async()=>{
 upstream.mockResolvedValueOnce(Response.json({data:{...view,connectionId:'55555555-5555-4555-8555-555555555555'}}));
 expect((await POST(req())).status).toBe(503);
});
it('a misconfigured workforce origin is unavailable, not a guess',async()=>{
 vi.stubEnv('CLINICAL_AWS_WORKFORCE_API_ORIGIN','https://evil.example');
 expect((await POST(req())).status).toBe(503);
 expect(upstream).not.toHaveBeenCalled();
});
