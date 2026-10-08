import {describe,expect,it,vi} from 'vitest';
import {createProtocolCartSession,type ProtocolCartSessionState} from './protocolCartSession';
import type {ProtocolCartRequest} from '@/contracts/protocolCarts';

const manifestId='11111111-1111-4111-8111-111111111111',versionId='22222222-2222-4222-8222-222222222222';
const compiled=()=>({action:'compile' as const,manifestId,programVersion:1,includedCount:1,excludedCount:0,
  contentSha256:'b'.repeat(64),replayed:false});
const manifest=()=>({action:'read' as const,manifestId,programVersionId:versionId,programVersion:1,status:'compiled' as const,
  versionContentSha256:'a'.repeat(64),contentSha256:'b'.repeat(64),includedCount:1,excludedCount:0,
  lines:[{phaseId:'phase-1',itemId:'item-1',title:'Fictional product',productId:'product-1',dose:'Reviewed fictional dose',
    ingredientKeys:['fictional-ingredient'],purchaseUrl:'https://shop.example.test/product',included:true,exclusionReason:null}],
  delivery:{state:'not_implemented' as const,detail:'Nothing sent'},
});
const deferred=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};};

describe('version scoped protocol cart sessions',()=>{
  it('displays only the verified compiled manifest and preserves replay wording',async()=>{
    const states:ProtocolCartSessionState[]=[];
    const post=vi.fn().mockResolvedValueOnce({...compiled(),replayed:true}).mockResolvedValueOnce(manifest());
    const session=createProtocolCartSession(versionId,post,state=>states.push(state));
    await session.compile();
    expect(states[0]).toMatchObject({busy:true,manifest:null});
    expect(states.at(-1)).toMatchObject({busy:false,manifest:manifest(),error:null});
    expect(states.at(-1)?.notice).toContain('already built');
    expect(post.mock.calls.map(([request])=>request)).toEqual([
      {action:'compile',programVersionId:versionId},{action:'read',manifestId},
    ]);
  });
  it('clears the old list on refresh and does not retain it after authorization loss',async()=>{
    const states:ProtocolCartSessionState[]=[];
    const post=vi.fn().mockResolvedValueOnce(compiled()).mockResolvedValueOnce(manifest())
      .mockRejectedValueOnce(new Error('identity_refused payload must not be exposed'));
    const session=createProtocolCartSession(versionId,post,state=>states.push(state));
    await session.compile();expect(states.at(-1)?.manifest).toEqual(manifest());
    await session.compile();
    expect(states.at(-2)).toMatchObject({busy:true,manifest:null});
    expect(states.at(-1)).toMatchObject({busy:false,manifest:null,notice:null});
    expect(states.at(-1)?.error).not.toContain('payload');
  });
  it('refuses a read for another version and inconsistent compilation receipts',async()=>{
    for(const change of [{programVersionId:'33333333-3333-4333-8333-333333333333'},
      {programVersion:2},{contentSha256:'c'.repeat(64)}]){
      const states:ProtocolCartSessionState[]=[];
      const post=vi.fn().mockResolvedValueOnce(compiled()).mockResolvedValueOnce({...manifest(),...change});
      await createProtocolCartSession(versionId,post,state=>states.push(state)).compile();
      expect(states.at(-1)).toMatchObject({manifest:null,busy:false});
      expect(states.at(-1)?.error).not.toBeNull();
    }
  });
  it('refuses compile/read count discrepancies even when the read is internally consistent',async()=>{
    const states:ProtocolCartSessionState[]=[];
    const post=vi.fn().mockResolvedValueOnce({...compiled(),includedCount:2}).mockResolvedValueOnce(manifest());
    await createProtocolCartSession(versionId,post,state=>states.push(state)).compile();
    expect(states.at(-1)?.manifest).toBeNull();expect(states.at(-1)?.error).not.toBeNull();
  });
  it('disposes a pending compile without reading or reopening a departed version',async()=>{
    const pending=deferred<unknown>(),publish=vi.fn();
    const post=vi.fn<(request:ProtocolCartRequest,signal:AbortSignal)=>Promise<unknown>>(()=>pending.promise);
    const session=createProtocolCartSession(versionId,post,publish),work=session.compile();
    const signal=post.mock.calls[0][1];
    session.dispose();expect(signal.aborted).toBe(true);
    pending.resolve(compiled());await work;
    expect(post).toHaveBeenCalledOnce();expect(publish).toHaveBeenCalledOnce();
    await session.compile();expect(post).toHaveBeenCalledOnce();
  });
  it('ignores a read which completes after the component left its scope',async()=>{
    const pending=deferred<unknown>(),publish=vi.fn();
    const post=vi.fn().mockResolvedValueOnce(compiled()).mockReturnValueOnce(pending.promise);
    const session=createProtocolCartSession(versionId,post,publish),work=session.compile();
    await Promise.resolve();expect(post).toHaveBeenCalledTimes(2);
    session.dispose();pending.resolve(manifest());await work;
    expect(publish).toHaveBeenCalledOnce();
  });
  it('does not admit a second concurrent compile from a double click',async()=>{
    const pending=deferred<unknown>(),publish=vi.fn();
    const post=vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(manifest());
    const session=createProtocolCartSession(versionId,post,publish),work=session.compile();
    await session.compile();expect(post).toHaveBeenCalledOnce();
    pending.resolve(compiled());await work;expect(post).toHaveBeenCalledTimes(2);
  });
  it('refuses malformed compile data before issuing the read request',async()=>{
    const publish=vi.fn(),post=vi.fn().mockResolvedValue({manifestId});
    await createProtocolCartSession(versionId,post,publish).compile();
    expect(post).toHaveBeenCalledOnce();expect(publish.mock.calls.at(-1)?.[0].manifest).toBeNull();
  });
});
