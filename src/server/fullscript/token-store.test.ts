import {afterEach, describe, expect, it, vi} from 'vitest';
import {DeleteItemCommand, DynamoDBClient, GetItemCommand, PutItemCommand} from '@aws-sdk/client-dynamodb';
import {createAwsFullscriptTokenStore, parseStoredFullscriptConnection, type StoredFullscriptConnection} from './token-store';

const key={actorKey:'a'.repeat(64),organizationId:'a1234567-1234-4123-8123-123456789012'};
const fixture=():StoredFullscriptConnection=>({...key,environment:'sandbox_us',
  accessToken:'fictional-access-token-abcdefghijklmnopqrstuvwxyz',refreshToken:'fictional-refresh-token-abcdefghijklmnopqrstuvwxyz',
  expiresAt:'2026-10-10T10:00:00.000Z',connectedAt:'2026-10-09T10:00:00.000Z',
  resourceOwner:{id:'fictional-practitioner-id',type:'Practitioner'},scope:['clinic:read','clinic:write']});
const store=()=>createAwsFullscriptTokenStore({NODE_ENV:'test',FULLSCRIPT_TOKEN_TABLE:'fictional-token-table',AWS_REGION:'us-east-2'})!;
afterEach(()=>vi.restoreAllMocks());

describe('Fullscript saved connection custody',()=>{
  it('reads only the exact key, consistently, and validates the stored payload',async()=>{
    const send=vi.spyOn(DynamoDBClient.prototype,'send').mockResolvedValue({Item:{payload:{S:JSON.stringify(fixture())}}} as never);
    expect(await store().get(key.actorKey,key.organizationId)).toEqual(fixture());
    const command=send.mock.calls[0][0];expect(command).toBeInstanceOf(GetItemCommand);
    expect(command.input).toMatchObject({ConsistentRead:true,Key:{pk:{S:'ORG#'+key.organizationId},sk:{S:'FULLSCRIPT#'+key.actorKey}}});
  });
  it('treats a physically absent item as disconnected, not a malformed item',async()=>{
    vi.spyOn(DynamoDBClient.prototype,'send').mockResolvedValue({} as never);
    expect(await store().get(key.actorKey,key.organizationId)).toBeNull();
  });
  it.each(['wrong-actor','wrong-clinic','bad-json','missing-payload','missing-token','invalid-owner','extra-field','bad-date',
    'duplicate-scopes','invalid-scope','unknown-environment','short-token'])('refuses %s without returning a token or a false disconnected result',async mode=>{
    const value:Record<string,unknown>={...fixture()};
    if(mode==='wrong-actor')value.actorKey='b'.repeat(64);
    if(mode==='wrong-clinic')value.organizationId='b1234567-1234-4123-8123-123456789012';
    if(mode==='missing-token')delete value.accessToken;
    if(mode==='invalid-owner')value.resourceOwner={id:'fictional-practitioner-id',type:'Patient'};
    if(mode==='extra-field')value.callerApproved=true;
    if(mode==='bad-date')value.expiresAt='not-a-date';
    if(mode==='duplicate-scopes')value.scope=['clinic:read','clinic:read'];
    if(mode==='invalid-scope')value.scope=['clinic:read\nsecret'];
    if(mode==='unknown-environment')value.environment='some-other-provider';
    if(mode==='short-token')value.accessToken='short';
    const Item=mode==='missing-payload'?{}:{payload:{S:mode==='bad-json'?'{broken fictional token':JSON.stringify(value)}};
    vi.spyOn(DynamoDBClient.prototype,'send').mockResolvedValue({Item} as never);
    await expect(store().get(key.actorKey,key.organizationId)).rejects.toMatchObject({code:'fullscript_unavailable'});
  });
  it('validates before writing and uses only validated key fields',async()=>{
    const send=vi.spyOn(DynamoDBClient.prototype,'send').mockResolvedValue({} as never);
    await store().put(fixture());
    const command=send.mock.calls[0][0];expect(command).toBeInstanceOf(PutItemCommand);
    expect(command.input).toMatchObject({Item:{pk:{S:'ORG#'+key.organizationId},sk:{S:'FULLSCRIPT#'+key.actorKey}}});
    expect(JSON.parse((command as PutItemCommand).input.Item!.payload.S!)).toEqual(fixture());
    send.mockClear();
    await expect(store().put({...fixture(),actorKey:'invalid'})).rejects.toThrow('Fullscript is not configured');
    expect(send).not.toHaveBeenCalled();
  });
  it('refuses malformed lookup and deletion keys before AWS I/O',async()=>{
    const send=vi.spyOn(DynamoDBClient.prototype,'send').mockResolvedValue({} as never);
    await expect(store().get('invalid',key.organizationId)).rejects.toThrow();
    await expect(store().delete({...fixture(),organizationId:'wrong'})).rejects.toThrow();expect(send).not.toHaveBeenCalled();
  });
  it('returns a detached validated snapshot, preserving the original scopes and owner',()=>{
    const original=fixture(),parsed=parseStoredFullscriptConnection(original,key);
    parsed.scope.push('catalog:read');parsed.resourceOwner.id='fictional-other-practitioner';
    expect(original).toEqual(fixture());
  });
  it('replaces only the exact old bytes, preserving a legacy JSON property order',async()=>{
    const before=fixture(),after={...before,accessToken:'fictional-rotated-access-abcdefghijklmnopqrstuvwxyz'};
    const raw=JSON.stringify(before); // Input order differs from the schema's serialization order.
    const send=vi.spyOn(DynamoDBClient.prototype,'send').mockResolvedValueOnce({Item:{payload:{S:raw}}} as never)
      .mockResolvedValueOnce({} as never);
    expect(await store().replace(before,after)).toBe(true);
    const command=send.mock.calls[1][0] as PutItemCommand;
    expect(command.input).toMatchObject({ConditionExpression:'attribute_exists(pk) AND payload = :previous',
      ExpressionAttributeValues:{':previous':{S:raw}}});
    expect(JSON.parse(command.input.Item!.payload.S!)).toEqual(after);
  });
  it.each(['disconnected','reconnected','race'])('does not overwrite custody after %s',async mode=>{
    const before=fixture(),after={...before,accessToken:'fictional-rotated-access-abcdefghijklmnopqrstuvwxyz'};
    const changed={...before,connectedAt:'2026-10-09T11:00:00.000Z'};
    const send=vi.spyOn(DynamoDBClient.prototype,'send')
      .mockResolvedValueOnce((mode==='disconnected'?{}:{Item:{payload:{S:JSON.stringify(mode==='reconnected'?changed:before)}}}) as never);
    if(mode==='race')send.mockRejectedValueOnce(Object.assign(new Error('fictional race'),{name:'ConditionalCheckFailedException'}));
    expect(await store().replace(before,after)).toBe(false);
    expect(send).toHaveBeenCalledTimes(mode==='race'?2:1);
  });
  it.each(['clinic','actor','owner','environment','scopes','connected-at'])('refuses replacement of the %s binding before AWS I/O',async mode=>{
    const before=fixture(),after=fixture();
    if(mode==='clinic')after.organizationId='b1234567-1234-4123-8123-123456789012';
    if(mode==='actor')after.actorKey='b'.repeat(64);
    if(mode==='owner')after.resourceOwner={id:'fictional-other-practitioner',type:'Practitioner'};
    if(mode==='environment')after.environment='production_us';
    if(mode==='scopes')after.scope.push('catalog:read');
    if(mode==='connected-at')after.connectedAt='2026-10-09T11:00:00.000Z';
    const send=vi.spyOn(DynamoDBClient.prototype,'send').mockResolvedValue({} as never);
    await expect(store().replace(before,after)).rejects.toMatchObject({code:'fullscript_unavailable'});expect(send).not.toHaveBeenCalled();
  });
  it('deletes only the exact installation whose token was revoked',async()=>{
    const before=fixture(),raw=JSON.stringify(before);
    const send=vi.spyOn(DynamoDBClient.prototype,'send').mockResolvedValueOnce({Item:{payload:{S:raw}}} as never)
      .mockResolvedValueOnce({} as never);
    expect(await store().delete(before)).toBe(true);
    const command=send.mock.calls[1][0];expect(command).toBeInstanceOf(DeleteItemCommand);
    expect(command.input).toMatchObject({ConditionExpression:'payload = :previous',ExpressionAttributeValues:{':previous':{S:raw}}});
  });
  it.each(['already-absent','reconnected','race'])('disconnect cannot delete new custody after %s',async mode=>{
    const before=fixture(),changed={...before,connectedAt:'2026-10-09T11:00:00.000Z'};
    const send=vi.spyOn(DynamoDBClient.prototype,'send').mockResolvedValueOnce((mode==='already-absent'?{}
      :{Item:{payload:{S:JSON.stringify(mode==='reconnected'?changed:before)}}}) as never);
    if(mode==='race')send.mockRejectedValueOnce(Object.assign(new Error('fictional race'),{name:'ConditionalCheckFailedException'}));
    expect(await store().delete(before)).toBe(mode==='already-absent');expect(send).toHaveBeenCalledTimes(mode==='race'?2:1);
  });
});
