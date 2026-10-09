import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {applyVoiceBackfill,planVoiceBackfill,VOICE_BACKFILL_SCOPE,voiceBackfillHash,type BackfillAws} from './voice-watch-backfill';

async function main(){
  const [mode,path,approval,...extra]=process.argv.slice(2);
  if(extra.length||!path||!approval||!['--plan','--apply'].includes(mode)){
    console.error('Usage: backfill.cjs --plan PRIVATE_PLAN_PATH REVIEWED_ZIP_SHA256_BASE64 | --apply PRIVATE_PLAN_PATH APPROVED_PLAN_SHA256');
    process.exitCode=2;return;
  }
  const aws:BackfillAws=async args=>{
    try{
      return JSON.parse(execFileSync('aws',[...args,'--profile','ai-synthetic-staging','--region',VOICE_BACKFILL_SCOPE.region,
        '--output','json','--no-cli-pager'],{encoding:'utf8',timeout:30000,maxBuffer:20_000_000,
        windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,AWS_PAGER:'',AWS_CLI_AUTO_PROMPT:'off'}})||'{}');
    }catch(caught){
      const stderr=caught&&typeof caught==='object'&&'stderr' in caught?String(caught.stderr):'';
      if(args[0]==='dynamodb'&&args[1]==='update-item'&&/\(ConditionalCheckFailedException\)/.test(stderr))
        throw Object.assign(new Error('conditional_conflict'),{name:'ConditionalCheckFailedException'});
      throw new Error('voice_backfill_aws_unavailable');
    }
  };
  try{
    if(mode==='--plan'){
      const plan=await planVoiceBackfill(aws,approval),serialized=JSON.stringify(plan,null,2)+'\n';
      // Never overwrite another review; keep the metadata plan outside git/cloud sync.
      writeFileSync(path,serialized,{flag:'wx',mode:0o600});
      console.log(JSON.stringify({readOnly:true,inspected:plan.inspected,eligible:plan.entries.length,
        skipped:plan.skipped,planSha256:voiceBackfillHash(serialized),cleanupVerified:false}));
    }else console.log(JSON.stringify(await applyVoiceBackfill(aws,readFileSync(path,'utf8'),approval)));
  }catch{console.error('voice_backfill_refused_or_partial; reinspect before retry; no cleanup completion claimed');process.exitCode=1;}
}
void main();
