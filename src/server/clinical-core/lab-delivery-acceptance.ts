import {randomUUID} from 'node:crypto';
import {DynamoDBClient,DescribeTableCommand} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,PutCommand,GetCommand,DeleteCommand} from '@aws-sdk/lib-dynamodb';
import {createAwsLabAnalysisApiHandler as handler,LAB_DELIVERY_VERSION,LAB_DELIVERY_ACK_VERSION} from './aws-lab-analysis-api';
import {canonicalPayload} from './aws-consumer-clinical-records';

/** Local real handler -> real synthetic DynamoDB acceptance. NOT hosted JWT,
 * mobile persistence, production consent, model or clinic-transfer evidence. */
async function main(){
  const table=process.env.LAB_JOB_TABLE??'';
  if(process.env.CONFIRM_SYNTHETIC_FIXTURES!=='true'||process.env.PHI_ALLOWED!=='false'||process.env.AWS_REGION!=='us-east-2'
    ||!/^ai-clinical-core-synthetic-staging-lab-analysis-LabJobTable-[A-Za-z0-9]+$/.test(table))throw new Error('synthetic_scope_refused');
  const raw=new DynamoDBClient({region:'us-east-2'}),db=DynamoDBDocumentClient.from(raw);
  const described=await raw.send(new DescribeTableCommand({TableName:table}));
  if(described.Table?.TableStatus!=='ACTIVE'||described.Table.TableArn!==`arn:aws:dynamodb:us-east-2:588966314750:table/${table}`)throw new Error('synthetic_table_refused');
  const owner=randomUUID(),other=randomUUID(),run=randomUUID(),jobs:string[]=[];
  const a='a'.repeat(64),b='b'.repeat(64);let checks=0,retained=0;
  const check=(ok:unknown,label:string)=>{if(!ok)throw new Error(label);checks++;};
  const request=(id:string,version:string,device=a,disposition?:string,subject=owner)=>handler({
    rawPath:`/clinical-core/consumer/labs/jobs/${id}/delivery`,body:JSON.stringify({contractVersion:version,deviceBindingSha256:device,...(disposition?{disposition}:{})}),
    requestContext:{http:{method:'POST'},authorizer:{jwt:{claims:{sub:subject,'custom:person_id':owner,'custom:organization_id':owner,'custom:synthetic_attested':'true'}}}},
  });
  const item=async(id:string)=>(await db.send(new GetCommand({TableName:table,Key:{pk:`job#${id}`},ConsistentRead:true}))).Item;
  async function fixture(){
    const id=randomUUID();jobs.push(id);const now=new Date().toISOString();
    await db.send(new PutCommand({TableName:table,ConditionExpression:'attribute_not_exists(pk)',Item:{pk:`job#${id}`,acceptanceRun:run,ownerSub:owner,organizationId:owner,personId:owner,
      state:'completed',passesCompleted:5,progressPercent:100,attempt:1,createdAt:now,updatedAt:now,expiresAt:Math.floor(Date.now()/1000)+3600,documents:[],failureCategory:null,dataClassification:'synthetic_only',result:{analysisId:id,summary:'Fictional delivery acceptance; no health information.'}}}));return id;
  }
  try{
    const id=await fixture();
    check((await request(id,LAB_DELIVERY_ACK_VERSION,a,'applied')).statusCode===409,'unclaimed_ack_accepted');
    const claims=await Promise.all([request(id,LAB_DELIVERY_VERSION,a),request(id,LAB_DELIVERY_VERSION,b)]);
    check(claims.filter(r=>r.statusCode===200).length===1&&claims.filter(r=>r.statusCode===409).length===1,'claim_race_failed');
    const winner=claims[0].statusCode===200?a:b,loser=winner===a?b:a;
    check(!(await item(id))?.deliveryAcknowledgment,'claim_marked_applied');
    check((await request(id,LAB_DELIVERY_ACK_VERSION,loser,'applied')).statusCode===409,'wrong_device_ack_accepted');
    check((await request(id,LAB_DELIVERY_ACK_VERSION,winner,'applied',other)).statusCode===404,'wrong_owner_ack_accepted');
    const acknowledgments=await Promise.all([request(id,LAB_DELIVERY_ACK_VERSION,winner,'applied'),request(id,LAB_DELIVERY_ACK_VERSION,winner,'applied')]);
    check(acknowledgments.every(r=>r.statusCode===200),'ack_race_failed');
    const receipt=JSON.parse(acknowledgments[0].body).data.acknowledgment;
    check(canonicalPayload(receipt)===canonicalPayload(JSON.parse(acknowledgments[1].body).data.acknowledgment),'ack_replay_changed');
    check(/^[a-f0-9]{64}$/.test(receipt.resultSha256),'result_digest_missing');
    check((await request(id,LAB_DELIVERY_ACK_VERSION,winner,'archived_not_applied')).statusCode===409,'disposition_overwritten');
    check((await request(id,LAB_DELIVERY_VERSION,winner)).statusCode===200,'claim_retry_failed');
    check(canonicalPayload((await item(id))?.deliveryAcknowledgment??{})===canonicalPayload(receipt),'claim_erased_ack');
    const archived=await fixture();await request(archived,LAB_DELIVERY_VERSION,a);
    check((await request(archived,LAB_DELIVERY_ACK_VERSION,a,'archived_not_applied')).statusCode===200,'archive_ack_failed');
    check((await item(archived))?.deliveryAcknowledgment?.disposition==='archived_not_applied','archive_became_applied');
  }finally{
    for(const id of jobs){
      try{await db.send(new DeleteCommand({TableName:table,Key:{pk:`job#${id}`},ConditionExpression:'ownerSub = :owner AND acceptanceRun = :run',ExpressionAttributeValues:{':owner':owner,':run':run}}));}
      catch{ /* Read-back below is authoritative; never delete unrelated rows. */ }
      try{if(await item(id)){retained++;console.error(JSON.stringify({cleanupPending:true,fictionalJobId:id}));}}
      catch{retained++;console.error(JSON.stringify({cleanupUnverified:true,fictionalJobId:id}));}
    }
    console.log(JSON.stringify({version:'lab-delivery-acceptance/1',checks,syntheticOnly:true,hostedJwtVerified:false,devicePersistenceVerified:false,retainedFixtureRows:retained,cleanupVerified:retained===0}));
    if(retained)throw new Error('fixture_cleanup_unverified');
  }
}
void main().catch(()=>{console.error('synthetic_delivery_acceptance_failed');process.exitCode=1;});
