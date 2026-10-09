import {createHash} from 'node:crypto';
import {GetCommand,ScanCommand,UpdateCommand,type DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {z} from 'zod';
import {inventoryStamp} from './lab-job-inventory';

export const INVENTORY_MIGRATION_VERSION='lab-inventory-migration/1';
const fields=['pk','ownerSub','organizationId','personId','createdAt','updatedAt','expiresAt','state','progressPercent','inventoryOwner','inventoryOrder'] as const;
const names=Object.fromEntries(fields.map((field,index)=>['#f'+index,field]));
const projection=fields.map((_,index)=>'#f'+index).join(',');
const subject=z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const metadataSchema=z.object({
  pk:z.string().regex(/^job#[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
  ownerSub:subject,organizationId:z.string().uuid(),personId:z.string().uuid(),
  createdAt:z.string().datetime(),updatedAt:z.string().datetime(),expiresAt:z.number().int().positive(),
  state:z.enum(['awaiting_upload','queued','extracting','verifying','normalizing','interpreting','synthesizing','completed','needs_review','failed']),
  progressPercent:z.number().int().min(0).max(100),inventoryOwner:z.string().optional(),inventoryOrder:z.string().optional(),
}).strict();
export type MigrationMetadata=z.infer<typeof metadataSchema>;
const entrySchema=metadataSchema.omit({inventoryOwner:true,inventoryOrder:true});
export const inventoryMigrationPlanSchema=z.object({
  version:z.literal(INVENTORY_MIGRATION_VERSION),account:z.literal('588966314750'),region:z.literal('us-east-2'),
  table:z.string().regex(/^ai-clinical-core-synthetic-staging-lab-analysis-LabJobTable-[A-Z0-9]+$/),
  pool:z.string().regex(/^us-east-2_[A-Za-z0-9]+$/),sourceCommit:z.string().regex(/^[a-f0-9]{40}$/),
  plannedAt:z.string().datetime(),selectedJob:z.string().uuid().optional(),entries:z.array(entrySchema).max(10000),
  inspected:z.number().int().nonnegative().max(10000),skipped:z.record(z.string(),z.number().int().nonnegative()),
}).strict().superRefine((plan,ctx)=>{
  if(new Set(plan.entries.map(e=>e.pk)).size!==plan.entries.length)ctx.addIssue({code:'custom',message:'duplicate_job'});
  if(plan.selectedJob&&plan.entries.some(e=>e.pk!=='job#'+plan.selectedJob))ctx.addIssue({code:'custom',message:'selection_mismatch'});
  if(plan.entries.length+Object.values(plan.skipped).reduce((a,b)=>a+b,0)!==plan.inspected)ctx.addIssue({code:'custom',message:'counts_invalid'});
});
export type InventoryMigrationPlan=z.infer<typeof inventoryMigrationPlanSchema>;
export type VerifiedMigrationOwner={ownerSub:string;organizationId:string;personId:string;syntheticAttested:boolean;enabled:boolean};
type Dependencies={db:DynamoDBDocumentClient;table:string;now?:()=>number;owner:(sub:string)=>Promise<VerifiedMigrationOwner|null>};
const ownerMatches=(row:MigrationMetadata,owner:VerifiedMigrationOwner|null)=>Boolean(owner?.enabled&&owner.syntheticAttested
  &&owner.ownerSub===row.ownerSub&&owner.organizationId===row.organizationId&&owner.personId===row.personId);
const metadataWithoutIndex=(row:MigrationMetadata)=>entrySchema.parse(Object.fromEntries(Object.entries(row).filter(([key])=>!['inventoryOwner','inventoryOrder'].includes(key))));
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export function inventoryMigrationHash(text:string){return createHash('sha256').update(text).digest('hex');}
export function validateInventoryMigrationPlan(input:unknown,now=Date.now()){
  const plan=inventoryMigrationPlanSchema.parse(input),date=Date.parse(plan.plannedAt);
  if(date>now||now-date>3600000)throw new Error('migration_plan_expired');
  for(const row of plan.entries){
    inventoryStamp(row,row.createdAt,row.pk);
    if(Date.parse(row.createdAt)>date||Date.parse(row.updatedAt)<Date.parse(row.createdAt)||Date.parse(row.updatedAt)>date||row.expiresAt<=Math.floor(date/1000))throw new Error('migration_plan_metadata_invalid');
  }
  return plan;
}
/** Administrative offline scan only. Never import into runtime API or add Scan to its role. */
export async function planInventoryMigration(deps:Dependencies,configuration:Omit<InventoryMigrationPlan,'version'|'plannedAt'|'entries'|'inspected'|'skipped'>){
  if(configuration.table!==deps.table)throw new Error('migration_target_mismatch');
  const now=(deps.now??Date.now)(),entries:InventoryMigrationPlan['entries']=[],skipped:Record<string,number>={};
  let inspected=0,after:Record<string,unknown>|undefined;
  const seen=new Set<string>(),cursors=new Set<string>();
  const skip=(reason:string)=>{skipped[reason]=(skipped[reason]??0)+1;};
  do{
    const page=await deps.db.send(new ScanCommand({TableName:deps.table,ConsistentRead:true,Limit:100,
      ProjectionExpression:projection,ExpressionAttributeNames:names,
      FilterExpression:'begins_with(#f0, :job)'+(configuration.selectedJob?' AND #f0 = :selected':''),
      ExpressionAttributeValues:{':job':'job#',...(configuration.selectedJob?{':selected':'job#'+configuration.selectedJob}:{})},
      ...(after?{ExclusiveStartKey:after}:{})}));
    for(const raw of page.Items??[]){
      if(++inspected>10000)throw new Error('migration_scan_limit_exceeded');
      const result=metadataSchema.safeParse(raw);
      if(!result.success){skip('invalid_or_deleting');continue;}
      const row=result.data;
      if(seen.has(row.pk))throw new Error('migration_duplicate_scan_row');seen.add(row.pk);
      if(row.expiresAt<=Math.floor(now/1000)){skip('expired');continue;}
      if(Date.parse(row.createdAt)>now||Date.parse(row.updatedAt)>now||Date.parse(row.updatedAt)<Date.parse(row.createdAt)){skip('invalid_time');continue;}
      const stamp=inventoryStamp(row,row.createdAt,row.pk);
      if(row.inventoryOwner!==undefined||row.inventoryOrder!==undefined){
        skip(row.inventoryOwner===stamp.inventoryOwner&&row.inventoryOrder===stamp.inventoryOrder?'already_indexed':'index_conflict');continue;
      }
      // No ownership inference from an email, clinical payload, filename or table proximity.
      if(!ownerMatches(row,await deps.owner(row.ownerSub))){skip('unverified_owner');continue;}
      entries.push(metadataWithoutIndex(row));
    }
    after=page.LastEvaluatedKey;
    if(after){
      if(Object.keys(after).join(',')!=='pk'||typeof after.pk!=='string'||after.pk.length>256||cursors.has(JSON.stringify(after)))throw new Error('migration_cursor_invalid');
      cursors.add(JSON.stringify(after));
    }
  }while(after);
  return validateInventoryMigrationPlan({...configuration,version:INVENTORY_MIGRATION_VERSION,
    plannedAt:new Date(now).toISOString(),entries:entries.sort((a,b)=>a.pk.localeCompare(b.pk)),inspected,skipped},now);
}
export async function applyInventoryMigration(deps:Dependencies,input:unknown){
  const plan=validateInventoryMigrationPlan(input,(deps.now??Date.now)());
  if(plan.table!==deps.table)throw new Error('migration_target_mismatch');
  const summary={indexed:0,alreadyIndexed:0,conflicts:0,unverifiedOwner:0,expiredOrMissing:0};
  for(const expected of plan.entries){
    const now=(deps.now??Date.now)();
    if(now-Date.parse(plan.plannedAt)>3600000)throw new Error('migration_plan_expired');
    const current=await deps.db.send(new GetCommand({TableName:deps.table,Key:{pk:expected.pk},ConsistentRead:true,
      ProjectionExpression:projection,ExpressionAttributeNames:names}));
    if(!current.Item){summary.expiredOrMissing++;continue;}
    const parsed=metadataSchema.safeParse(current.Item);
    if(!parsed.success){summary.conflicts++;continue;}
    const row=parsed.data;
    if(row.expiresAt<=Math.floor(now/1000)){summary.expiredOrMissing++;continue;}
    if(!equal(metadataWithoutIndex(row),expected)){summary.conflicts++;continue;}
    if(!ownerMatches(row,await deps.owner(row.ownerSub))){summary.unverifiedOwner++;continue;}
    const stamp=inventoryStamp(row,row.createdAt,row.pk);
    if(row.inventoryOwner===stamp.inventoryOwner&&row.inventoryOrder===stamp.inventoryOrder){summary.alreadyIndexed++;continue;}
    if(row.inventoryOwner!==undefined||row.inventoryOrder!==undefined){summary.conflicts++;continue;}
    const compareFields=fields.filter(field=>!['inventoryOwner','inventoryOrder'].includes(field));
    const values:Record<string,unknown>={':owner':stamp.inventoryOwner,':order':stamp.inventoryOrder,':now':Math.floor((deps.now??Date.now)()/1000)};
    for(const field of compareFields)values[':v'+fields.indexOf(field)]=row[field];
    try{
      await deps.db.send(new UpdateCommand({TableName:deps.table,Key:{pk:row.pk},
        UpdateExpression:'SET #f9 = :owner, #f10 = :order',
        ConditionExpression:compareFields.map(field=>'#f'+fields.indexOf(field)+' = :v'+fields.indexOf(field)).join(' AND ')
          +' AND #f6 > :now AND attribute_not_exists(#f9) AND attribute_not_exists(#f10)',
        ExpressionAttributeNames:names,ExpressionAttributeValues:values}));
      summary.indexed++;
    }catch(error){
      if((error as {name?:unknown})?.name==='ConditionalCheckFailedException'){summary.conflicts++;continue;}
      // Do not print SDK objects, response bodies or row identifiers. Partial work is safely replayable.
      throw new Error('migration_update_unconfirmed_rerun_review');
    }
  }
  return summary;
}
