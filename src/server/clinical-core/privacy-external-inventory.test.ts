import {describe,it,expect,vi} from 'vitest';
import type {DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {createExternalInventoryReader} from './privacy-external-inventory';
import {voiceOwner} from './owned-voice-authorization';
const owner='10000000-0000-4000-8000-000000000001',org='20000000-0000-4000-8000-000000000001',job='30000000-0000-4000-8000-000000000001',sub='fictional-subject';
const config={labs:'arn:aws:dynamodb:us-east-2:123456789012:table/labs',voice:'arn:aws:dynamodb:us-east-2:123456789012:table/voice',region:'us-east-2'};
const scope={ownerId:owner,ownerSub:sub};
const lab={pk:'job#'+job,personId:owner,organizationId:org,ownerSub:sub,state:'completed',updatedAt:'2020-01-01T00:00:00.000Z',dataClassification:'personal_health_record'};
function fixture(response:unknown){const send=vi.fn().mockResolvedValue(response);return {send,reader:createExternalInventoryReader(config,{send} as unknown as DynamoDBDocumentClient)};}
describe('deployment-pinned external privacy inventory',()=>{
  it('reads retained old/unindexed lab jobs and cleanup outboxes without expiry filtering or bodies',async()=>{
    const f=fixture({ScannedCount:25,Items:[lab,{pk:'cleanup#'+job,personId:owner,organizationId:org,ownerSub:sub,
      contractVersion:'lab-deletion-cleanup/1',cleanupPartition:'watching'}],LastEvaluatedKey:{pk:'other-record'}});
    const r=await f.reader.read('labs',scope,{pk:'previous'});
    expect(r).toMatchObject({scanned:25,issues:0,cursor:{pk:'other-record'}});expect(r.items.map(x=>x.kind)).toEqual(['lab_job','lab_cleanup']);
    const [command,options]=f.send.mock.calls[0];
    expect(command.constructor.name).toBe('ScanCommand');expect(command.input).toMatchObject({TableName:config.labs,ConsistentRead:true,Limit:25,ExclusiveStartKey:{pk:'previous'}});
    expect(JSON.stringify(command.input)).not.toMatch(/expiresAt|result|transcript|payload|filename|authorization/);
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
  });
  it('validates persisted voice ownership and never stores authorization/consent bodies',async()=>{
    const authorization={version:'owned-voice/1',personId:owner,organizationId:org,identitySubject:sub};
    const f=fixture({ScannedCount:1,Items:[{id:'a'.repeat(64),owner:voiceOwner({actorPersonId:owner,organizationId:org,identitySubject:sub}),authorization,state:'cleaned'}]});
    const r=await f.reader.read('voice',scope,null);
    expect(r).toEqual({scanned:1,issues:0,cursor:null,items:[{kind:'voice_job',jobId:'a'.repeat(64),organizationId:org,ownerSub:sub,state:'cleaned',updatedAt:null}]});
    expect(JSON.stringify(r)).not.toContain('authorization');expect(JSON.stringify(r)).not.toContain('consents');
  });
  it.each([
    {...lab,ownerSub:'other-subject'},
    {...lab,dataClassification:'synthetic_only'},
    {...lab,dataClassification:undefined},
    {...lab,pk:'job#not-a-job'},
    {...lab,state:'invented'},
    {...lab,updatedAt:'invalid'},
  ])('records unresolved metadata instead of claiming complete discovery: %j',async row=>{
    const f=fixture({ScannedCount:1,Items:[row]});
    expect(await f.reader.read('labs',scope,null)).toEqual({scanned:1,issues:1,cursor:null,items:[]});
  });
  it('counts conflicting voice binding as an issue rather than authorizing its scope',async()=>{
    const f=fixture({ScannedCount:1,Items:[{id:'a'.repeat(64),owner:'wrong',authorization:{personId:owner},state:'ready'}]});
    expect(await f.reader.read('voice',scope,null)).toMatchObject({items:[],issues:1});
  });
  it.each([
    {ScannedCount:1,Items:[{...lab,personId:org}]},
    {ScannedCount:2,Items:[lab,lab]},
    {ScannedCount:0,Items:[lab]},
    {Items:[]},
    {ScannedCount:26,Items:[]},
    {ScannedCount:1,Items:[],LastEvaluatedKey:{pk:'next',owner:'foreign'}},
    {ScannedCount:0,Items:[],LastEvaluatedKey:{pk:'next'}},
  ])('refuses miswired sources and malformed pages: %j',async response=>{
    const f=fixture(response);await expect(f.reader.read('labs',scope,null)).rejects.toThrow();
  });
  it('refuses looping cursors and never accepts an arbitrary client table/region',async()=>{
    const f=fixture({ScannedCount:1,Items:[],LastEvaluatedKey:{pk:'same'}});
    await expect(f.reader.read('labs',scope,{pk:'same'})).rejects.toThrow();
    expect(()=>createExternalInventoryReader({...config,labs:'not-an-arn'},{send:vi.fn()} as unknown as DynamoDBDocumentClient)).toThrow();
    expect(()=>createExternalInventoryReader({...config,region:'us-west-2'},{send:vi.fn()} as unknown as DynamoDBDocumentClient)).toThrow();
  });
});
