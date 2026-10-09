import {clinicalUuid,ClinicalCoreDatabaseRejection,type ClinicalCoreDatabase} from './database';
import {OwnedStorageError} from './owned-consumer-records';
import {createRdsDataClinicalCoreDatabase} from './rds-data-database';

export type ExternalDeletionScope={ownerSub:string;organizationId:string;personId:string};
export type ExternalDeletionGuard=<T>(scope:ExternalDeletionScope,operation:()=>Promise<T>)=>Promise<T>;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function ownedExternalDeletionGuardFromEnv(env:Record<string,string|undefined>):ExternalDeletionGuard{
  return (scope,operation)=>createOwnedExternalDeletionGuard(createRdsDataClinicalCoreDatabase({
    clusterArn:env.CLINICAL_DATABASE_CLUSTER_ARN??'',secretArn:env.CLINICAL_DATABASE_SECRET_ARN??'',
    databaseName:env.CLINICAL_DATABASE_NAME??'',region:env.AWS_REGION,
  }))(scope,operation);
}

/** Internal only: scope comes from the verified API identity or validated cleanup
 * outbox. Keep the DB hold/identity lock until ONE bounded remote mutation ends.
 * This is not a distributed transaction: remote uncertainty retains the outbox
 * for revalidation/retry and can never prove whole-account erasure. */
export function createOwnedExternalDeletionGuard(database:ClinicalCoreDatabase):ExternalDeletionGuard{
  return async(scope,operation)=>{
    if(!uuid.test(scope.personId)||!uuid.test(scope.organizationId)||!/^[A-Za-z0-9:_-]{8,128}$/.test(scope.ownerSub))
      throw new OwnedStorageError('owner_required');
    try{
      return await database.transaction(async tx=>{
        await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)',[
          clinicalUuid(scope.personId),clinicalUuid(scope.organizationId),'consumer',scope.ownerSub,
          'consent_management','production-clinical','clinical_phi',
        ]);
        const result=await tx.query<{owner:string}>('select clinical_core.guard_owned_external_deletion() as owner');
        if(result.rows.length!==1||result.rows[0].owner!==scope.personId)throw new OwnedStorageError('owner_required');
        return operation();
      });
    }catch(error){
      if(error instanceof OwnedStorageError)throw error;
      if(error instanceof ClinicalCoreDatabaseRejection){
        if(error.category==='legal_hold')throw new OwnedStorageError('legal_hold');
        if(error.category==='identity_refused')throw new OwnedStorageError('owner_required');
      }
      throw new OwnedStorageError('storage_unavailable');
    }
  };
}
