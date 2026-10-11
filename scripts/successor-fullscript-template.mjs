import {fullscriptQualificationTemplate} from './fullscript-qualification-template.mjs';
import {SUCCESSOR_QUALIFICATION_RELEASE as release} from './successor-qualification-release.mjs';
const ref=name=>({Ref:name}),eq=(a,b)=>({'Fn::Equals':[a,b]});
/** A separate template. The historical 111/112 templates are untouched.
 * The adapter carries the observed clean state; it never fabricates one. */
export function successorFullscriptTemplate(build){
 if(build?.contract!=='successor-fullscript-api-build/1'||build.sourceClean!==true
  ||!/^[a-f0-9]{64}$/.test(build.sourceInputSha256??'')||build.sourceInputSha256==='0'.repeat(64)
  ||Object.entries(release).some(([key,value])=>build[key]!==value))throw Error('successor_fullscript_template_refused');
 const parent=fullscriptQualificationTemplate({...build,contract:'fullscript-api-build/1',clean:build.sourceClean});
 const template=structuredClone(parent);
 template.Metadata={...parent.Metadata,Contract:'successor-fullscript-qualification-candidate/1',
  TargetContract:'fullscript-qualification-target-release/4',SchemaRelease:'clinical-successor-qualification/117',
  SourceInputSha256:build.sourceInputSha256,SourceClean:build.sourceClean,QualificationProfile:release.qualificationProfile,
  MigrationCount:release.migrationCount,MigrationReleaseSha256:release.migrationReleaseSha256,
  MigrationAssemblySha256:release.migrationAssemblySha256,CredentialRole:'fullscript_draft_worker'};
 for(const [name,value] of Object.entries({SourceInputSha256:build.sourceInputSha256,SourceClean:String(build.sourceClean),
  SuccessorQualificationProfile:release.qualificationProfile,MigrationReleaseSha256:release.migrationReleaseSha256,
  MigrationAssemblySha256:release.migrationAssemblySha256}))
  template.Parameters[name]={Type:'String',Default:value,AllowedValues:[value]};
 template.Parameters.QualificationIdentitySubjects={Type:'String',
  AllowedPattern:'^[A-Za-z0-9:_-]{8,128}(,[A-Za-z0-9:_-]{8,128}){2,15}$'};
 template.Parameters.DatabaseSecretArn.AllowedPattern='^arn:aws:secretsmanager:us-east-2:588966314750:secret:alp/qualification/fullscript-worker-[A-Za-z0-9-]+$';
 template.Parameters.FunctionName.AllowedPattern='^alp-fullscript-successor-qualification-[a-z0-9-]{1,20}$';
 const codeKey=`fullscript/successor-qualification-api/${build.sourceCommit}/${build.sourceInputSha256}/function.zip`;
 template.Parameters.CodeKey={Type:'String',Default:codeKey,AllowedValues:[codeKey]};
 template.Conditions.HistoricalEnabled=parent.Conditions.Enabled;
 template.Conditions.SuccessorBinding={'Fn::And':[
  eq(ref('SourceCommit'),build.sourceCommit),eq(ref('SourceClean'),'true'),eq(ref('SourceInputSha256'),build.sourceInputSha256),
  eq(ref('SuccessorQualificationProfile'),release.qualificationProfile),
  eq(ref('MigrationReleaseSha256'),release.migrationReleaseSha256),eq(ref('MigrationAssemblySha256'),release.migrationAssemblySha256)]};
 template.Conditions.Enabled={'Fn::And':[{Condition:'HistoricalEnabled'},{Condition:'SuccessorBinding'}]};
 Object.assign(template.Resources.Function.Properties.Environment.Variables,{
  SOURCE_COMMIT:ref('SourceCommit'),SOURCE_INPUT_SHA256:ref('SourceInputSha256'),DEPLOYMENT_ACCOUNT_ID:'588966314750',
  SUCCESSOR_QUALIFICATION_PROFILE:ref('SuccessorQualificationProfile'),MIGRATION_RELEASE_SHA256:ref('MigrationReleaseSha256'),
  MIGRATION_ASSEMBLY_SHA256:ref('MigrationAssemblySha256'),QUALIFICATION_IDENTITY_SUBJECTS:ref('QualificationIdentitySubjects'),
 });
 for(const name of ['SourceInputSha256','MigrationReleaseSha256','MigrationAssemblySha256'])
  template.Outputs[name]={Value:ref(name)};
 return {parent,template};
}
