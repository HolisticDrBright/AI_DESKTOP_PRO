/** Fictional test transport only. Saved hosted fields seed negative tests;
 * this helper never supplies a public observer or execution authority. */
import {readFileSync} from 'node:fs';
import {CARE_CANONICAL as M} from '../care-canonical-migrations.mjs';
import {CARE_RELEASE as P} from '../synthetic-care-release.mjs';
export function careRegisteredDatabaseFixture(current,now){
 const saved=JSON.parse(readFileSync(new URL('../../docs/evidence/2026-10-08-catalog-preserving-apply.json',import.meta.url),'utf8')).after;
 const {operatorSource,awsAccountId,foundation,databaseMutationPerformed,apiDeploymentPerformed,phiActivation,...catalogInspection}=saved;
 void operatorSource;void awsAccountId;void foundation;void databaseMutationPerformed;void apiDeploymentPerformed;void phiActivation;
 return {contract:'care-catalog-canonical-registration-inspection/1',execution:'synthetic-staging',
  canonicalRegistered:true,alreadyApplied:true,sourceMigrationCount:47,liveMigrationCount:48,
  sourceLedgerSha256:M.sourceSha256,liveLedgerSha256:M.liveSha256,referenceLedgerSha256:M.referenceSha256,
  referenceMigrationCount:3,historicalReferenceCount:2,historicalReferenceSha256:M.referenceParentSha256,
  historicalAliasPreserved:true,catalogInspection,
  ...Object.fromEntries(['schemaReplayPerformed','ledgerRewritePerformed','apiDeploymentPerformed','erasureAccepted',
   'releaseAccepted','physicalDeviceAcceptance','activationApproved','phiAllowed'].map(k=>[k,false])),
  operatorSource:{sourceCommit:current.desktop.commit,clean:true},awsAccountId:P.account,foundation:P.foundation,
  observedAt:new Date(now).toISOString(),repeatedReadbackVerified:true,reportIsNotAuthority:true};
}
