import {afterEach,describe,expect,it,vi} from 'vitest';
import {requestPrivacyOperation} from './privacy-operations-client';
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
describe('Desktop privacy AWS forwarding',()=>{
  it('requires sign-in and a pinned AWS origin before any network access',async()=>{
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    await expect(requestPrivacyOperation(null,{action:'list',includeClosed:false})).rejects.toThrow('reauth_required');
    for(const origin of ['','http://abcdefghij.execute-api.us-east-2.amazonaws.com','https://example.com','https://user:secret@abcdefghij.execute-api.us-east-2.amazonaws.com','https://abcdefghij.execute-api.us-east-2.amazonaws.com/not-root']){
      vi.stubEnv('CLINICAL_AWS_PRIVACY_OPERATIONS_ORIGIN',origin);
      await expect(requestPrivacyOperation('test-token',{action:'list',includeClosed:false})).rejects.toThrow('service_unavailable');
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('forwards to only the separate workforce endpoint without caching or redirects',async()=>{
    vi.stubEnv('CLINICAL_AWS_PRIVACY_OPERATIONS_ORIGIN','https://abcdefghij.execute-api.us-east-2.amazonaws.com');
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({data:{items:[],nextAfter:null}})));vi.stubGlobal('fetch',fetcher);
    expect(await requestPrivacyOperation('test-token',{action:'list',includeClosed:false})).toEqual({items:[],nextAfter:null});
    expect(fetcher).toHaveBeenCalledWith('https://abcdefghij.execute-api.us-east-2.amazonaws.com/clinical-core/workforce/privacy-operations',
      expect.objectContaining({cache:'no-store',redirect:'error',headers:expect.objectContaining({Authorization:'Bearer test-token'})}));
  });
  it('rejects malformed responses and never exposes provider errors',async()=>{
    vi.stubEnv('CLINICAL_AWS_PRIVACY_OPERATIONS_ORIGIN','https://abcdefghij.execute-api.us-east-2.amazonaws.com');
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    for(const data of [{items:[],nextAfter:'11111111-1111-4111-8111-111111111111'}, {secret:'SQL body'}]){
      fetcher.mockResolvedValue(new Response(JSON.stringify({data})));
      await expect(requestPrivacyOperation('test-token',{action:'list',includeClosed:false})).rejects.toThrow('service_unavailable');
    }
    fetcher.mockResolvedValue(new Response('secret patient error',{status:403}));
    await expect(requestPrivacyOperation('test-token',{action:'list',includeClosed:false})).rejects.toThrow('privacy_access_refused');
  });
});
