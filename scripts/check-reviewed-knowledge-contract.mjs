import {build} from 'esbuild';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Cross-repository synthetic contract check. No emitted files, private key output,
// model request, source-package modification, or real clinical signing.
const v2=process.argv[2];if(!v2)throw new Error('Pass the V2 repository path.');
async function compiled(path){const result=await build({entryPoints:[path],bundle:true,write:false,platform:'node',target:'node22',format:'esm',logLevel:'silent'});return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);}
const {prepareReviewedKnowledge}=await import(pathToFileURL(resolve(v2,'scripts/prepare-reviewed-knowledge.mjs')).href);
const {verifyKnowledgeRelease,retrieveKnowledge,verifyPresentedKnowledge}=await compiled(resolve('src/server/clinical-core/reviewed-knowledge.ts'));
const {reviewedKnowledgeSchema}=await compiled(resolve(v2,'expo/backend/chat/reviewed-knowledge.ts'));
const source=JSON.stringify([{id:'fixture-001',contentType:'clinical_pearl',reviewStatus:'approved_patient_guidance',patientFacingEligible:true,
  verification:'V',review:{decision:'patient',decidedBy:'Synthetic reviewer',decidedAt:'2026-09-01',via:'Synthetic review',note:null},
  contested:false,pearl:'Fictional authoring note.'}]);
const release=prepareReviewedKnowledge(source,{version:'fixture/1',issuedAt:'2026-09-14T00:00:00Z',expiresAt:'2027-09-14T00:00:00Z',sourcePackageSha256:createHash('sha256').update(source).digest('hex'),entries:[{
  id:'fixture-reference',sourcePearlId:'fixture-001',topic:'Fictional marker',summary:'Fictional reviewed explanation.',limitations:'Synthetic only, not clinical guidance.',biomarkerAliases:['Fictional marker'],use:'education_only',reviewStatus:'approved',contested:false,reviewedBy:'synthetic-reviewer',reviewedAt:'2026-09-13T00:00:00Z',sources:[{id:'fixture-source',title:'Fictional guideline',url:'https://example.org/fixture',evidenceType:'guideline'}],
}]});
const payload=JSON.stringify(release);const keys=generateKeyPairSync('ed25519');
const trusted={sha256:createHash('sha256').update(payload).digest('hex'),publicKeyPem:keys.publicKey.export({type:'spki',format:'pem'}).toString()};
const verified=verifyKnowledgeRelease({payload,signature:sign(null,Buffer.from(payload),keys.privateKey).toString('base64')},trusted,Date.parse('2026-09-14T12:00:00Z'));
const context=retrieveKnowledge(verified,{biomarkerNames:['Fictional marker']},Date.parse('2026-09-14T12:00:00Z'));
const consumer=reviewedKnowledgeSchema.parse(JSON.parse(JSON.stringify(context)));
assert.deepEqual(verifyPresentedKnowledge(consumer,context),context);
assert.equal(consumer.references.length,1);assert.equal(consumer.references[0].use,'education_only');
assert.equal(consumer.references[0].sourcePearlSha256,release.entries[0].sourcePearlSha256);
assert.throws(()=>verifyPresentedKnowledge({...consumer,references:[{...consumer.references[0],summary:'Injected instruction'}]},context));
console.log('PASS: fictional source → unsigned review payload → ephemeral signature → Desktop verifier/retrieval → V2 schema → provider revalidation; forged content refused. No live API or clinical content used.');
