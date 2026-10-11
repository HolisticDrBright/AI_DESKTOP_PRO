import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {SUCCESSOR_QUALIFICATION_RELEASE} from '../../../scripts/successor-qualification-release.mjs';
const ports=vi.hoisted(()=>({load:vi.fn(),store:vi.fn(),construct:vi.fn(),handler:vi.fn(),provider:vi.fn(),secret:vi.fn()}));
vi.mock('./qualification-target-loader',async original=>({
 ...await original<typeof import('./qualification-target-loader')>(),
 loadSuccessorFullscriptQualificationTarget:ports.load,nativeFullscriptTargetStore:ports.store,
}));
vi.mock('./qualification-observer',async original=>({
 ...await original<typeof import('./qualification-observer')>(),createSuccessorNativeFullscriptQualificationApi:ports.construct,
}));
vi.mock('./qualification-provider-environment',async original=>({
 ...await original<typeof import('./qualification-provider-environment')>(),nativeFullscriptProviderEnvironmentLoader:ports.provider,
}));
import {createSuccessorNativeFullscriptTargetRuntime} from './qualification-target-runtime';
// Composition seams only; not hosted metadata, credential or delivery proof.
const build={...SUCCESSOR_QUALIFICATION_RELEASE,sourceCommit:'a'.repeat(40),sourceInputSha256:'b'.repeat(64),sourceClean:true};
const context={invokedFunctionArn:'arn:aws:lambda:us-east-2:588966314750:function:FICTIONAL:7',functionVersion:'7'};
const event={routeKey:'POST /clinical-core/consumer/fullscript/draft'};
beforeEach(()=>{
 vi.clearAllMocks();
 for(const [key,value] of Object.entries({AWS_REGION:'us-east-2',DEPLOYMENT_ACCOUNT_ID:'588966314750',PHI_ALLOWED:'false',
  PRODUCTION_ACTIVATION:'blocked',QUALIFICATION_EXECUTION:'true',QUALIFICATION_ACCOUNT_ID:'588966314750',
  QUALIFICATION_REVIEW_SHA256:'c'.repeat(64),QUALIFICATION_IDENTITY_SUBJECTS:'fictional-consumer,fictional-workforce',
  SOURCE_COMMIT:build.sourceCommit,FULLSCRIPT_SOURCE_COMMIT:build.sourceCommit,SOURCE_INPUT_SHA256:build.sourceInputSha256,
  SUCCESSOR_QUALIFICATION_PROFILE:build.qualificationProfile,MIGRATION_RELEASE_SHA256:build.migrationReleaseSha256,
  MIGRATION_ASSEMBLY_SHA256:build.migrationAssemblySha256,CLINICAL_DATABASE_NAME:'clinical_core_qualification',
  CLINICAL_DATABASE_CLUSTER_ARN:'arn:aws:rds:us-east-2:588966314750:cluster:fictional',
  CLINICAL_DATABASE_SECRET_ARN:'arn:aws:secretsmanager:us-east-2:588966314750:secret:alp/qualification/fullscript-worker-fictional-AbCd12'}))
  vi.stubEnv(key,value);
 vi.stubEnv('INVENTORY_QUALIFICATION_PROFILE',undefined);
 ports.load.mockResolvedValue({FICTIONAL:'reviewed-target'});ports.store.mockReturnValue({FICTIONAL:'store'});
 ports.construct.mockReturnValue(ports.handler);ports.handler.mockResolvedValue({statusCode:200,body:'FICTIONAL',headers:{}});
 ports.provider.mockReturnValue(ports.secret);ports.secret.mockResolvedValue({NODE_ENV:'production'});
});
afterEach(()=>vi.unstubAllEnvs());
it('admitted native composition uses only immutable loader output and leaves consumer credentials inert',async()=>{
 const result=await createSuccessorNativeFullscriptTargetRuntime(build)({...event,body:'{"target":"ignored"}'},context);
 expect(result.statusCode).toBe(200);expect(ports.construct.mock.calls[0][0]).toEqual({FICTIONAL:'reviewed-target'});
 expect(ports.load.mock.calls[0][0].build).toEqual(build);expect(ports.load.mock.calls[0][0]).not.toHaveProperty('body');
 expect(ports.secret).not.toHaveBeenCalled();
});
it.each(['SOURCE_INPUT_SHA256','MIGRATION_ASSEMBLY_SHA256','CLINICAL_DATABASE_SECRET_ARN','QUALIFICATION_IDENTITY_SUBJECTS'])
('bad %s refuses before any target/store/provider construction',async key=>{
 vi.stubEnv(key,'wrong');const result=await createSuccessorNativeFullscriptTargetRuntime(build)(event,context);
 expect(result.statusCode).toBe(503);expect(result.headers).not.toHaveProperty('x-clinical-execution');
 for(const port of [ports.load,ports.store,ports.construct,ports.provider,ports.secret])expect(port).not.toHaveBeenCalled();
});
it('source is defensively copied and per-invocation tracing alone may change',async()=>{
 const input={...build},run=createSuccessorNativeFullscriptTargetRuntime(input);input.sourceInputSha256='d'.repeat(64);
 vi.stubEnv('_X_AMZN_TRACE_ID','fictional-request-trace');expect((await run(event,context)).statusCode).toBe(200);
});
it('environment drift during target read refuses before API/provider construction',async()=>{
 ports.load.mockImplementation(async()=>{vi.stubEnv('SOURCE_INPUT_SHA256','d'.repeat(64));return {FICTIONAL:'target'};});
 const response=await createSuccessorNativeFullscriptTargetRuntime(build)(event,context);
 expect(response.statusCode).toBe(503);expect(ports.construct).not.toHaveBeenCalled();expect(ports.provider).not.toHaveBeenCalled();
});
it('late environment drift refuses before provider secret reads and withholds response',async()=>{
 ports.handler.mockImplementation(async()=>{
  vi.stubEnv('FULLSCRIPT_PROVIDER_SECRET_ARN','altered');
  await ports.construct.mock.calls[0][1]();return {statusCode:200};
 });
 const response=await createSuccessorNativeFullscriptTargetRuntime(build)(event,context);
 expect(response.statusCode).toBe(503);expect(ports.secret).not.toHaveBeenCalled();
});
it('unknown route is inert and disabled build cannot fetch a target',async()=>{
 const run=createSuccessorNativeFullscriptTargetRuntime({...build,sourceClean:false});
 expect((await run({routeKey:'POST /unknown'},context)).statusCode).toBe(404);
 expect((await run(event,context)).statusCode).toBe(503);expect(ports.store).not.toHaveBeenCalled();
});
