import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { AwsRecordingTransport } from './aws-recording-transport';
import { parseRecordingCaptureResponse, type RecordingCaptureRequest } from '@/contracts/encounterRecordingCapture';
import type { requestRecordingCapture } from './recording-capture-client';
import { AdapterError } from '@/adapters/errors';

const encounterId='11111111-1111-4111-8111-111111111111', recordingId='22222222-2222-4222-8222-222222222222';
const sessionId='33333333-3333-4333-8333-333333333333', hash='a'.repeat(64);
const transports: AwsRecordingTransport[]=[];
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-17T00:00:00Z'));});
afterEach(()=>{for(const t of transports.splice(0)) t.dispose();vi.useRealTimers();});
const flush=()=>vi.advanceTimersByTimeAsync(0);
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return{promise,resolve};}
function fixture(limits: Record<string,unknown> = {}) {
  let version=0, token='b'.repeat(64), status='capturing', expires=Date.now()+120000, disposition:string|null=null;
  let startCommand:string|null=null, startedAt=0;
  const stored: {request:Extract<RecordingCaptureRequest,{operation:'segment'}>;bytes:ArrayBuffer}[]=[];
  const readiness=()=>({encounterId,ready:true,authorityEpoch:7,checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+30000).toISOString(),
    maxRecordingBytes:32*1024*1024,maxSegmentBytes:4*1024*1024,maxSegments:4096,audioRetentionHours:24,
    contentTypes:['audio/webm'],captureStarted:false,processingRequested:false,...limits});
  const commands=new Map<string,unknown>();
  const base: typeof requestRecordingCapture = async(request,_signal,bytes)=>{
    const q=request.input;
    let data:unknown;
    if(request.operation==='readiness') data=readiness();
    else if(request.operation==='start') {
      const replayed=startCommand===request.input.commandId;
      if(startCommand && !replayed) throw new AdapterError('conflict');
      startCommand=request.input.commandId;startedAt ||= Date.now();
      data={...q,recordingId,sessionId,status,replayed,captureToken:replayed?null:token,credentialVersion:version,authorityEpoch:7,
        expiresAt:new Date(expires).toISOString(),deletionDeadline:new Date(startedAt+86400000).toISOString()};
    } else if(request.operation==='segment') {
      if(request.input.captureToken!==token||status!=='capturing'||Date.now()>=expires) throw new AdapterError('forbidden');
      if(request.input.sequence>stored.length) throw new AdapterError('conflict');
      if(request.input.sequence===stored.length) stored.push({request,bytes:bytes!.slice(0)});
      else if(stored[request.input.sequence].request.input.sha256!==request.input.sha256) throw new AdapterError('conflict');
      data={segmentId:sessionId,recordingId,sequence:request.input.sequence,sha256:request.input.sha256,bytes:bytes!.byteLength,authorityEpoch:7,status:'stored'};
    } else if(request.operation==='state') {
      data={recordingId,sessionId,status,credentialVersion:version,authorityEpoch:7,currentAuthorityEpoch:7,
        tokenExpiresAt:new Date(expires).toISOString(),deletionDeadline:new Date(startedAt+86400000).toISOString(),
        storedSegments:stored.length,pendingSegments:0,reservedBytes:stored.reduce((sum,v)=>sum+v.bytes.byteLength,0),
        nextSequence:stored.length,inventorySha256:hash,disposition,processingRequested:false,audioDeleted:false};
    } else if(request.operation==='command') {
      const q=request.input, prior=commands.get(q.commandId);
      if(prior) return parseRecordingCaptureResponse(request,{data:prior});
      if(q.expectedVersion!==version) throw new AdapterError('conflict');
      version++;status=q.action==='pause'?'paused':q.action==='finish'||q.action==='discard'?'closed':'capturing';
      const credential=q.action==='resume'||q.action==='renew';
      if(credential){token=String(version%10).repeat(64);expires=Date.now()+120000;}
      else expires=Date.now();
      if(status==='closed') disposition=q.action;
      data={recordingId,commandId:q.commandId,action:q.action,statusAtCommand:status,credentialVersion:version,
        expiresAt:new Date(expires).toISOString(),inventorySha256:q.inventorySha256,processingRequested:false,audioDeleted:false,
        replayed:false,captureToken:credential?token:null,requiresCredentialRecovery:false};
      commands.set(q.commandId,{...(data as object),replayed:true,captureToken:null,requiresCredentialRecovery:credential});
    }
    return parseRecordingCaptureResponse(request,{data});
  };
  const request=vi.fn(base),halt=vi.fn(),changed=vi.fn();
  const digest=vi.fn(async(bytes:ArrayBuffer)=>createHash('sha256').update(Buffer.from(bytes)).digest('hex'));
  const transport=new AwsRecordingTransport({encounterId,request,halt,changed,uuid:randomUUID,digest});
  transports.push(transport);
  const start=async()=>{await transport.check();await transport.start('audio/webm');};
  return{transport,request,base,halt,changed,stored,start,digest,readiness};
}

