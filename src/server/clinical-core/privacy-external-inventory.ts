import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,ScanCommand} from '@aws-sdk/lib-dynamodb';
import {z} from 'zod';
import {ownedVoiceDeletionScope} from './owned-voice-deletion';
import type {VoiceJob} from './voice-jobs';
export type InventoryStore='labs'|'voice';
export type InventoryItem={kind:'lab_job'|'lab_cleanup'|'voice_job';jobId:string;organizationId:string;ownerSub:string;state:string;updatedAt:string|null};
export type InventoryScope={ownerId:string;ownerSub:string};
export type InventoryPage={items:InventoryItem[];cursor:Record<string,unknown>|null;scanned:number;issues:number};
export type ExternalInventoryReader={source:(store:InventoryStore)=>string;read:(store:InventoryStore,scope:InventoryScope,cursor:unknown)=>Promise<InventoryPage>};
const source=z.string().regex(/^arn:aws:dynamodb:[a-z0-9-]+:[0-9]{12}:table\/[A-Za-z0-9_.-]{3,255}$/);
const uuid=z.string().uuid(),subject=z.string().regex(/^[A-Za-z0-9:_-]{8,128}$/);
const stamp=z.string().datetime(),state=z.string().min(1).max(40);
const lab=z.object({pk:z.string(),personId:uuid,organizationId:uuid,ownerSub:subject,
  dataClassification:z.literal('personal_health_record').optional(),state:state.optional(),updatedAt:stamp.optional(),
  contractVersion:z.literal('lab-deletion-cleanup/1').optional(),cleanupPartition:z.enum(['pending','watching']).optional(),lastVerifiedAt:stamp.optional()}).strict();
const fail=():never=>{throw new Error('external_inventory_invalid');};
/** Deployment-pinned, metadata-only consistent Scan; NOT a point-in-time snapshot.
 * Expiry and GSI membership never filter retained rows. No bodies or mutations. */
export function createExternalInventoryReader(config:{labs:string;voice:string;region:string},db:DynamoDBDocumentClient=DynamoDBDocumentClient.from(new DynamoDBClient({region:config.region}))):ExternalInventoryReader{
  for(const arn of [config.labs,config.voice])if(!source.safeParse(arn).success||arn.split(':')[3]!==config.region)fail();
  return {source:store=>config[store],read:async(store,scope,cursor)=>{
    uuid.parse(scope.ownerId);subject.parse(scope.ownerSub);
    const cursorSchema=store==='labs'?z.object({pk:z.string().min(1).max(512)}).strict():z.object({id:z.string().min(1).max(512)}).strict();
    const after=cursor==null?undefined:cursorSchema.parse(cursor);
    const fields=store==='labs'?['pk','personId','organizationId','ownerSub','dataClassification','state','updatedAt','contractVersion','cleanupPartition','lastVerifiedAt']:['id','owner','authorization','state'];
    const names=Object.fromEntries(fields.map((f,i)=>['#f'+i,f]));
    if(store==='voice')names['#person']='personId';
    const result=await db.send(new ScanCommand({TableName:config[store],ConsistentRead:true,Limit:25,Select:'SPECIFIC_ATTRIBUTES',
      ProjectionExpression:fields.map((_,i)=>'#f'+i).join(','),ExpressionAttributeNames:names,
      FilterExpression:store==='labs'?'#f1 = :owner AND (begins_with(#f0, :job) OR begins_with(#f0, :cleanup))':'#f2.#person = :owner',
      ExpressionAttributeValues:{':owner':scope.ownerId,...(store==='labs'?{':job':'job#',':cleanup':'cleanup#'}:{})},
      ...(after?{ExclusiveStartKey:after}:{})}),{abortSignal:AbortSignal.timeout(4000)});
    if(!Number.isInteger(result.ScannedCount)||result.ScannedCount!<0||result.ScannedCount!>25
      ||(result.Items?.length??0)>result.ScannedCount!)fail();
    const next=result.LastEvaluatedKey?cursorSchema.parse(result.LastEvaluatedKey):null;
    if(next&&(result.ScannedCount===0||JSON.stringify(next)===JSON.stringify(after)))fail();
    const items:InventoryItem[]=[],seen=new Set<string>();let issues=0;
    for(const row of result.Items??[]){
      if(store==='labs'){
        if(row.personId!==scope.ownerId)fail();
        const p=lab.safeParse(row);
        if(!p.success||p.data.ownerSub!==scope.ownerSub){issues++;continue;}
        const v=p.data,kind=v.pk.startsWith('cleanup#')?'lab_cleanup':v.pk.startsWith('job#')?'lab_job':null;
        const jobId=v.pk.slice(kind==='lab_cleanup'?8:4);
        if(!kind||!uuid.safeParse(jobId).success||kind==='lab_job'&&(v.dataClassification!=='personal_health_record'
          ||!['awaiting_upload','queued','extracting','verifying','normalizing','interpreting','synthesizing','completed','needs_review','failed','deleting'].includes(v.state??'')||!v.updatedAt)
          ||kind==='lab_cleanup'&&(v.contractVersion!=='lab-deletion-cleanup/1'||!v.cleanupPartition)){issues++;continue;}
        items.push({kind,jobId:jobId.toLowerCase(),organizationId:v.organizationId.toLowerCase(),ownerSub:v.ownerSub,
          state:kind==='lab_cleanup'?v.cleanupPartition!:v.state!,updatedAt:kind==='lab_cleanup'?v.lastVerifiedAt??null:v.updatedAt!});
      }else{
        if(row.authorization?.personId!==scope.ownerId)fail();
        try{
          const binding=ownedVoiceDeletionScope(row as Pick<VoiceJob,'id'|'owner'|'authorization'>);
          if(binding.personId!==scope.ownerId||binding.ownerSub!==scope.ownerSub||!['uploading','queued','running','ready','failed','cleaned'].includes(row.state))fail();
          items.push({kind:'voice_job',jobId:row.id,organizationId:binding.organizationId.toLowerCase(),ownerSub:binding.ownerSub,state:row.state,updatedAt:null});
        }catch{issues++;continue;}
      }
      const key=items.at(-1)!.kind+':'+items.at(-1)!.jobId;if(seen.has(key))fail();seen.add(key);
    }
    return {items,cursor:next,scanned:result.ScannedCount!,issues};
  }};
}
