import { StopExecutionCommand, type SFNClient } from '@aws-sdk/client-sfn';

/** Names derive only from the configured lab machine and a validated owned job.
 * No caller-supplied execution ARN, workflow input, health payload or error cause. */
export async function stopLabExecutions(sfn:SFNClient,stateMachineArn:string,jobId:string) {
  if(!/^arn:aws:states:[a-z0-9-]+:\d{12}:stateMachine:[a-z0-9-]+-(?:synthetic|personal)-lab-analysis$/.test(stateMachineArn)
    ||! /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId))
    throw new Error('lab_cancellation_configuration_invalid');
  for(const prefix of ['lab','lab-plan']){
    const executionArn=stateMachineArn.replace(':stateMachine:',':execution:')+`:${prefix}-${jobId}`;
    try{
      const response=await sfn.send(new StopExecutionCommand({executionArn}),{abortSignal:AbortSignal.timeout(15000)});
      if(!(response.stopDate instanceof Date)||!Number.isFinite(response.stopDate.getTime()))
        throw new Error('lab_cancellation_stop_unconfirmed');
    }catch(error){
      if((error as {name?:unknown})?.name!=='ExecutionDoesNotExist')throw error;
    }
  }
}
