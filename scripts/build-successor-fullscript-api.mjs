// Exact-source local build only. No AWS requests, target reviews or activation.
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {build as bundle} from 'esbuild';
import {inventorySourceIdentity} from './inventory-qualification-source.mjs';
import {careMessagingZip} from './care-messaging-zip.mjs';
import {successorFullscriptTemplate} from './successor-fullscript-template.mjs';
import {SUCCESSOR_QUALIFICATION_RELEASE,successorQualificationReleaseArtifact} from './successor-qualification-release.mjs';
const args=process.argv.slice(2);
if(args.length>1||args.length&&!/^--out-dir=.+$/.test(args[0]))throw Error('successor_fullscript_argument_refused');
const identity=inventorySourceIdentity();
if(identity.sourceClean!==true)throw Error('successor_fullscript_clean_source_required');
const out=resolve(args.length?args[0].slice(10):'dist/aws-clinical-core/successor-fullscript-api');
const compiled={...identity,...SUCCESSOR_QUALIFICATION_RELEASE};
const raw=execFileSync(process.execPath,['scripts/build-telehealth-transfer-authority-candidate.mjs','--json'],{
 encoding:'utf8',timeout:60000,maxBuffer:16*1024*1024,windowsHide:true});
const release=successorQualificationReleaseArtifact(JSON.parse(raw));
const sha=v=>createHash('sha256').update(v).digest('hex'),json=v=>JSON.stringify(v,null,2)+'\n';
mkdirSync(out,{recursive:true});
const contents="import {createSuccessorNativeFullscriptTargetRuntime} from './src/server/fullscript/qualification-target-runtime';\n"
 +"export const handler=createSuccessorNativeFullscriptTargetRuntime("+JSON.stringify(compiled)+");";
await bundle({stdin:{contents,resolveDir:process.cwd(),sourcefile:'successor-fullscript.ts',loader:'ts'},
 outfile:join(out,'index.js'),bundle:true,platform:'node',target:'node22',format:'cjs',minify:true,sourcemap:false,legalComments:'none'});
const code=readFileSync(join(out,'index.js')),zip=careMessagingZip(code);
const manifest={contract:'successor-fullscript-api-build/1',...compiled,handler:'index.handler',runtime:'nodejs22.x',
 indexSha256:sha(code),zipSha256:sha(zip),codeSha256:createHash('sha256').update(zip).digest('base64'),zipBytes:zip.length,
 execution:'qualification_only',phiAllowed:false,activation:'blocked',targetEmbedded:false,
 targetContract:'fullscript-qualification-target-release/4',immutableTargetVersionRequired:true,targetReviewRequired:true,
 publishedVersionRequired:true,credentialRole:'fullscript_draft_worker',deployed:false,hostedQualified:false,providerActionPerformed:false,
 completeFleetQualified:false,targetBindingComplete:false,sourceCandidateSha256:sha(raw)};
const {parent,template}=successorFullscriptTemplate(manifest),templateBytes=Buffer.from(json(template));
manifest.templateSha256=sha(templateBytes);manifest.parentTemplateSha256=sha(json(parent));
if(JSON.stringify(inventorySourceIdentity())!==JSON.stringify(identity))throw Error('successor_fullscript_source_changed');
writeFileSync(join(out,'function.zip'),zip);writeFileSync(join(out,'template.json'),templateBytes);
writeFileSync(join(out,'historical-template.json'),json(parent));writeFileSync(join(out,'release-artifact.json'),json(release));
writeFileSync(join(out,'artifact-manifest.json'),json(manifest));
console.log(JSON.stringify(manifest));
