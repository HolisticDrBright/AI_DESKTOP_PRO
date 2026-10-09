import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAwsBrowserRecording, type AwsBrowserRecording } from './aws-browser-recording';
import { parseRecordingCaptureResponse } from '@/contracts/encounterRecordingCapture';
import type { requestRecordingCapture } from './recording-capture-client';
import type { CaptureAudioBridge } from './capture-audio-bridge';
import { AdapterError } from '@/adapters/errors';
const id='11111111-1111-4111-8111-111111111111', session='22222222-2222-4222-8222-222222222222';
const owners: AwsBrowserRecording[]=[];
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-17T00:00:00Z'));});
afterEach(()=>{for(const owner of owners.splice(0))owner.dispose();vi.useRealTimers();});
const flush=()=>vi.advanceTimersByTimeAsync(0);
function microphone(){
  const track={readyState:'live',stop:vi.fn(()=>{track.readyState='ended';})};
  return {track,stream:{getTracks:()=>[track],getAudioTracks:()=>[track]} as unknown as MediaStream};
}
class Recorder extends EventTarget {
  state:RecordingState='inactive';mimeType='audio/webm';noStopEvent=false;
  start=vi.fn(()=>{this.state='recording';});
  pause=vi.fn(()=>{this.state='paused';});
  resume=vi.fn(()=>{this.state='recording';});
  requestData=vi.fn();
  emitData(value:string){this.dispatchEvent(Object.assign(new Event('dataavailable'),{data:new Blob([value])}));}
  stop=vi.fn(()=>{
    this.state='inactive';
    if(!this.noStopEvent)queueMicrotask(()=>{this.emitData('final');this.dispatchEvent(new Event('stop'));});
  });
}
function fixture(){
  let version=0,stored=0,status='capturing',disposition:string|null=null,startCount=0;
  const audio: ReturnType<typeof microphone>[]=[];
  let attached: MediaStream|null=null;
  const media=new Recorder(),stableOutput=microphone().stream;
  const release=vi.fn(()=>{attached?.getTracks().forEach(t=>t.stop());attached=null;});
  const bridge:CaptureAudioBridge={stream:stableOutput,hasMicrophone:()=>attached!==null,
    replaceMicrophone:vi.fn(stream=>{release();attached=stream;}),
    releaseMicrophone:release,activate:vi.fn(async()=>{}),close:vi.fn(()=>release())};
  const changes=vi.fn(),getMicrophone=vi.fn(async()=>{const m=microphone();audio.push(m);return m.stream;});
  const events=new EventTarget() as Window;
  const visibility=Object.assign(new EventTarget(),{visibilityState:'visible'}) as unknown as Document;
  const base:typeof requestRecordingCapture=async(q)=>{
    const date=new Date(Date.now()+120000).toISOString();
    let data:unknown;
    if(q.operation==='readiness')data={encounterId:id,ready:true,authorityEpoch:1,checkedAt:new Date().toISOString(),
      expiresAt:new Date(Date.now()+30000).toISOString(),maxRecordingBytes:1000000,maxSegmentBytes:1000000,
      maxSegments:4096,audioRetentionHours:24,contentTypes:['audio/webm'],captureStarted:false,processingRequested:false};
    if(q.operation==='start'){startCount++;data={...q.input,recordingId:id,sessionId:session,status:'capturing',
      replayed:startCount>1,captureToken:startCount>1?null:'a'.repeat(64),credentialVersion:version,authorityEpoch:1,
      expiresAt:date,deletionDeadline:date};}
    if(q.operation==='segment'){stored++;data={segmentId:id,recordingId:id,sequence:q.input.sequence,sha256:q.input.sha256,
      bytes:q.input.bytes,authorityEpoch:1,status:'stored'};}
    if(q.operation==='state')data={recordingId:id,sessionId:session,status,credentialVersion:version,
      authorityEpoch:1,currentAuthorityEpoch:1,tokenExpiresAt:date,deletionDeadline:date,storedSegments:stored,
      pendingSegments:0,reservedBytes:stored,nextSequence:stored,inventorySha256:'a'.repeat(64),disposition,
      processingRequested:false,audioDeleted:false};
    if(q.operation==='command'){
      version++;status=q.input.action==='pause'?'paused':['finish','discard'].includes(q.input.action)?'closed':'capturing';
      if(status==='closed')disposition=q.input.action;
      data={recordingId:id,commandId:q.input.commandId,action:q.input.action,statusAtCommand:status,credentialVersion:version,
        expiresAt:date,inventorySha256:q.input.inventorySha256,processingRequested:false,audioDeleted:false,
        replayed:false,captureToken:status==='capturing'?'b'.repeat(64):null,requiresCredentialRecovery:false};
    }
    return parseRecordingCaptureResponse(q,{data});
  };
  const request=vi.fn(base);
  const recorder=vi.fn(()=>media as unknown as MediaRecorder),bridgeFactory=vi.fn(()=>bridge);
  const owner=createAwsBrowserRecording({encounterId:id,changed:changes,request,microphone:getMicrophone,
    recorder,bridge:bridgeFactory,supported:type=>type==='audio/webm',events,visibility});
  owners.push(owner);
  const start=async()=>{await owner.check();await owner.start();};
  return {owner,request,base,recorder,media,bridge,bridgeFactory,events,visibility,getMicrophone,audio,start,changes};
}
describe('AWS browser microphone ownership with fictional media and service',()=>{
  it('does not request a microphone before readiness or construct a recorder before server authorization',async()=>{
    const f=fixture();await expect(f.owner.start()).rejects.toThrow('recording_not_ready');
    expect(f.getMicrophone).not.toHaveBeenCalled();
    await f.owner.check();expect(f.getMicrophone).not.toHaveBeenCalled();
    await f.owner.start();
    expect(f.request.mock.calls.map(v=>v[0].operation)).toEqual(['readiness','start']);
    expect(f.recorder.mock.invocationCallOrder[0]).toBeGreaterThan(f.request.mock.invocationCallOrder[1]);
    expect(f.media.start).toHaveBeenCalledWith(1500);
    expect(f.audio[0].track.readyState).toBe('live');
  });
  it('retains one recorder/container across pause and explicit microphone replacement',async()=>{
    const f=fixture();await f.start();await f.owner.pause();
    expect(f.audio[0].track.readyState).toBe('ended');expect(f.media.state).toBe('paused');
    await f.owner.resume();
    expect(f.audio).toHaveLength(2);expect(f.audio[1].track.readyState).toBe('live');
    expect(f.recorder).toHaveBeenCalledOnce();expect(f.media.start).toHaveBeenCalledOnce();
    expect(f.media.resume).toHaveBeenCalledOnce();
  });
  it.each(['pagehide','offline'])('stops the microphone on %s without automatic reacquisition',async event=>{
    const f=fixture();await f.start();f.events.dispatchEvent(new Event(event));
    expect(f.audio[0].track.readyState).toBe('ended');
    expect(f.owner.snapshot().phase).toBe('paused');
    await vi.advanceTimersByTimeAsync(30000);
    expect(f.getMicrophone).toHaveBeenCalledOnce();
  });
  it('aborts a pending permission prompt when hidden and stops a late stream without sending start',async()=>{
    const f=fixture();await f.owner.check();let resolve!:(stream:MediaStream)=>void;
    f.getMicrophone.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
    const failure=expect(f.owner.start()).rejects.toThrow();
    await flush();
    Object.defineProperty(f.visibility,'visibilityState',{value:'hidden',configurable:true});
    f.visibility.dispatchEvent(new Event('visibilitychange'));
    await failure;
    const late=microphone();resolve(late.stream);await flush();
    expect(late.track.readyState).toBe('ended');
    expect(f.request.mock.calls.map(v=>v[0].operation)).toEqual(['readiness']);
    expect(f.recorder).not.toHaveBeenCalled();
  });
  it('closes the microphone after an uncertain start and does not create a recorder from a replay',async()=>{
    const f=fixture();await f.owner.check();
    f.request.mockImplementationOnce(async(...args)=>{await f.base(...args);throw new AdapterError('unavailable');});
    await expect(f.owner.start()).rejects.toThrow();
    expect(f.audio[0].track.readyState).toBe('ended');expect(f.recorder).not.toHaveBeenCalled();
    await f.owner.retry();
    expect(f.owner.snapshot().phase).toBe('recovery_required');
    await expect(f.owner.resume()).rejects.toThrow('recording_original_container_required');
    expect(f.getMicrophone).toHaveBeenCalledOnce();
  });
  it('does not send a start command when microphone permission is denied',async()=>{
    const f=fixture();await f.owner.check();f.getMicrophone.mockRejectedValueOnce(new Error('permission denied'));
    await expect(f.owner.start()).rejects.toThrow('microphone_denied');
    expect(f.request.mock.calls.map(v=>v[0].operation)).toEqual(['readiness']);
  });
  it('waits for the final encoded bytes before finishing and does not request transcription or deletion',async()=>{
    const f=fixture();await f.start();f.media.emitData('first');await flush();
    const finished=f.owner.finish();await flush();await finished;
    expect(f.audio[0].track.readyState).toBe('ended');
    expect(f.owner.snapshot()).toMatchObject({phase:'finished',storedSegments:2,bufferedBytes:0});
    expect(f.request.mock.calls.map(v=>v[0].operation)).toEqual(['readiness','start','segment','segment','state','command']);
    expect(f.bridge.close).toHaveBeenCalled();
  });
  it('requires recovery when the recorder does not deliver its stop event',async()=>{
    const f=fixture();await f.start();f.media.noStopEvent=true;
    const failed=expect(f.owner.finish()).rejects.toThrow('recorder_stop_unconfirmed');
    await vi.advanceTimersByTimeAsync(5000);await failed;
    expect(f.audio[0].track.readyState).toBe('ended');
    expect(f.owner.snapshot()).toMatchObject({phase:'recovery_required',incomplete:true});
    expect(f.request.mock.calls.some(v=>v[0].operation==='command')).toBe(false);
  });
  it('marks an encoder error incomplete and stops all input rather than claiming a finishable file',async()=>{
    const f=fixture();await f.start();f.media.dispatchEvent(new Event('error'));
    expect(f.audio[0].track.readyState).toBe('ended');
    expect(f.owner.snapshot()).toMatchObject({phase:'recovery_required',incomplete:true});
  });
  it('rejects a recorder encoding different from the server-authorized MIME type',async()=>{
    const f=fixture();await f.owner.check();f.media.mimeType='audio/mp4';
    await expect(f.owner.start()).rejects.toThrow('recording_encoding_mismatch');
    expect(f.audio[0].track.readyState).toBe('ended');expect(f.media.start).not.toHaveBeenCalled();
    expect(f.owner.snapshot().incomplete).toBe(true);
  });
  it('disposes the recorder, microphone, audio bridge, listeners and timers exactly once',async()=>{
    const f=fixture();await f.start();f.owner.dispose();f.owner.dispose();
    expect(f.audio[0].track.readyState).toBe('ended');expect(f.media.stop).toHaveBeenCalledOnce();
    expect(f.bridge.close).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
    const calls=f.changes.mock.calls.length;
    f.events.dispatchEvent(new Event('offline'));await flush();
    expect(f.changes.mock.calls).toHaveLength(calls);
    expect(f.owner.snapshot().phase).toBe('disposed');
  });
});
