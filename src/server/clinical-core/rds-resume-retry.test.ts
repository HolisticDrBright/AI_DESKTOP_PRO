import {afterEach,describe,expect,test,vi} from 'vitest';
import {retryDatabaseResume} from './rds-resume-retry';
import {createRdsDataClinicalCoreDatabase} from './rds-data-database';
const resuming=()=>Object.assign(new Error('private database details'),{name:'DatabaseResumingException'});
afterEach(()=>vi.useRealTimers());
describe('bounded Aurora resume handling',()=>{
  test('only typed cancelled-before-execution responses are retried, with a fixed budget',async()=>{
    const pause=vi.fn(async()=>{});let calls=0;
    expect(await retryDatabaseResume(async()=>{if(++calls<3)throw resuming();return 'ready';},pause)).toBe('ready');
    expect(pause.mock.calls).toEqual([[1000],[2000]]);
    calls=0;pause.mockClear();
    await expect(retryDatabaseResume(async()=>{calls++;throw resuming();},pause)).rejects.toThrow('private database details');
    expect(calls).toBe(4);expect(pause.mock.calls).toEqual([[1000],[2000],[4000]]);
  });
  test('denials, timeouts, ambiguous network errors and lookalike message strings are never retried',async()=>{
    for(const name of ['AccessDeniedException','StatementTimeoutException','TimeoutError','Error']){
      const operation=vi.fn(async()=>{throw Object.assign(new Error('DatabaseResumingException'),{name});});
      const pause=vi.fn(async()=>{});
      await expect(retryDatabaseResume(operation,pause)).rejects.toThrow();expect(operation).toHaveBeenCalledTimes(1);expect(pause).not.toHaveBeenCalled();
    }
  });
  test('transaction work executes once after resume and a failed commit is not repeated',async()=>{
    vi.useFakeTimers();const calls:string[]=[];let begun=0;
    const db=createRdsDataClinicalCoreDatabase({clusterArn:'arn:aws:rds:us-east-2:123456789012:cluster:fictional',secretArn:'arn:aws:secretsmanager:us-east-2:123456789012:secret:fictional-AbCdEf',databaseName:'clinical_core'},
      {send:async command=>{const name=(command as object).constructor.name;calls.push(name);
        if(name==='BeginTransactionCommand'){if(++begun===1)throw resuming();return {transactionId:'fictional'};}
        if(name==='CommitTransactionCommand')throw resuming();return {};
      }});
    const work=vi.fn(async()=>true);const pending=expect(db.transaction(work)).rejects.toThrow('query_failed');
    await vi.runAllTimersAsync();await pending;
    expect(work).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['BeginTransactionCommand','BeginTransactionCommand','ExecuteStatementCommand','CommitTransactionCommand','RollbackTransactionCommand']);
  });
});
