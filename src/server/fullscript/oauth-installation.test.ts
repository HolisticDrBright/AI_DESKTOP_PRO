import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {NextRequest} from 'next/server';
import {DynamoDBClient,PutItemCommand} from '@aws-sdk/client-dynamodb';
import {GET} from '../../app/api/live/fullscript/oauth/callback/route';
import {createFullscriptAuthorization,readFullscriptConfiguration} from './client';
import {parseStoredFullscriptConnection,type StoredFullscriptConnection} from './token-store';

const actor={actorKey:'a'.repeat(64),organizationId:'a1234567-1234-4123-8123-123456789012'};
let connections:StoredFullscriptConnection[],fetcher:ReturnType<typeof vi.fn>;
beforeEach(()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-09T10:00:00.000Z'));connections=[];
  vi.stubEnv('FULLSCRIPT_ENVIRONMENT','sandbox_us');vi.stubEnv('FULLSCRIPT_CLIENT_ID','fictional-client-id-abcdefghijklmnopqrstuvwxyz');
  vi.stubEnv('FULLSCRIPT_CLIENT_SECRET','fictional-client-secret-abcdefghijklmnopqrstuvwxyz');
  vi.stubEnv('FULLSCRIPT_REDIRECT_URI','https://fictional.example.test/api/live/fullscript/oauth/callback');
  vi.stubEnv('FULLSCRIPT_OAUTH_STATE_SECRET','fictional-state-secret-longer-than-32-characters');
  vi.stubEnv('FULLSCRIPT_TOKEN_TABLE','fictional-token-table');vi.stubEnv('AWS_REGION','us-east-2');
  vi.spyOn(DynamoDBClient.prototype,'send').mockImplementation(async command=>{
    if(command instanceof PutItemCommand&&command.input.Item?.payload?.S)
      connections.push(parseStoredFullscriptConnection(JSON.parse(command.input.Item.payload.S),actor));
    return {} as never;
  });
  fetcher=vi.fn(async()=>new Response(JSON.stringify({oauth:{access_token:'fictional-access-token-abcdefghijklmnopqrstuvwxyz',
    refresh_token:'fictional-refresh-token-abcdefghijklmnopqrstuvwxyz',expires_in:3600,created_at:new Date().toISOString(),
    scope:'clinic:read clinic:write',resource_owner:{id:'fictional-practitioner-id',type:'Practitioner'}}}),
    {status:200,headers:{'content-type':'application/json'}}));vi.stubGlobal('fetch',fetcher);
});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();});
const request=(nonce:string)=>{
  const {state}=createFullscriptAuthorization({configuration:readFullscriptConfiguration(),...actor,nonce});
  const url=new URL('https://fictional.example.test/api/live/fullscript/oauth/callback');
  url.searchParams.set('state',state);url.searchParams.set('code','fictional-authorization-code-abcdefghijklmnopqrstuvwxyz');
  return new NextRequest(url);
};
describe('OAuth callback persists a new independent installation identity',()=>{
  it('saves a valid installation UUID under verified actor/clinic custody',async()=>{
    const result=await GET(request('fictional-first-nonce-abcdefghijklmnopqrstuvwxyz'));
    expect(result.status).toBe(303);expect(new URL(result.headers.get('location')!).searchParams.get('fullscript')).toBe('connected');
    expect(connections).toHaveLength(1);expect(connections[0].installationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(connections[0]).toMatchObject({...actor,connectedAt:new Date().toISOString(),environment:'sandbox_us'});
    expect(connections[0]).toMatchObject({oauthClientId:readFullscriptConfiguration().clientId,
      oauthRedirectUri:readFullscriptConfiguration().redirectUri});
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('gives separate reauthorizations distinct IDs even at exactly the same timestamp',async()=>{
    await GET(request('fictional-first-nonce-abcdefghijklmnopqrstuvwxyz'));
    await GET(request('fictional-second-nonce-abcdefghijklmnopqrstuvwxyz'));
    expect(connections).toHaveLength(2);expect(connections[0].connectedAt).toBe(connections[1].connectedAt);
    expect(connections[0].installationId).not.toBe(connections[1].installationId);
  });
  it('does not save an installation or exchange credentials when nonce replay is refused',async()=>{
    vi.spyOn(console,'error').mockImplementation(()=>undefined);
    vi.mocked(DynamoDBClient.prototype.send).mockRejectedValueOnce(Object.assign(new Error('fictional replay'),{name:'ConditionalCheckFailedException'}));
    const result=await GET(request('fictional-first-nonce-abcdefghijklmnopqrstuvwxyz'));
    expect(new URL(result.headers.get('location')!).searchParams.get('fullscript')).toBe('connection_failed');
    expect(connections).toEqual([]);expect(fetcher).not.toHaveBeenCalled();
  });
});
