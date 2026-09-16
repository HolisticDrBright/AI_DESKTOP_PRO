import {describe,it,expect,vi} from 'vitest';
import {DeleteObjectsCommand,type S3Client} from '@aws-sdk/client-s3';
import {erasePersonalVoiceObjects} from './voice-object-cleanup';
const id='a'.repeat(64),key=`personal-voice/input/${id}.wav`,job={id,format:'wav'};
describe('production voice object erasure',()=>{
  it('removes exact historical versions and delete markers then verifies both keys empty',async()=>{
    const send=vi.fn().mockResolvedValueOnce({Versions:[{Key:key,VersionId:'v1'}],DeleteMarkers:[{Key:key,VersionId:'m1'}]})
      .mockResolvedValueOnce({}).mockResolvedValueOnce({}).mockResolvedValueOnce({});
    await erasePersonalVoiceObjects({send} as unknown as S3Client,'test-bucket',job);
    expect(send.mock.calls[1][0]).toBeInstanceOf(DeleteObjectsCommand);
    expect(send.mock.calls[1][0].input.Delete.Objects).toEqual([{Key:key,VersionId:'v1'},{Key:key,VersionId:'m1'}]);
    expect(send).toHaveBeenCalledTimes(4);
  });
  it.each([{Versions:[{Key:key+'-other',VersionId:'v1'}]},{Versions:[{Key:key}]},{IsTruncated:true}])('refuses unexpected/incomplete listings %j',async response=>{
    const send=vi.fn().mockResolvedValue(response);
    await expect(erasePersonalVoiceObjects({send} as unknown as S3Client,'test-bucket',job)).rejects.toThrow();
    expect(send.mock.calls.some(([c])=>c instanceof DeleteObjectsCommand)).toBe(false);
  });
  it('propagates partial deletion failures for durable retry',async()=>{
    const send=vi.fn().mockResolvedValueOnce({Versions:[{Key:key,VersionId:'v1'}]}).mockResolvedValueOnce({Errors:[{Code:'AccessDenied'}]});
    await expect(erasePersonalVoiceObjects({send} as unknown as S3Client,'test-bucket',job)).rejects.toThrow('voice_cleanup_retry_required');
  });
  it('rejects client-shaped object paths before S3',async()=>{
    const send=vi.fn();
    await expect(erasePersonalVoiceObjects({send} as unknown as S3Client,'test-bucket',{id:'../another',format:'wav'})).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});
