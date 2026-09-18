import {execFileSync} from 'node:child_process';
import {readVoiceDrainInventory} from './owned-voice-inventory-reader';

async function main(){
  const args=process.argv.slice(2);
  if(args.length!==4||args[0]!=='--read-only'){
    console.error('Usage: node inventory.cjs --read-only ACCOUNT_ID REGION STACK_NAME');
    process.exitCode=2;return;
  }
  const [,account,region,stack]=args;
  const startedAt=new Date().toISOString();
  try{
    const result=await readVoiceDrainInventory({account,region,stack},async command=>{
      // No shell, credentials in arguments, writes, audio/transcript reads or
      // partial output. Timeout/output overflow are sanitized hard failures.
      const raw=execFileSync('aws',[...command,'--region',region,'--output','json','--no-cli-pager'],{
        encoding:'utf8',timeout:30_000,maxBuffer:20_000_000,stdio:['ignore','pipe','pipe'],
        windowsHide:true,env:{...process.env,AWS_PAGER:'',AWS_CLI_AUTO_PROMPT:'off'},
      });
      return JSON.parse(raw);
    });
    console.log(JSON.stringify({startedAt,finishedAt:new Date().toISOString(),...result},null,2));
    if(!result.candidateClear)process.exitCode=3;
  }catch{console.error('voice_inventory_unavailable_or_scope_refused; no completion claimed');process.exitCode=1;}
}
void main();
