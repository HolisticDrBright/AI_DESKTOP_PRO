/** Complete fictional deployment witnesses, never imported by live operators. */
import {catalogRuntimeProposalFixture} from './catalog-runtime-proposal.mjs';
import {careRegisteredDatabaseFixture} from './care-registered-database.mjs';
export function catalogRuntimeDeploymentFixture(){
 const f=catalogRuntimeProposalFixture(),database=careRegisteredDatabaseFixture(f.current,f.now);
 const before={observedAt:new Date(f.now).toISOString(),raw:structuredClone(f.raw),database,
  input:structuredClone(f.input),binding:structuredClone(f.binding),summary:structuredClone(f.summary),
  detailed:structuredClone(f.detailed),template:structuredClone(f.input.template)};
 const after=structuredClone({observedAt:new Date(f.now+30000).toISOString(),raw:before.raw,database,
  summary:before.summary,detailed:before.detailed,template:before.template});
 after.database.observedAt=after.observedAt;
 after.raw.template=structuredClone(f.input.template);after.raw.stack.Stacks[0].Parameters=structuredClone(f.summary.Parameters);
 after.raw.fn.CodeSha256=Buffer.from(f.candidate.manifest.zipSha256,'hex').toString('base64');
 after.raw.fn.CodeSize=f.candidate.zip.length;after.raw.fn.RevisionId='fictional-catalog-new-revision';
 after.summary.ExecutionStatus='EXECUTE_COMPLETE';after.detailed.ExecutionStatus='EXECUTE_COMPLETE';
 const witness={contract:'synthetic-catalog-runtime-deployment-observation/1',current:f.current,artifact:f.artifact,
  executionAdmittedAt:new Date(f.now+1000).toISOString(),before,after,codeBytes:Buffer.from(f.candidate.zip)};
 return {...f,before,after,witness,started:f.now-1000,completed:f.now+30000};
}
