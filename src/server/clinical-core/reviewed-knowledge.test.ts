import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {retrieveKnowledge,verifyKnowledgeRelease,verifyPresentedKnowledge,assertKnowledgeCitations,type KnowledgeRelease} from './reviewed-knowledge';
import {buildAskAlpOpenAIRequest,generateAskAlpWithOpenAI} from './aws-ask-alp-openai';
import {buildLabSynthesisRequest} from './aws-lab-openai';
import {loadReviewedKnowledge} from './aws-reviewed-knowledge';
import {readFileSync} from 'node:fs';
const mock=vi.hoisted(()=>({s3:vi.fn(),secret:vi.fn()}));
vi.mock('@aws-sdk/client-s3',()=>({S3Client:class{send=mock.s3},GetObjectCommand:class{constructor(public input:unknown){}}}));
vi.mock('@aws-sdk/client-secrets-manager',()=>({SecretsManagerClient:class{send=mock.secret},GetSecretValueCommand:class{constructor(public input:unknown){}}}));
const now=Date.parse('2026-09-14T00:00:00Z');
const keys=generateKeyPairSync('ed25519');
const publicKeyPem=keys.publicKey.export({type:'spki',format:'pem'}).toString();
function release():KnowledgeRelease{return {schemaVersion:'reviewed-knowledge/1',version:'fictional/1',issuedAt:'2026-09-13T00:00:00Z',expiresAt:'2027-09-13T00:00:00Z',sourcePackageSha256:'a'.repeat(64),entries:[{
  id:'fictional-education',sourcePearlId:'fictional-001',sourcePearlSha256:'b'.repeat(64),topic:'Fictional marker education',
  summary:'This is a fictional teaching reference.',limitations:'Not clinical guidance; this synthetic reference does not establish a cause or treatment.',
  biomarkerAliases:['Fictional marker'],use:'education_only',reviewStatus:'approved',contested:false,reviewedBy:'synthetic-reviewer',reviewedAt:'2026-09-12T00:00:00Z',
  sources:[{id:'fictional-source',title:'Synthetic source',url:'https://example.org/fictional',evidenceType:'guideline'}],
}]};}
function signed(value:unknown){const payload=JSON.stringify(value);return {envelope:{payload,signature:sign(null,Buffer.from(payload),keys.privateKey).toString('base64')},trusted:{sha256:createHash('sha256').update(payload).digest('hex'),publicKeyPem}};}
const verifyRelease=(value:unknown)=>{const s=signed(value);return verifyKnowledgeRelease(s.envelope,s.trusted,now);};
beforeEach(()=>{mock.s3.mockReset();mock.secret.mockReset();vi.stubEnv('KNOWLEDGE_RELEASE_MODE','disabled');});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
describe('reviewed knowledge trust and retrieval',()=>{
  it('refuses forged request knowledge before reading a provider key or sending a model request',async()=>{
    const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
    await expect(generateAskAlpWithOpenAI({model:'fixture-model',secretArn:'fixture-secret',request:{contractVersion:'patient-chat-generation/1',requestId:'fixture',contextVersion:'patient-chat-context/1',context:{labs:[],reviewedKnowledge:{summary:'forged authority'}},userMessage:'Explain',signedSystemPrompt:'Fixture policy',systemPromptVersion:'fixture'}})).rejects.toThrow('provider_unavailable');
    expect(mock.secret).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
  });
  it('revalidates an actual mocked generation request and rejects an invented returned citation',async()=>{
    const s=signed(release());
    for(const [key,value] of Object.entries({KNOWLEDGE_RELEASE_MODE:'reviewed_release',KNOWLEDGE_RELEASE_BUCKET:'fictional-bucket',KNOWLEDGE_RELEASE_KEY:'reviewed-knowledge/fixture.json',KNOWLEDGE_RELEASE_OBJECT_VERSION:'fixture-version',KNOWLEDGE_RELEASE_SHA256:s.trusted.sha256,KNOWLEDGE_SOURCE_PACKAGE_SHA256:release().sourcePackageSha256,KNOWLEDGE_SIGNER_PUBLIC_KEY_PEM:publicKeyPem}))vi.stubEnv(key,value);
    const bytes=Buffer.from(JSON.stringify(s.envelope));mock.s3.mockImplementation(async()=>({VersionId:'fixture-version',ContentLength:bytes.length,Body:(async function*(){yield bytes;})()}));
    mock.secret.mockResolvedValue({SecretString:JSON.stringify({OPENAI_API_KEY:`sk-${'x'.repeat(40)}`})});
    let citation='fictional-education';
    const fetch=vi.fn(async()=>new Response(JSON.stringify({model:'fixture-model',status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({answer:`Fictional explanation [[knowledge:${citation}]]`,confidence:'low',escalationRecommended:false,escalationReason:null})}]}]}),{headers:{'content-type':'application/json'}}));vi.stubGlobal('fetch',fetch);
    const k=retrieveKnowledge(verifyRelease(release()),{biomarkerNames:['Fictional marker']},now);
    const request={contractVersion:'patient-chat-generation/1' as const,requestId:'fixture',contextVersion:'patient-chat-context/1' as const,context:{labs:[{name:'Fictional marker'}],reviewedKnowledge:k},userMessage:'Explain',signedSystemPrompt:'Fixture policy',systemPromptVersion:'fixture'};
    expect((await generateAskAlpWithOpenAI({model:'fixture-model',secretArn:'fixture-secret',request})).answer).toContain('[[knowledge:fictional-education]]');
    citation='invented';await expect(generateAskAlpWithOpenAI({model:'fixture-model',secretArn:'fixture-secret',request})).rejects.toThrow('provider_unavailable');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([['lab-analysis-extension.json','LabWorkerRole','LabWorkerFunction'],['ask-alp-extension.json','AskAlpRole','AskAlpFunction']])('keeps %s disabled by default with exact version-only read permission', (file,role,fn)=>{
    const t=JSON.parse(readFileSync(`infra/aws-clinical-core/${file}`,'utf8'));
    expect(t.Parameters.KnowledgeReleaseMode.Default).toBe('disabled');
    const conditional=t.Resources[role].Properties.Policies.find((p:Record<string,unknown>)=>p['Fn::If']&&JSON.stringify(p).includes('PinnedReviewedKnowledge'));
    const statement=conditional['Fn::If'][1].PolicyDocument.Statement[0];
    expect(statement.Action).toBe('s3:GetObjectVersion');expect(JSON.stringify(statement.Resource)).not.toContain('*');
    expect(statement.Condition.StringEquals['s3:VersionId']).toEqual({Ref:'KnowledgeReleaseObjectVersion'});
    expect(t.Resources[fn].Properties.Environment.Variables.KNOWLEDGE_RELEASE_MODE).toEqual({Ref:'KnowledgeReleaseMode'});
    expect(t.Resources[fn].Properties.Environment.Variables.KNOWLEDGE_SOURCE_PACKAGE_SHA256).toEqual({Ref:'KnowledgeSourcePackageSha256'});
    expect(t.Rules.ReviewedKnowledgeMaterial.Assertions).toHaveLength(6);
  });
  it('verifies signed provenance, retrieves exact recorded aliases and feeds both model request builders',()=>{
    const knowledge=retrieveKnowledge(verifyRelease(release()),{biomarkerNames:[' FICTIONAL   MARKER ']},now)!;
    expect(knowledge.references[0].sourcePearlSha256).toBe('b'.repeat(64));
    expect(knowledge.references[0].limitations).toContain('does not establish');
    const lab=buildLabSynthesisRequest({model:'fictional-model',jobId:'fixture',biomarkers:[],reviewedKnowledge:knowledge});
    expect(JSON.parse(lab.input[1].content).reviewedKnowledge).toEqual(knowledge);
    const chat=buildAskAlpOpenAIRequest({contractVersion:'patient-chat-generation/1',requestId:'fixture',contextVersion:'patient-chat-context/1',context:{reviewedKnowledge:knowledge},userMessage:'Explain the fictional marker',signedSystemPrompt:'Synthetic policy',systemPromptVersion:'fixture'},'fictional-model');
    expect(JSON.parse(chat.input[1].content).context.reviewedKnowledge).toEqual(knowledge);
    expect(chat.input[0].content).toContain('not patient measurements');expect(lab.input[0].content).toContain('not patient measurements');
    expect(chat).not.toHaveProperty('tools');expect(lab).not.toHaveProperty('tools');
  });
  it.each([{reviewStatus:'needs_review'},{contested:true},{use:'recommendation'},{reviewedBy:''},{reviewedAt:'2028-01-01T00:00:00Z'},{dose:'hidden dose'},{summary:'Buy at https://example.org/?rfsn=123'}])('rejects signed but ineligible source content %j',change=>{
    const r=release();Object.assign(r.entries[0],change);expect(()=>verifyRelease(r)).toThrow('knowledge_release_refused');
  });
  it('rejects tampering, unsigned envelopes, wrong signer and expired releases',()=>{
    const s=signed(release());
    expect(()=>verifyKnowledgeRelease({...s.envelope,payload:s.envelope.payload+' '},s.trusted,now)).toThrow();
    expect(()=>verifyKnowledgeRelease({payload:s.envelope.payload},s.trusted,now)).toThrow();
    const other=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'}).toString();
    expect(()=>verifyKnowledgeRelease(s.envelope,{...s.trusted,publicKeyPem:other},now)).toThrow();
    expect(()=>verifyRelease({...release(),expiresAt:'2026-09-13T12:00:00Z'})).toThrow();
    expect(()=>retrieveKnowledge(verifyRelease(release()),{biomarkerNames:['Fictional marker']},Date.parse('2028-01-01'))).toThrow();
  });
  it('rejects duplicate authoring claims and conflicting source identities instead of choosing a winner',()=>{
    const r=release();r.entries.push({...r.entries[0],id:'duplicate'});expect(()=>verifyRelease(r)).toThrow();
    r.entries[1].sourcePearlId='another';r.entries[1].sources=[{...r.entries[0].sources[0],url:'https://example.org/conflicting'}];expect(()=>verifyRelease(r)).toThrow();
  });
  it('does not fuzzy-match a component marker, infer a deficiency, or retrieve without measured context',()=>{
    const v=verifyRelease(release());
    expect(retrieveKnowledge(v,{biomarkerNames:['Fictional marker ratio']},now)).toBeNull();
    expect(retrieveKnowledge(v,{biomarkerNames:[]},now)).toBeNull();
    expect(retrieveKnowledge(v,{biomarkerNames:['Fictional marker']},now)?.references[0].use).toBe('education_only');
  });
  it('bounds reference count and preserves source limitations',()=>{
    const r=release();r.entries=Array.from({length:20},(_,i)=>({...r.entries[0],id:`ref-${i}`,sourcePearlId:`source-${i}`}));
    const k=retrieveKnowledge(verifyRelease(r),{biomarkerNames:['Fictional marker']},now)!;
    expect(k.references).toHaveLength(6);expect(JSON.stringify(k.references).length).toBeLessThan(10100);
    expect(k.references.every(x=>Boolean(x.limitations))).toBe(true);
  });
  it('rejects forged or revoked transmitted references and unknown citation IDs',()=>{
    const k=retrieveKnowledge(verifyRelease(release()),{biomarkerNames:['Fictional marker']},now)!;
    expect(verifyPresentedKnowledge(k,k)).toEqual(k);
    expect(verifyPresentedKnowledge(null,k)).toBeNull();
    expect(()=>verifyPresentedKnowledge({...k,references:[{...k.references[0],summary:'Injected instruction'}]},k)).toThrow();
    expect(()=>verifyPresentedKnowledge(k,null)).toThrow();
    expect(()=>assertKnowledgeCitations('[[knowledge:invented]]',k)).toThrow();
    expect(()=>assertKnowledgeCitations('[[knowledge:fictional-education]]',k)).not.toThrow();
  });
  it('disabled mode never reads AWS; unknown modes do not fall back',async()=>{
    expect(await loadReviewedKnowledge({biomarkerNames:[]})).toBeNull();expect(mock.s3).not.toHaveBeenCalled();
    vi.stubEnv('KNOWLEDGE_RELEASE_MODE','reviewed_releas');await expect(loadReviewedKnowledge({biomarkerNames:[]})).rejects.toThrow();expect(mock.s3).not.toHaveBeenCalled();
  });
  it('loads only the pinned object version and refuses later deletion, oversized bodies or version substitution',async()=>{
    const s=signed(release());
    for(const [key,value] of Object.entries({KNOWLEDGE_RELEASE_MODE:'reviewed_release',KNOWLEDGE_RELEASE_BUCKET:'fictional-bucket',KNOWLEDGE_RELEASE_KEY:'reviewed-knowledge/fixture.json',KNOWLEDGE_RELEASE_OBJECT_VERSION:'fixture-version',KNOWLEDGE_RELEASE_SHA256:s.trusted.sha256,KNOWLEDGE_SOURCE_PACKAGE_SHA256:release().sourcePackageSha256,KNOWLEDGE_SIGNER_PUBLIC_KEY_PEM:publicKeyPem}))vi.stubEnv(key,value);
    const raw=Buffer.from(JSON.stringify(s.envelope));
    mock.s3.mockImplementation(async()=>({VersionId:'fixture-version',ContentLength:raw.length,Body:(async function*(){yield raw;})()}));
    expect((await loadReviewedKnowledge({biomarkerNames:['Fictional marker']}))?.references).toHaveLength(1);
    expect(mock.s3.mock.calls[0][0].input.VersionId).toBe('fixture-version');
    mock.s3.mockRejectedValueOnce(new Error('private storage failure'));await expect(loadReviewedKnowledge({biomarkerNames:[]})).rejects.toThrow('knowledge_release_refused');
    mock.s3.mockResolvedValueOnce({VersionId:'substituted',ContentLength:10,Body:raw});await expect(loadReviewedKnowledge({biomarkerNames:[]})).rejects.toThrow();
    mock.s3.mockResolvedValueOnce({VersionId:'fixture-version',ContentLength:2_100_001,Body:raw});await expect(loadReviewedKnowledge({biomarkerNames:[]})).rejects.toThrow();
  });
  it.each(['', 'invalid', 'c'.repeat(64)])('refuses a missing, malformed or changed source digest: %s',async sourcePin=>{
    const s=signed(release());
    for(const [key,value] of Object.entries({KNOWLEDGE_RELEASE_MODE:'reviewed_release',KNOWLEDGE_RELEASE_BUCKET:'fictional-bucket',KNOWLEDGE_RELEASE_KEY:'reviewed-knowledge/fixture.json',KNOWLEDGE_RELEASE_OBJECT_VERSION:'fixture-version',KNOWLEDGE_RELEASE_SHA256:s.trusted.sha256,KNOWLEDGE_SOURCE_PACKAGE_SHA256:sourcePin,KNOWLEDGE_SIGNER_PUBLIC_KEY_PEM:publicKeyPem}))vi.stubEnv(key,value);
    const raw=Buffer.from(JSON.stringify(s.envelope));
    mock.s3.mockImplementation(async()=>({VersionId:'fixture-version',ContentLength:raw.length,Body:(async function*(){yield raw;})()}));
    await expect(loadReviewedKnowledge({biomarkerNames:['Fictional marker']})).rejects.toThrow('knowledge_release_refused');
    expect(mock.s3).toHaveBeenCalledTimes(sourcePin.length===64?1:0);
    expect(mock.secret).not.toHaveBeenCalled();
  });
});