describe('single-owner AWS recording transport',()=>{
  it('requires current readiness and a supported encoding before requesting capture',async()=>{
    const f=fixture();
    await expect(f.transport.start('audio/webm')).rejects.toThrow('recording_not_ready');
    expect(f.request).not.toHaveBeenCalled();
    await f.transport.check();
    await expect(f.transport.start('audio/mp4')).rejects.toThrow('recording_not_ready');
    await vi.advanceTimersByTimeAsync(30000);
    await expect(f.transport.start('audio/webm')).rejects.toThrow('recording_not_ready');
    expect(f.request.mock.calls.map(v=>v[0].operation)).toEqual(['readiness']);
  });
  it('splits encoded bytes by measured size, hashes each original segment, uploads in order and finishes exact inventory',async()=>{
    const f=fixture({maxSegmentBytes:3});await f.start();
    expect(f.transport.enqueue(new Blob(['abcdefgh']))).toBe(true);
    await flush();
    expect(f.stored.map(v=>Buffer.from(v.bytes).toString())).toEqual(['abc','def','gh']);
    expect(f.stored.map(v=>v.request.input.sequence)).toEqual([0,1,2]);
    for(const v of f.stored)expect(v.request.input.sha256).toBe(createHash('sha256').update(Buffer.from(v.bytes)).digest('hex'));
    expect(f.transport.snapshot()).toMatchObject({phase:'recording',bufferedBytes:0,storedSegments:3});
    await f.transport.finish();
    expect(f.transport.snapshot()).toMatchObject({phase:'finished',pendingOperation:null});
    const command=f.request.mock.calls.at(-1)![0];
    expect(command).toMatchObject({operation:'command',input:{action:'finish',inventorySha256:hash,expectedVersion:0}});
    expect(JSON.stringify(f.changed.mock.calls)).not.toContain('captureToken');
    expect(JSON.stringify(f.changed.mock.calls)).not.toContain('abcdefgh');
  });
  it('halts synchronously on pause, drains only the in-flight upload, and resumes the same session with fresh credentials',async()=>{
    const f=fixture({maxSegmentBytes:3});await f.start();
    const gate=deferred<void>();
    f.request.mockImplementationOnce(async(...args)=>{await gate.promise;return f.base(...args);});
    f.transport.enqueue(new Blob(['abcdef']));await flush();
    const pause=f.transport.pause();expect(f.halt).toHaveBeenCalledOnce();
    gate.resolve();await pause;
    expect(f.stored).toHaveLength(1);
    expect(f.transport.snapshot()).toMatchObject({phase:'paused',bufferedBytes:3});
    await f.transport.resume();await flush();
    expect(f.stored).toHaveLength(2);
    expect(f.stored[1].request.input).toMatchObject({recordingId,sessionId,sequence:1,captureToken:'2'.repeat(64)});
    expect(f.request.mock.calls.filter(v=>v[0].operation==='start')).toHaveLength(1);
  });
  it('never rotates credentials while an upload is in flight',async()=>{
    const f=fixture();await f.start();const gate=deferred<void>();
    f.request.mockImplementationOnce(async(...args)=>{await gate.promise;return f.base(...args);});
    f.transport.enqueue(new Blob(['original']));await flush();
    await vi.advanceTimersByTimeAsync(11000);
    expect(f.request.mock.calls.filter(v=>v[0].operation==='command')).toHaveLength(0);
    gate.resolve();await flush();
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.request.mock.calls.filter(v=>v[0].operation==='command')).toHaveLength(1);
    f.transport.enqueue(new Blob(['next']));await flush();
    expect(f.stored.map(v=>v.request.input.captureToken)).toEqual(['b'.repeat(64),'1'.repeat(64)]);
  });
  it('retains exact bytes and request after a lost upload acknowledgment, never retries automatically and counts replay once',async()=>{
    const f=fixture();await f.start();
    f.request.mockImplementationOnce(async(...args)=>{await f.base(...args);throw new AdapterError('unavailable');});
    f.transport.enqueue(new Blob(['one']));await flush();
    expect(f.transport.snapshot()).toMatchObject({phase:'uncertain',bufferedBytes:3,storedSegments:0,pendingOperation:'segment'});
    expect(f.halt).toHaveBeenCalled();
    // A final dataavailable event can arrive after microphone shutdown.
    expect(f.transport.enqueue(new Blob(['tail']))).toBe(true);
    const first=f.request.mock.calls.at(-1)!;
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.request.mock.calls.at(-1)).toBe(first);
    await f.transport.retry();
    const retry=f.request.mock.calls.at(-1)!;
    expect(retry[0]).toBe(first[0]);expect(retry[2]).toBe(first[2]);
    expect(f.stored).toHaveLength(1);
    expect(f.transport.snapshot()).toMatchObject({phase:'paused',storedSegments:1,bufferedBytes:4,pendingOperation:null});
    await f.transport.resume();await flush();
    expect(f.stored.map(v=>Buffer.from(v.bytes).toString())).toEqual(['one','tail']);
  });
  it('retains an uncertain start command and never treats a secret-free replay as microphone authorization',async()=>{
    const f=fixture();await f.transport.check();
    f.request.mockImplementationOnce(async(...args)=>{await f.base(...args);throw new AdapterError('unavailable');});
    await expect(f.transport.start('audio/webm')).rejects.toThrow();
    const first=f.request.mock.calls.at(-1)![0];
    expect(f.transport.snapshot()).toMatchObject({phase:'uncertain',pendingOperation:'start'});
    await expect(f.transport.start('audio/webm')).rejects.toThrow('recording_outcome_uncertain');
    await f.transport.retry();
    expect(f.request.mock.calls.at(-1)![0]).toBe(first);
    expect(f.transport.snapshot()).toMatchObject({phase:'recovery_required',recordingId,pendingOperation:null});
    await f.transport.discard();
    expect(f.transport.snapshot().phase).toBe('discarded');
  });
  it('stops on an uncertain renewal and never revives capture from a replayed credential receipt',async()=>{
    const f=fixture();await f.start();
    f.request.mockImplementationOnce(async(...args)=>{await f.base(...args);throw new AdapterError('unavailable');});
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.transport.snapshot()).toMatchObject({phase:'uncertain',pendingOperation:'command'});
    await f.transport.retry();
    expect(f.transport.snapshot().phase).toBe('recovery_required');
    expect(f.halt).toHaveBeenCalled();
    // Only an explicit resume, after fresh state/CAS, obtains another credential.
    await f.transport.resume();
    expect(f.transport.snapshot().phase).toBe('recording');
    expect(f.request.mock.calls.at(-1)![0]).toMatchObject({operation:'command',input:{action:'renew',expectedVersion:1}});
  });
  it('does not revive local capture when a renewal replies after the local freshness deadline',async()=>{
    const f=fixture();await f.start();const gate=deferred<void>();
    f.request.mockImplementationOnce(async(...args)=>{await gate.promise;return f.base(...args);});
    await vi.advanceTimersByTimeAsync(21000);
    expect(f.transport.snapshot().phase).toBe('paused');
    gate.resolve();await flush();
    expect(f.transport.snapshot().phase).toBe('paused');
  });
  it('bounds stuck requests independently of whether a fetch mock respects cancellation',async()=>{
    const f=fixture();await f.transport.check();
    f.request.mockImplementationOnce(()=>new Promise(()=>{}));
    const rejected=expect(f.transport.start('audio/webm')).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(8000);await rejected;
    expect(f.transport.snapshot()).toMatchObject({phase:'uncertain',pendingOperation:'start'});
    expect(f.halt).toHaveBeenCalled();
  });
  it('does not extend the local authority lease when the device wall clock moves backward',async()=>{
    const f=fixture();await f.start();
    f.request.mockImplementationOnce(()=>new Promise(()=>{}));
    vi.setSystemTime(new Date('2026-09-16T00:00:00Z'));
    await vi.advanceTimersByTimeAsync(21000);
    expect(f.request.mock.calls.filter(v=>v[0].operation==='command')).toHaveLength(1);
    expect(f.transport.snapshot().phase).toBe('paused');
    expect(f.halt).toHaveBeenCalled();
  });
  it.each([{maxRecordingBytes:3,maxSegmentBytes:3},{maxSegments:4096,maxSegmentBytes:1}])('refuses overflow without pretending the incomplete recording can finish %j',async limits=>{
    const f=fixture(limits);await f.start();
    const bytes=limits.maxRecordingBytes?4:4097;
    expect(f.transport.enqueue(new Blob([new Uint8Array(bytes)]))).toBe(false);
    expect(f.transport.snapshot()).toMatchObject({phase:'recovery_required',incomplete:true,bufferedBytes:0});
    await expect(f.transport.finish()).rejects.toThrow();
    expect(f.stored).toHaveLength(0);
  });
  it('bounds queued audio to eight MiB under network backpressure',async()=>{
    const f=fixture();await f.start();f.request.mockImplementationOnce(()=>new Promise(()=>{}));
    expect(f.transport.enqueue(new Blob([new Uint8Array(8*1024*1024)]))).toBe(true);
    expect(f.transport.enqueue(new Blob(['x']))).toBe(false);
    expect(f.transport.snapshot()).toMatchObject({incomplete:true,bufferedBytes:8*1024*1024,bufferedSegments:2});
  });
  it('halts on local hashing failure instead of entering an unbounded retry loop',async()=>{
    const f=fixture();await f.start();f.digest.mockRejectedValue(new Error('hash unavailable'));
    f.transport.enqueue(new Blob(['data']));await flush();
    expect(f.transport.snapshot()).toMatchObject({phase:'recovery_required',bufferedBytes:4});
    expect(f.digest).toHaveBeenCalledOnce();
    expect(f.request.mock.calls.filter(v=>v[0].operation==='segment')).toHaveLength(0);
  });
  it('stops on mismatched authority epoch even when an upload receipt is structurally valid',async()=>{
    const f=fixture();await f.start();
    f.request.mockImplementationOnce(async(...args)=>{
      const result=await f.base(...args);return parseRecordingCaptureResponse(args[0],{data:{...result.data,authorityEpoch:8}});
    });
    f.transport.enqueue(new Blob(['data']));await flush();
    expect(f.transport.snapshot()).toMatchObject({phase:'recovery_required',bufferedBytes:4,storedSegments:0});
  });
  it('refuses resume after another device changes the session or roster',async()=>{
    const f=fixture();await f.start();await f.transport.pause();
    f.request.mockImplementationOnce(async(...args)=>{
      const result=await f.base(...args);return parseRecordingCaptureResponse(args[0],{data:{...result.data,currentAuthorityEpoch:8}});
    });
    await expect(f.transport.resume()).rejects.toThrow('recording_state_changed');
    expect(f.transport.snapshot().phase).toBe('recovery_required');
  });
  it('disposes synchronously, aborts pending work, drops local buffers and ignores late replies',async()=>{
    const f=fixture();await f.start();const gate=deferred<void>();
    f.request.mockImplementationOnce(async(...args)=>{await gate.promise;return f.base(...args);});
    f.transport.enqueue(new Blob(['data']));await flush();
    const signal=f.request.mock.calls.at(-1)![1];
    f.transport.dispose();
    expect(signal.aborted).toBe(true);
    expect(f.transport.snapshot()).toMatchObject({phase:'disposed',bufferedBytes:0,pendingOperation:null});
    gate.resolve();await flush();
    expect(f.transport.snapshot().phase).toBe('disposed');
    expect(f.transport.enqueue(new Blob(['late']))).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not silently take over another device control version when finishing',async()=>{
    const f=fixture();await f.start();f.transport.enqueue(new Blob(['data']));await flush();
    f.request.mockImplementationOnce(async(...args)=>{
      const result=await f.base(...args);
      return parseRecordingCaptureResponse(args[0],{data:{...result.data,credentialVersion:2}});
    });
    await expect(f.transport.finish()).rejects.toThrow('recording_state_changed');
    expect(f.request.mock.calls.some(v=>v[0].operation==='command')).toBe(false);
    expect(f.transport.snapshot().phase).toBe('paused');
  });
});
