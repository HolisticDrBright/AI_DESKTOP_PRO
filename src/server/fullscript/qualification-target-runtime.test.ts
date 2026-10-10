import {beforeEach,expect,it,vi} from 'vitest';
import type {FullscriptQualificationEvent} from './qualification-api';
const ports=vi.hoisted(()=>({load:vi.fn(),store:vi.fn(),construct:vi.fn(),handler:vi.fn(),credentialLoader:vi.fn(),secret:vi.fn()}));
vi.mock('./qualification-target-loader',()=>({loadFullscriptQualificationTarget:ports.load,nativeFullscriptTargetStore:ports.store}));
vi.mock('./qualification-observer',()=>({createNativeFullscriptQualificationApi:ports.construct}));
vi.mock('./qualification-provider-environment',()=>({nativeFullscriptProviderEnvironmentLoader:ports.credentialLoader}));
import {createNativeFullscriptTargetRuntime} from './qualification-target-runtime';
const context={invokedFunctionArn:'arn:aws:lambda:us-east-2:588966314750:function:FICTIONAL:1',functionVersion:'1'};
beforeEach(()=>{vi.clearAllMocks();ports.load.mockResolvedValue({FICTIONAL:'target'});ports.construct.mockReturnValue(ports.handler);
 ports.handler.mockResolvedValue({statusCode:200,body:'FICTIONAL',headers:{}});ports.credentialLoader.mockReturnValue(ports.secret);});
const run=createNativeFullscriptTargetRuntime({sourceCommit:'a'.repeat(40),clean:true});
it('unknown routes perform no stored-target or provider construction',async()=>{
 expect((await run({routeKey:'POST /unknown'},context)).statusCode).toBe(404);expect(ports.load).not.toHaveBeenCalled();expect(ports.construct).not.toHaveBeenCalled();
});
it('only the native stored target supplies API construction, never request fields',async()=>{
 const event={routeKey:'POST /clinical-core/consumer/fullscript/draft',body:JSON.stringify({target:'unsafe'})};
 await run(event,context);expect(ports.construct).toHaveBeenCalledExactlyOnceWith({FICTIONAL:'target'},ports.secret);
 expect(ports.load.mock.calls[0][0]).not.toHaveProperty('body');expect(ports.handler).toHaveBeenCalledExactlyOnceWith(event,context);
 expect(ports.secret).not.toHaveBeenCalled();
});
it('target refusal prevents service construction and returns no internal text or success marker',async()=>{
 ports.load.mockRejectedValue(Error('FICTIONAL credential or provider detail'));
 const reply=await run({routeKey:'POST /clinical-core/workforce/fullscript/draft'} as FullscriptQualificationEvent,context);
 expect(reply.statusCode).toBe(503);expect(reply.body).toBe(JSON.stringify({error:'fullscript_delivery_refused',phiAllowed:false}));
 expect(reply.headers).not.toHaveProperty('x-clinical-execution');expect(ports.construct).not.toHaveBeenCalled();
 expect(ports.credentialLoader).not.toHaveBeenCalled();
});
it('native construction failure is not a fallback or a disclosure',async()=>{
 ports.construct.mockImplementation(()=>{throw Error('FICTIONAL service configuration');});
 expect((await run({routeKey:'POST /clinical-core/consumer/fullscript/draft'},context)).body).not.toContain('FICTIONAL');
 expect(ports.handler).not.toHaveBeenCalled();
});
