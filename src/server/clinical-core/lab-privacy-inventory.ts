import {GetCommand, ScanCommand, type DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {z} from 'zod';
import {inventoryStamp} from './lab-job-inventory';

const scopeSchema=z.object({ownerSub:z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i),
  organizationId:z.string().uuid(),personId:z.string().uuid()}).strict();
type Scope=z.infer<typeof scopeSchema>;
const fields=['pk','ownerSub','organizationId','personId','dataClassification','createdAt','updatedAt','expiresAt','state','inventoryOwner','inventoryOrder'];
const names=Object.fromEntries(fields.map((field,index)=>['#f'+index,field]));
const projection=fields.map((_,index)=>'#f'+index).join(',');
const metadata=z.object({pk:z.string().regex(/^job#[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
  ...scopeSchema.shape,dataClassification:z.enum(['synthetic_only','personal_health_record']).optional(),
  createdAt:z.string().datetime(),updatedAt:z.string().datetime(),expiresAt:z.number().int().positive(),
  state:z.enum(['awaiting_upload','queued','extracting','verifying','normalizing','interpreting','synthesizing','completed','needs_review','failed','deleting']),
  inventoryOwner:z.string().optional(),inventoryOrder:z.string().optional()}).strict();
const fail=():never=>{throw new Error('lab_privacy_inventory_unconfirmed');};
const matches=(row:Record<string,unknown>,scope:Scope)=>row.ownerSub===scope.ownerSub&&row.organizationId===scope.organizationId&&row.personId===scope.personId;

/** OPERATOR ONLY. Never import into the patient API or grant that API Scan.
 * Enumerates retained metadata, including expired/unindexed/deleting jobs.
 * A consistent Scan is NOT a point-in-time snapshot. Every candidate is reread,
 * and every page is identity-fenced. Exhaustion never means full-account export.
 * No payloads, filenames, object keys, tokens, resume or index writes. */
export async function discoverRetainedLabJobs(input:{db:DynamoDBDocumentClient;table:string;scope:Scope;
  classification:'synthetic_only'|'personal_health_record';revalidate:()=>Promise<Scope>;now?:()=>number;maxScanned?:number}){
  const scope=scopeSchema.parse(input.scope),now=input.now??Date.now;
  if(!input.table||input.table.length>255||!/^[A-Za-z0-9_.-]+$/.test(input.table))fail();
  const limit=input.maxScanned??10000;
  if(!Number.isInteger(limit)||limit<1||limit>100000)fail();
  const startedAt=new Date(now()).toISOString();
  const check=async()=>{if(!matches(scopeSchema.parse(await input.revalidate()),scope))fail();};
  const jobs:{jobId:string;state:string;createdAt:string;updatedAt:string;processingExpiresAt:number;processingExpired:boolean;
    indexStatus:'indexed'|'unindexed'|'conflicting';copyStatus:'request_copy'|'deletion_in_progress'}[]=[];
  const counts={scanned:0,candidates:0,disappearedOrChangedOwner:0,invalidMetadata:0,classificationMismatch:0};
  const seen=new Set<string>(),cursors=new Set<string>();
  let after:Record<string,unknown>|undefined,exhausted=false;
  await check();
  do{
    await check();
    const page=await input.db.send(new ScanCommand({TableName:input.table,ConsistentRead:true,Limit:Math.min(100,limit-counts.scanned),
      ProjectionExpression:projection,ExpressionAttributeNames:names,
      FilterExpression:'begins_with(#f0, :job) AND #f1 = :owner AND #f2 = :org AND #f3 = :person',
      ExpressionAttributeValues:{':job':'job#',':owner':scope.ownerSub,':org':scope.organizationId,':person':scope.personId},
      ...(after?{ExclusiveStartKey:after}:{})}));
    await check();
    if(!Number.isInteger(page.ScannedCount)||page.ScannedCount!<0||page.ScannedCount!>Math.min(100,limit-counts.scanned)
      ||(page.Items?.length??0)>page.ScannedCount!)fail();
    counts.scanned+=page.ScannedCount!;
    for(const candidate of page.Items??[]){
      if(!matches(candidate,scope))fail(); // Do not trust a miswired/filter-ignoring source.
      counts.candidates++;
      if(typeof candidate.pk!=='string'||!metadata.shape.pk.safeParse(candidate.pk).success){counts.invalidMetadata++;continue;}
      if(seen.has(candidate.pk))fail();seen.add(candidate.pk);
      const current=await input.db.send(new GetCommand({TableName:input.table,Key:{pk:candidate.pk},ConsistentRead:true,
        ProjectionExpression:projection,ExpressionAttributeNames:names}));
      await check();
      if(!current.Item||!matches(current.Item,scope)){counts.disappearedOrChangedOwner++;continue;}
      if((current.Item.dataClassification??'synthetic_only')!==input.classification){counts.classificationMismatch++;continue;}
      const parsed=metadata.safeParse(current.Item);
      if(!parsed.success||parsed.data.pk!==candidate.pk){counts.invalidMetadata++;continue;}
      const row=parsed.data,observedAt=now();
      if(Date.parse(row.updatedAt)<Date.parse(row.createdAt)||Date.parse(row.updatedAt)>observedAt){counts.invalidMetadata++;continue;}
      const stamp=inventoryStamp(scope,row.createdAt,row.pk);
      const indexStatus=row.inventoryOwner===stamp.inventoryOwner&&row.inventoryOrder===stamp.inventoryOrder?'indexed'
        :row.inventoryOwner===undefined&&row.inventoryOrder===undefined?'unindexed':'conflicting';
      jobs.push({jobId:row.pk.slice(4),state:row.state,createdAt:row.createdAt,updatedAt:row.updatedAt,processingExpiresAt:row.expiresAt,
        processingExpired:row.expiresAt<=Math.floor(observedAt/1000),indexStatus,
        copyStatus:row.state==='deleting'?'deletion_in_progress':'request_copy'});
    }
    after=page.LastEvaluatedKey;
    if(!after){exhausted=true;break;}
    const nextKey=after.pk;
    if(Object.keys(after).join(',')!=='pk'||typeof nextKey!=='string'||!nextKey||nextKey.length>256
      ||cursors.has(nextKey)||page.ScannedCount===0)throw new Error('lab_privacy_inventory_unconfirmed');
    cursors.add(nextKey);
  }while(counts.scanned<limit);
  await check();
  return {contractVersion:'lab-privacy-inventory/1',startedAt,finishedAt:new Date(now()).toISOString(),scope,
    classification:input.classification,coverage:{completeAccountExport:false,tableTraversalExhausted:exhausted,
      consistency:'non_snapshot_scan_with_consistent_candidate_rereads',
      requiresOperatorReconciliation:true,
      hasUnresolvedEnumerationIssues:!exhausted||counts.disappearedOrChangedOwner>0||counts.invalidMetadata>0||counts.classificationMismatch>0,
      excluded:['already_removed_rows','unattributable_legacy_rows','source_object_bytes_and_versions','worker_artifacts','other_account_stores'],
      noProcessingOrRetentionChanges:true},counts,jobs:jobs.sort((a,b)=>a.jobId.localeCompare(b.jobId))};
}
