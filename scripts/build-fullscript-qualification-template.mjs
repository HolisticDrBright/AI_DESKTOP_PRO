import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fullscriptQualificationTemplate,fullscriptConsentQualificationTemplate} from './fullscript-qualification-template.mjs';
const successor=process.argv.length===3&&process.argv[2]==='--telehealth-consent-copy';
if(process.argv.length!==2&&!successor)throw Error('fullscript_template_arguments_refused');
const out='dist/aws-clinical-core/fullscript-api/';
const build=JSON.parse(readFileSync(out+'artifact-manifest.json','utf8')),zip=readFileSync(out+'function.zip');
if(createHash('sha256').update(zip).digest('hex')!==build.zipSha256)throw Error('fullscript_template_zip_refused');
const template=(successor?fullscriptConsentQualificationTemplate:fullscriptQualificationTemplate)(build),bytes=JSON.stringify(template,null,2)+'\n';
writeFileSync(out+(successor?'template-consent-112.json':'template.json'),bytes);
console.log(JSON.stringify({contract:'fullscript-template-build/1',sourceCommit:build.sourceCommit,
 templateSha256:createHash('sha256').update(bytes).digest('hex'),deployed:false,phiAllowed:false,activation:'blocked'}));
