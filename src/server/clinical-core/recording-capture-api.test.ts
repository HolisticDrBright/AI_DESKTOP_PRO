import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createRecordingCaptureApi, RECORDING_CAPTURE_ROUTES as routes, type RecordingCaptureConfiguration } from './recording-capture-api';
import { RecordingLifecycleError } from './recording-lifecycle';
import { RecordingUploadError } from './recording-segments';
import type { ApiGatewayV2Event } from './aws-identity-api';

const id = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
const now = Date.now(), seconds = Math.floor(now / 1000), at = new Date(now + 60000).toISOString();
const config: RecordingCaptureConfiguration = { workforceIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/fictional',
  workforceAudience: '12345678901234567890', organizationId: id, phiAllowed: true, activation: 'approved',
  activationEvidenceSha256: 'a'.repeat(64), databaseReviewSha256: 'b'.repeat(64), mfaReviewSha256: 'c'.repeat(64),
  captureReleaseId: other, captureReviewSha256: 'd'.repeat(64), storageReviewSha256: 'e'.repeat(64), retentionReviewSha256: 'f'.repeat(64) };
const bytes = Buffer.from('FICTIONAL AUDIO'), sha = createHash('sha256').update(bytes).digest('hex');
function event(route: string, body: unknown = {}, claims: Record<string, string | number | boolean | undefined> = {}): ApiGatewayV2Event {
  return { routeKey: route, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    requestContext: { authorizer: { jwt: { claims: { iss: config.workforceIssuer, aud: config.workforceAudience,
      token_use: 'id', sub: 'fictional-subject', 'custom:person_id': id, 'custom:organization_id': id,
      'custom:production_bound': 'true', email_verified: 'true', iat: seconds, exp: seconds + 600, auth_time: seconds, ...claims } } } } };
}
function segment(): ApiGatewayV2Event {
  return { ...event(routes.segment), isBase64Encoded: true, body: bytes.toString('base64'), headers: { 'content-type': 'audio/webm',
    'x-alp-recording-id': id, 'x-alp-session-id': id, 'x-alp-capture-token': 'a'.repeat(64), 'x-alp-sequence': '0', 'x-alp-sha256': sha } };
}
function fixture(configuration = config) {
  const readiness = vi.fn().mockResolvedValue({ encounterId:id, ready:true, authorityEpoch:0,
    checkedAt:new Date(now).toISOString(), expiresAt:new Date(now+30000).toISOString(), maxRecordingBytes:1000000,
    maxSegmentBytes:1000000, maxSegments:4096, audioRetentionHours:24, contentTypes:['audio/webm'],
    captureStarted:false, processingRequested:false });
  const start = vi.fn().mockResolvedValue({ recordingId: id, sessionId: id, encounterId: id, commandId: other, contentType: 'audio/webm',
    status: 'capturing', replayed: false, captureToken: 'a'.repeat(64), credentialVersion: 0, authorityEpoch: 0, expiresAt: at, deletionDeadline: at });
  const state = vi.fn().mockResolvedValue({ recordingId: id, sessionId: id, status: 'capturing', credentialVersion: 0, authorityEpoch: 0,
    currentAuthorityEpoch: 0, tokenExpiresAt: at, deletionDeadline: at, storedSegments: 0, pendingSegments: 0, reservedBytes: 0, nextSequence: 0,
    inventorySha256: 'b'.repeat(64), disposition: null, processingRequested: false, audioDeleted: false });
  const command = vi.fn().mockResolvedValue({ recordingId: id, commandId: other, action: 'pause', statusAtCommand: 'paused', credentialVersion: 1,
    expiresAt: at, inventorySha256: null, captureToken: null, replayed: false, requiresCredentialRecovery: false, processingRequested: false, audioDeleted: false });
  const upload = vi.fn().mockResolvedValue({ segmentId: other, recordingId: id, sequence: 0, sha256: sha, bytes: bytes.length, authorityEpoch: 0, status: 'stored' });
  const lifecycleFactory = vi.fn(() => ({ readiness, start, state, command })), uploadFactory = vi.fn(() => upload);
  const reconcile = vi.fn().mockResolvedValue({ recordingId: id, outcome: 'no_pending_segment' }), reconcileFactory = vi.fn(() => reconcile);
  return { readiness, start, state, command, upload, lifecycleFactory, uploadFactory, reconcile, reconcileFactory,
    handler: createRecordingCaptureApi({ configuration, lifecycle: lifecycleFactory, upload: uploadFactory, reconcile: reconcileFactory, now: () => now }) };
}
describe('independently governed recording transport API', () => {
  it('preflights without starting capture, accepts no caller-selected release and never bypasses activation or reauthentication', async () => {
    const f=fixture(), request=event(routes.readiness,{encounterId:id});
    expect((await f.handler(request)).statusCode).toBe(200);
    expect(f.readiness).toHaveBeenCalledWith(expect.objectContaining({identityPool:'workforce'}),{encounterId:id},config.captureReleaseId);
    expect(f.start).not.toHaveBeenCalled(); expect(f.uploadFactory).not.toHaveBeenCalled();
    for(const extra of [{releaseId:other},{captureToken:'a'.repeat(64)},{organizationId:other}])
      expect((await f.handler(event(routes.readiness,{encounterId:id,...extra}))).statusCode).toBe(400);
    f.readiness.mockResolvedValue({...await f.readiness(),encounterId:other});
    expect((await f.handler(request)).statusCode).toBe(503);
    const blocked=fixture({...config,phiAllowed:false,activation:'blocked'});
    expect((await blocked.handler(request)).statusCode).toBe(503);
    expect(blocked.lifecycleFactory).not.toHaveBeenCalled();
    const stale=fixture();
    expect((await stale.handler(event(routes.readiness,{encounterId:id},{auth_time:seconds-901}))).statusCode).toBe(401);
    expect(stale.lifecycleFactory).not.toHaveBeenCalled();
  });
  it('reconciles only with fresh workforce identity, no client-supplied object evidence, and a correlated receipt', async () => {
    const f=fixture(), request=event(routes.reconcile,{recordingId:id});
    expect((await f.handler(request)).statusCode).toBe(200);
    expect(f.reconcile).toHaveBeenCalledWith(expect.objectContaining({identityPool:'workforce',actorPersonId:id}),{recordingId:id});
    for(const patch of [{segmentId:other},{objectVersion:'v1'},{bucket:'override'},{captureToken:'a'.repeat(64)}])
      expect((await f.handler(event(routes.reconcile,{recordingId:id,...patch}))).statusCode).toBe(400);
    expect(f.reconcile).toHaveBeenCalledOnce();
    f.reconcile.mockResolvedValue({recordingId:other,outcome:'no_pending_segment'});
    expect((await f.handler(request)).statusCode).toBe(503);
    const unauth=fixture();
    expect((await unauth.handler(event(routes.reconcile,{recordingId:id},{auth_time:seconds-901}))).statusCode).toBe(401);
    expect(unauth.reconcileFactory).not.toHaveBeenCalled();
    const blocked=fixture({...config,phiAllowed:false,activation:'blocked'});
    expect((await blocked.handler(request)).statusCode).toBe(503);
    expect(blocked.reconcileFactory).not.toHaveBeenCalled();
  });
  it('stays blocked without PHI activation and never constructs database or storage services', async () => {
    const f = fixture({ ...config, phiAllowed: false, activation: 'blocked', captureReleaseId: '' });
    expect(JSON.parse((await f.handler(segment())).body)).toEqual({ error: 'production_not_activated', phiAllowed: false });
    expect(f.lifecycleFactory).not.toHaveBeenCalled(); expect(f.uploadFactory).not.toHaveBeenCalled();
    for (const key of ['captureReleaseId', 'captureReviewSha256', 'storageReviewSha256', 'retentionReviewSha256'])
      expect(() => fixture({ ...config, [key]: '' })).toThrow('recording_capture_activation_invalid');
  });
  it.each([{ iss: 'https://cognito-idp.us-east-2.amazonaws.com/consumer' }, { aud: 'other' }, { token_use: 'access' },
    { email_verified: false }, { 'custom:production_bound': 'false' }, { 'custom:synthetic_attested': 'true' },
    { 'custom:person_id': 'bad' }, { 'custom:organization_id': other }, { sub: '' }, { exp: seconds - 1 },
    { iat: seconds + 120 }, { auth_time: seconds - 901 }, { auth_time: undefined }])('rejects invalid workforce identity %j before services', async claims => {
    const f = fixture(), e = event(routes.state, { recordingId: id }, claims);
    expect((await f.handler(e)).statusCode).toBe(401);
    expect(f.lifecycleFactory).not.toHaveBeenCalled(); expect(f.uploadFactory).not.toHaveBeenCalled();
  });
  it('routes start/state/command with no caller-selected release, identity or provider', async () => {
    const f = fixture(), start = { encounterId: id, commandId: other, contentType: 'audio/webm' };
    expect((await f.handler(event(routes.start, start))).statusCode).toBe(200);
    expect(f.start).toHaveBeenCalledWith(expect.objectContaining({ identityPool: 'workforce', actorPersonId: id, organizationId: id }), start, config.captureReleaseId);
    expect((await f.handler(event(routes.state, { recordingId: id }))).statusCode).toBe(200);
    expect((await f.handler(event(routes.command, { recordingId: id, commandId: other, action: 'pause', expectedVersion: 0, inventorySha256: null }))).statusCode).toBe(200);
    for (const patch of [{ captureReleaseId: id }, { actorPersonId: id }, { bucket: 'other' }, { provider: 'other' }])
      expect((await f.handler(event(routes.start, { ...start, ...patch }))).statusCode).toBe(400);
    expect(f.start).toHaveBeenCalledOnce();
  });
  it('accepts canonical binary payload with bounded metadata and responds with only a receipt', async () => {
    const f = fixture(), result = await f.handler(segment());
    expect(result.statusCode).toBe(200); expect(result.headers['cache-control']).toBe('no-store');
    expect(f.upload).toHaveBeenCalledWith(expect.objectContaining({ actorPersonId: id }), {
      recordingId: id, sessionId: id, captureToken: 'a'.repeat(64), sequence: 0, sha256: sha, bytes: bytes.length, contentType: 'audio/webm' }, bytes);
    expect(result.body).not.toMatch(/captureToken|objectKey|FICTIONAL AUDIO/);
  });
  it.each([
    { isBase64Encoded: false }, { body: '!!!' }, { body: '' }, { body: bytes.toString('base64') + '\n' },
    { oversized: true }, { queryStringParameters: { token: 'secret' } }, { requestContext: undefined },
  ])('refuses malformed or unauthenticated segment before service %j', async patch => {
    const f = fixture(), change = 'oversized' in patch ? { body: 'a'.repeat(5592409) } : patch;
    expect((await f.handler({ ...segment(), ...change })).statusCode).toBe('requestContext' in patch ? 401 : 400);
    expect(f.uploadFactory).not.toHaveBeenCalled();
  });
  it.each([{ 'content-type': 'audio/webm,application/json' }, { 'content-type': 'audio/mp4; arbitrary=yes' },
    { 'x-alp-capture-token': '' }, { 'x-alp-capture-token': 'a'.repeat(64) + ',other' }, { 'X-ALP-CAPTURE-TOKEN': 'a'.repeat(64) },
    { 'x-alp-sequence': '00' }, { 'x-alp-sequence': '-1' }, { 'x-alp-sequence': '4096' }, { 'x-alp-sha256': 'bad' },
    { 'x-alp-bucket': 'arbitrary' }, { 'x-alp-person-id': id }])('refuses duplicate/altered/unknown metadata %j', async headers => {
    const f = fixture(), e = segment();
    expect((await f.handler({ ...e, headers: { ...e.headers, ...headers } })).statusCode).toBe(400);
    expect(f.uploadFactory).not.toHaveBeenCalled();
  });
  it('rejects malformed JSON, query identity and token-only login without using fallback', async () => {
    const f = fixture(), e = event(routes.state, { recordingId: id });
    for (const patch of [{ body: '{' }, { body: 'x'.repeat(16001) }, { body: '[]' }, { queryStringParameters: { organizationId: id } },
      { headers: { 'content-type': 'text/plain' } }, { headers: { ...e.headers, 'x-alp-capture-token': 'a'.repeat(64) } },
      { isBase64Encoded: true, body: '!' + Buffer.from(e.body!).toString('base64') },
      { isBase64Encoded: true, body: Buffer.from([255]).toString('base64') }])
      expect((await f.handler({ ...e, ...patch })).statusCode).toBe(400);
    expect((await f.handler({ ...e, requestContext: undefined, headers: { ...e.headers, authorization: 'Bearer unverified' } })).statusCode).toBe(401);
    expect((await f.handler({ ...e, routeKey: 'POST /clinical-core/consumer/encounter-recording/start' })).statusCode).toBe(404);
    expect(f.lifecycleFactory).not.toHaveBeenCalled();
  });
  it('accepts base64 JSON and sanitizes provider details or malformed output', async () => {
    const f = fixture(), e = event(routes.state, { recordingId: id });
    expect((await f.handler({ ...e, body: Buffer.from(e.body!).toString('base64'), isBase64Encoded: true })).statusCode).toBe(200);
    f.state.mockResolvedValue({ private: 'recording object key' });
    expect(JSON.parse((await f.handler(e)).body)).toEqual({ error: 'service_unavailable' });
    f.upload.mockRejectedValue(new Error('patient and storage details'));
    expect(JSON.parse((await f.handler(segment())).body)).toEqual({ error: 'service_unavailable' });
    // Authored errors crossing the separate deployment bundle do not share
    // constructors. Preserve only the bounded category, never their message.
    f.upload.mockRejectedValue(Object.assign(new Error('private details'), { name: 'RecordingUploadError', code: 'consent_required' }));
    expect(JSON.parse((await f.handler(segment())).body)).toEqual({ error: 'consent_required' });
    f.upload.mockRejectedValue(Object.assign(new Error('private details'), { name: 'RecordingUploadError', code: 'private_details' }));
    expect(JSON.parse((await f.handler(segment())).body)).toEqual({ error: 'service_unavailable' });
    for (const [error, status] of [[new RecordingUploadError('storage_unverified'), 503], [new RecordingUploadError('consent_required'), 403],
      [new RecordingLifecycleError('conflict'), 409], [new RecordingLifecycleError('access_refused'), 403]] as const) {
      f.upload.mockRejectedValue(error); expect((await f.handler(segment())).statusCode).toBe(status);
    }
  });
});
