import { describe, expect, it } from 'vitest';
import { recordingReadinessSchema, parseRecordingCaptureResponse, isRecordingReadinessCurrent } from './encounterRecordingCapture';
const id='11111111-1111-4111-8111-111111111111', other='22222222-2222-4222-8222-222222222222';
const ready={encounterId:id,ready:true,authorityEpoch:1,checkedAt:'2026-09-17T00:00:00Z',expiresAt:'2026-09-17T00:00:30Z',
  maxRecordingBytes:1000000,maxSegmentBytes:1000000,maxSegments:4096,audioRetentionHours:24,
  contentTypes:['audio/webm'],captureStarted:false,processingRequested:false};
describe('short-lived recording readiness is not authority to capture',()=>{
  it.each([{ready:false},{captureToken:'a'.repeat(64)},{captureStarted:true},{processingRequested:true},
    {maxSegmentBytes:1000001},{maxSegmentBytes:0},{maxRecordingBytes:2147483649},{maxSegments:4097},
    {audioRetentionHours:25},{contentTypes:[]},{contentTypes:['audio/webm','audio/webm']},{contentTypes:['video/webm']},
    {expiresAt:'2026-09-17T00:00:31Z'},{expiresAt:ready.checkedAt},{checkedAt:ready.expiresAt}])
    ('rejects fabricated authority or invalid limits %j',patch=>{
      expect(recordingReadinessSchema.safeParse({...ready,...patch}).success).toBe(false);
    });
  it('binds the encounter and requires an unexpired non-future observation',()=>{
    const at=Date.parse(ready.checkedAt);
    expect(isRecordingReadinessCurrent(ready,id,at)).toBe(true);
    for(const now of [at-1,at+30000,NaN,Infinity]) expect(isRecordingReadinessCurrent(ready,id,now)).toBe(false);
    expect(isRecordingReadinessCurrent(ready,other,at)).toBe(false);
    expect(parseRecordingCaptureResponse({operation:'readiness',input:{encounterId:id}},{data:ready})).toEqual({data:ready});
    expect(()=>parseRecordingCaptureResponse({operation:'readiness',input:{encounterId:other}},{data:ready})).toThrow();
  });
});
