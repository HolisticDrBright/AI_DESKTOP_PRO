import {describe,it,expect,vi} from 'vitest';
import fixture from '@/contracts/personalMealBackup.fixture.json';
import {personalMealBackupSchema} from '@/contracts/personalMealBackup';
import {validateOwnedPayload} from './owned-lab-observations';
import {validateCollectionPayload} from './aws-consumer-clinical-records';
import {createOwnedConsumerRecordsAdapter} from './owned-consumer-records';
import type {ClinicalCoreDatabase} from './database';
import type {ProductionClinicalRequestContext} from './aws-identity-consent';

const context:ProductionClinicalRequestContext={actorPersonId:fixture.id,organizationId:fixture.id,identityPool:'consumer',identitySubject:'synthetic-acceptance',
  purpose:'clinical_data',environment:'production-clinical',dataClassification:'clinical_phi',containsPhi:true,realPatientData:true,productionBound:true};
describe('owned meal backup contract — synthetic fixtures only',()=>{
  it('accepts all seven nutrients, portions and unverified provenance without expanding clinic sharing',()=>{
    expect(personalMealBackupSchema.parse(fixture)).toEqual(fixture);
    expect(()=>validateOwnedPayload('meal_logs',fixture)).not.toThrow();
    expect(()=>validateCollectionPayload('meal_logs',fixture)).toThrow();
  });
  it('preserves the old summary contract without pretending it has food details',()=>{
    const {details:_,sugar_g:_s,sodium_mg:_n,...summary}=fixture;void _;void _s;void _n;
    expect(()=>validateOwnedPayload('meal_logs',summary)).not.toThrow();
    expect(personalMealBackupSchema.safeParse(summary).success).toBe(false);
  });
  it('refuses missing nutrients, bad totals, duplicate items, unknown sources, invented authority and extra keys',()=>{
    const missing=structuredClone(fixture) as Record<string,unknown>;delete missing.sugar_g;
    const rows=[missing,{...fixture,calories:999},{...fixture,ownerId:fixture.id},
      {...fixture,details:{...fixture.details,sourceStatus:'clinician_approved'}},
      {...fixture,details:{...fixture.details,items:[...fixture.details.items,...fixture.details.items]}},
      {...fixture,details:{...fixture.details,items:[{...fixture.details.items[0],source:'open_food_facts'}]}},
      {...fixture,details:{...fixture.details,items:[{...fixture.details.items[0],grams:-1}]}},
      {...fixture,details:{...fixture.details,items:[{...fixture.details.items[0],sodium_mg:null}]}},
      {...fixture,details:{...fixture.details,adviceStatus:'current_advice'}}];
    for(const row of rows)expect(()=>validateOwnedPayload('meal_logs',row)).toThrow('owned_meal_backup_invalid');
  });
  it('refuses oversized copies rather than truncating food history',()=>{
    expect(personalMealBackupSchema.safeParse({...fixture,details:{...fixture.details,suggestions:Array(40).fill('x'.repeat(1900))}}).success).toBe(false);
  });
  it('writes and returns complete owned copies through the real adapter under owner context',async()=>{
    const query=vi.fn(async(sql:string,params?:readonly unknown[]):Promise<{rows:{result:unknown}[]} >=>{
      void sql;void params;
      return {rows:[{result:{recordId:fixture.id,revision:1,receivedAt:fixture.meal_time,duplicate:false}}]};
    });
    const transaction=vi.fn(async(work:(tx:{query:typeof query})=>Promise<unknown>)=>work({query}));
    const adapter=createOwnedConsumerRecordsAdapter({transaction} as unknown as ClinicalCoreDatabase);
    await expect(adapter.write(context,{collection:'meal_logs',recordId:fixture.id,requestId:fixture.id,expectedRevision:0,consentRevision:1,payload:fixture,deleted:false})).resolves.toMatchObject({revision:1});
    expect(query.mock.calls[0][0]).toContain('set_request_context');
    expect(JSON.parse(query.mock.calls[1][1]![4] as string)).toEqual(fixture);
    query.mockResolvedValue({rows:[{result:[{recordId:fixture.id,revision:1,receivedAt:fixture.meal_time,payload:fixture}]}]} as never);
    expect((await adapter.list(context,{collection:'meal_logs',limit:20}))[0].payload).toEqual(fixture);
  });
});
