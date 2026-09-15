import { createHash } from 'node:crypto';
import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export const REQUEST_RECOVERY_VERSION = 'lab-request-recovery/1';
export const REQUEST_RETIREMENT_VERSION = 'lab-request-retirement/1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type RequestIdentity = { id: string; createdAt: string };
type Scope = { ownerSub: string; organizationId: string; personId: string };
type OwnedJob = Scope & { pk: string; expiresAt: number };
type Ledger = { pk: string; jobId?: string; fingerprint?: string; createdAt: string; expiresAt: number; retiredAt?: string };
export class LabRequestError extends Error {
  constructor(public code: 'lab_request_not_found' | 'lab_request_gone' | 'lab_request_conflict' | 'lab_request_invalid' | 'lab_request_not_releasable', public statusCode: number) { super(code); }
}
export function requestIdentity(value: unknown): RequestIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LabRequestError('lab_request_invalid',400);
  const row = value as RequestIdentity;
  if (Object.keys(row).some(k=>!['id','createdAt'].includes(k)) || typeof row.id !== 'string' || !UUID.test(row.id)
    || typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt))
    || new Date(row.createdAt).toISOString() !== row.createdAt) throw new LabRequestError('lab_request_invalid',400);
  return {id:row.id.toLowerCase(),createdAt:row.createdAt};
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  if (value && typeof value==='object') return '{'+Object.entries(value).filter(([,v])=>v!==undefined)
    .sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
  return JSON.stringify(value);
}
const hash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
/** Atomic identity+job persistence. Ledger survives job deletion; it contains no input payload. */
export function labRequestLedger(db: DynamoDBDocumentClient, table: string, now=()=>Date.now()) {
  const key=(scope:Scope,id:string)=>'request#'+hash([scope.ownerSub,scope.organizationId,scope.personId,id.toLowerCase()]);
  const read=async(pk:string)=>(await db.send(new GetCommand({TableName:table,Key:{pk},ConsistentRead:true}))).Item;
  const resolve=async<T extends OwnedJob>(scope:Scope, ledger:Ledger):Promise<T>=>{
    if(ledger.retiredAt || !ledger.jobId)throw new LabRequestError('lab_request_gone',410);
    const job=await read('job#'+ledger.jobId) as T|undefined;
    if (!job || job.ownerSub!==scope.ownerSub || job.organizationId!==scope.organizationId || job.personId!==scope.personId
      || job.expiresAt<=Math.floor(now()/1000)) throw new LabRequestError('lab_request_gone',410);
    return job;
  };
  return {
    async retire(scope:Scope,value:unknown):Promise<void>{
      const request=requestIdentity(value),pk=key(scope,request.id);
      if(Date.parse(request.createdAt)>now()+60_000)throw new LabRequestError('lab_request_invalid',400);
      const existing=await read(pk) as Ledger|undefined;
      if(existing && existing.createdAt!==request.createdAt)throw new LabRequestError('lab_request_conflict',409);
      if(existing?.retiredAt)return;
      const retiredAt=new Date(now()).toISOString(),expiresAt=Math.floor(now()/1000)+90*24*60*60;
      try{
        if(!existing){
          // Competes with creation on the same key: exactly one may win.
          await db.send(new TransactWriteCommand({TransactItems:[{Put:{TableName:table,
            Item:{pk,createdAt:request.createdAt,expiresAt,retiredAt},ConditionExpression:'attribute_not_exists(pk)'}}]}));
        }else{
          if(!existing.jobId)throw new LabRequestError('lab_request_not_releasable',409);
          await db.send(new TransactWriteCommand({TransactItems:[
            {Update:{TableName:table,Key:{pk},UpdateExpression:'SET retiredAt = :retired, expiresAt = :ttl',
              ConditionExpression:'jobId = :job AND createdAt = :created AND attribute_not_exists(retiredAt)',
              ExpressionAttributeValues:{':job':existing.jobId,':created':request.createdAt,':retired':retiredAt,':ttl':expiresAt}}},
            {ConditionCheck:{TableName:table,Key:{pk:'job#'+existing.jobId},
              // Even an expired active job cannot be released by this action.
              ConditionExpression:'attribute_not_exists(pk) OR (ownerSub = :owner AND organizationId = :org AND personId = :person AND expiresAt <= :now AND #state IN (:completed, :failed, :review))',
              ExpressionAttributeNames:{'#state':'state'},ExpressionAttributeValues:{':owner':scope.ownerSub,':org':scope.organizationId,':person':scope.personId,
                ':now':Math.floor(now()/1000),':completed':'completed',':failed':'failed',':review':'needs_review'}}},
          ]}));
        }
      }catch(error){
        const current=await read(pk) as Ledger|undefined;
        if(current?.retiredAt && current.createdAt===request.createdAt)return; // Lost acknowledgement or concurrent release.
        if((error as {name?:string})?.name==='TransactionCanceledException')throw new LabRequestError('lab_request_not_releasable',409);
        throw error; // No success claim on a timeout, permission failure or ambiguous response.
      }
    },
    async discover<T extends OwnedJob>(scope:Scope,id:string):Promise<T>{
      if(!UUID.test(id))throw new LabRequestError('lab_request_invalid',400);
      const ledger=await read(key(scope,id)) as Ledger|undefined;
      if(!ledger)throw new LabRequestError('lab_request_not_found',404);
      return resolve<T>(scope,ledger);
    },
    async create<T extends OwnedJob>(scope:Scope, value:unknown, kind:'documents'|'saved', input:unknown, candidate:T):Promise<T>{
      const request=requestIdentity(value), pk=key(scope,request.id), fingerprint=hash({kind,input});
      const replay=async(ledger:Ledger)=>{
        if(ledger.retiredAt)throw new LabRequestError('lab_request_gone',410);
        if(ledger.fingerprint!==fingerprint || ledger.createdAt!==request.createdAt)throw new LabRequestError('lab_request_conflict',409);
        return resolve<T>(scope,ledger);
      };
      const existing=await read(pk) as Ledger|undefined;
      if(existing)return replay(existing);
      const age=now()-Date.parse(request.createdAt);
      // After ledger TTL cleanup, an old request is still too old to recreate.
      if(age < -60_000 || age > 24*60*60*1000)throw new LabRequestError('lab_request_gone',410);
      const ledger:Ledger={pk,jobId:candidate.pk.slice(4),fingerprint,createdAt:request.createdAt,expiresAt:Math.floor(now()/1000)+90*24*60*60};
      const stored = {...candidate,recoveryRequest:{...request,kind}};
      try {
        await db.send(new TransactWriteCommand({TransactItems:[
          {Put:{TableName:table,Item:ledger,ConditionExpression:'attribute_not_exists(pk)'}},
          {Put:{TableName:table,Item:stored,ConditionExpression:'attribute_not_exists(pk)'}},
        ]}));
      } catch(error) {
        // Includes a concurrent winner or a committed transaction whose response was lost.
        const winner=await read(pk) as Ledger|undefined;
        if(winner)return replay(winner);
        throw error; // Absence after an uncertain write is not permission for a new identity.
      }
      return stored;
    },
  };
}
