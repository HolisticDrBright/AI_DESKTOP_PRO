import { beforeEach, describe, expect, it, vi } from 'vitest';

// These tests exercise the production port factory with intercepted transport,
// not hosted acceptance. No credential is resolved, AWS call made or review set.
const observed = vi.hoisted(() => ({ credentials: vi.fn(() => async () => ({})), configuration: vi.fn(), send: vi.fn() }));
vi.mock('@aws-sdk/credential-provider-ini', () => ({ fromIni: observed.credentials }));
vi.mock('@aws-sdk/client-rds-data', () => {
  class Command { constructor(readonly input: Record<string, unknown>) {} }
  return { RDSDataClient: class { constructor(input: unknown) { observed.configuration(input); } send = observed.send; },
    BeginTransactionCommand: class extends Command {}, ExecuteStatementCommand: class extends Command {}, RollbackTransactionCommand: class extends Command {} };
});
// The runner is also directly exercised by its real embedded-database suite.
import { createHostedPorts, readClinicHostedJson, CLINIC_HOSTED_RESPONSE_MAX_BYTES } from '../../../scripts/clinic-records-qualification-runner.mjs';

const target = { apiId: 'abcdefghij', clusterArn: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional',
  secretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-AbCd12', database: 'clinical_core_qualification' };
const route = 'POST /clinical-core/consumer/clinic-records';
beforeEach(() => { vi.unstubAllGlobals(); observed.credentials.mockClear(); observed.configuration.mockClear(); observed.send.mockReset(); });

function stream(parts: Uint8Array[], headers: Record<string, string> = {}) {
  const cancelled = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close(); }, cancel: cancelled });
  return { response: new Response(body, { headers: { 'content-type': 'application/json', ...headers } }), cancelled };
}
describe('clinic hosted transport boundaries', () => {
  it('pins credential STS separately from RDS and never resolves credentials while constructing ports', async () => {
    await createHostedPorts(target);
    expect(observed.credentials).toHaveBeenCalledExactlyOnceWith({ profile: 'ai-synthetic-member',
      clientConfig: { region: 'us-east-2', endpoint: 'https://sts.us-east-2.amazonaws.com' } });
    expect(observed.configuration).toHaveBeenCalledWith(expect.objectContaining({ region: 'us-east-2',
      endpoint: 'https://rds-data.us-east-2.amazonaws.com', maxAttempts: 1 }));
    expect(observed.send).not.toHaveBeenCalled();
  });
  it('refuses a production target before constructing any client', async () => {
    await expect(createHostedPorts({ ...target, database: 'clinical_core' })).rejects.toThrow('hosted_target_refused');
    expect(observed.credentials).not.toHaveBeenCalled(); expect(observed.configuration).not.toHaveBeenCalled();
  });
  it('uses the actual bounded response reader from the pinned POST path', async () => {
    const fetcher = vi.fn(async () => new Response('{"data":{"ok":true}}', { headers: { 'content-type': 'application/json', 'x-clinical-execution': 'qualification' } }));
    vi.stubGlobal('fetch', fetcher);
    const ports = await createHostedPorts(target);
    expect(await ports.http(route, 'fictional-token', '{}')).toEqual({ status: 200, json: { data: { ok: true } }, execution: 'qualification' });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://abcdefghij.execute-api.us-east-2.amazonaws.com/clinical-core/consumer/clinic-records',
      expect.objectContaining({ method: 'POST', redirect: 'error', cache: 'no-store', body: '{}', signal: expect.any(AbortSignal) }));
  });
  it.each([
    ['POST /unreviewed', 'fictional-token', '{}'], [route, '', '{}'], [route, 'token\r\nheader', '{}'],
    [route, 'x'.repeat(16385), '{}'], [route, 'fictional-token', 'x'.repeat(81921)],
  ])('refuses out-of-scope or oversized request before fetch %s', async (path, token, body) => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); const ports = await createHostedPorts(target);
    await expect(ports.http(path, token, body)).rejects.toThrow('http_request_refused'); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['-1', '1.5', '01', '9007199254740993', String(1024 * 1024 + 1)])('refuses invalid/oversized declared length %s', async length => {
    const r = stream([Buffer.from('{}')], { 'content-length': length });
    await expect(readClinicHostedJson(r.response)).rejects.toThrow('http_response_headers_refused');
  });
  it('accepts a split UTF-8 response, bounded at its actual byte length', async () => {
    const bytes = Buffer.from('{"value":"測定"}');
    const r = stream([bytes.subarray(0, 11), bytes.subarray(11)], { 'content-length': String(bytes.length) });
    expect(await readClinicHostedJson(r.response)).toEqual({ value: '測定' });
  });
  it('stops an undeclared overrun, cancels unread bytes and releases the reader lock', async () => {
    const cancel = vi.fn(); let pullCount = 0;
    const body = new ReadableStream({ pull(controller) { pullCount++; controller.enqueue(new Uint8Array(CLINIC_HOSTED_RESPONSE_MAX_BYTES + 1)); }, cancel });
    const response = new Response(body, { headers: { 'content-type': 'application/json' } });
    await expect(readClinicHostedJson(response)).rejects.toThrow('http_response_overrun');
    expect(cancel).toHaveBeenCalledTimes(1); expect(body.locked).toBe(false); expect(pullCount).toBeLessThanOrEqual(2);
  });
  it.each([['1', 'http_response_overrun'], ['3', 'http_response_short']])('refuses disagreeing content length %s', async (length, category) => {
    await expect(readClinicHostedJson(stream([Buffer.from('{}')], { 'content-length': length }).response)).rejects.toThrow(category);
  });
  it('does not confuse compressed wire length with the already decoded byte length', async () => {
    expect(await readClinicHostedJson(stream([Buffer.from('{"ok":true}')], { 'content-length': '5', 'content-encoding': 'gzip' }).response)).toEqual({ ok: true });
  });
  it.each([
    [Buffer.from('not-json'), { 'content-type': 'application/json' }, 'http_response_json_refused'],
    [new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc0, 0xaf, 0x22, 0x7d]), { 'content-type': 'application/json' }, 'http_response_json_refused'],
    [Buffer.from('{}'), { 'content-type': 'text/html' }, 'http_response_headers_refused'],
  ])('refuses non-JSON or invalid UTF-8 without returning body text', async (bytes, headers, category) => {
    await expect(readClinicHostedJson(stream([bytes], headers).response)).rejects.toThrow(category);
  });
  it('accepts legitimate copy pages larger than the old 64 KiB consumer harness limit', async () => {
    const json = { data: { payloadText: 'x'.repeat(256 * 1024) } }; const bytes = Buffer.from(JSON.stringify(json));
    expect(await readClinicHostedJson(stream([bytes], { 'content-length': String(bytes.length) }).response)).toEqual(json);
  });
  it('executes readback only inside a read-only transaction and awaits rollback before returning rows', async () => {
    observed.send.mockResolvedValueOnce({ transactionId: 'fictional-readonly' }).mockResolvedValueOnce({})
      .mockResolvedValueOnce({ formattedRecords: '[{"n":1}]' }).mockResolvedValueOnce({ transactionStatus: 'Rollback complete', $metadata: { httpStatusCode: 200 } });
    const ports = await createHostedPorts(target);
    expect(await ports.sql('select count(*) n from clinical_core.clinic_record_requests where id=$1', ['11111111-1111-4111-8111-111111111111']))
      .toEqual({ rows: [{ n: 1 }] });
    expect(observed.send).toHaveBeenCalledTimes(4);
    const inputs = observed.send.mock.calls.map(([command]) => command.input);
    expect(inputs[1]).toMatchObject({ sql: 'SET TRANSACTION READ ONLY', transactionId: 'fictional-readonly', database: target.database });
    expect(inputs[2]).toMatchObject({ sql: 'select count(*) n from clinical_core.clinic_record_requests where id=:p1',
      transactionId: 'fictional-readonly', parameters: [{ name: 'p1', value: { stringValue: '11111111-1111-4111-8111-111111111111' }, typeHint: 'UUID' }] });
    expect(inputs[3]).toEqual({ resourceArn: target.clusterArn, secretArn: target.secretArn, database: target.database, transactionId: 'fictional-readonly' });
    for (const [, options] of observed.send.mock.calls) expect(options).toMatchObject({ abortSignal: expect.any(AbortSignal) });
  });
  it('propagates a readback failure only after attempting rollback, never returning invented rows', async () => {
    observed.send.mockResolvedValueOnce({ transactionId: 'fictional-readonly' }).mockResolvedValueOnce({})
      .mockRejectedValueOnce(Error('fictional_read_denied')).mockResolvedValueOnce({ transactionStatus: 'Rollback complete', $metadata: { httpStatusCode: 200 } });
    const ports = await createHostedPorts(target);
    await expect(ports.sql('select count(*) n from clinical_core.clinic_record_requests', [])).rejects.toThrow('fictional_read_denied');
    expect(observed.send).toHaveBeenCalledTimes(4);
  });
  it('does not return readback rows if rollback itself fails', async () => {
    observed.send.mockResolvedValueOnce({ transactionId: 'fictional-readonly' }).mockResolvedValueOnce({})
      .mockResolvedValueOnce({ formattedRecords: '[{"n":1}]' }).mockRejectedValueOnce(Error('fictional_rollback_denied'));
    const ports = await createHostedPorts(target);
    await expect(ports.sql('select 1 n', [])).rejects.toThrow('fictional_rollback_denied');
  });
  it.each(['', null, 42, 'x'.repeat(193)])('refuses a malformed transaction id before any statement %s', async transactionId => {
    observed.send.mockResolvedValueOnce({ transactionId }); const ports = await createHostedPorts(target);
    await expect(ports.sql('select 1 n', [])).rejects.toThrow('sql_transaction_required');
    expect(observed.send).toHaveBeenCalledTimes(1);
  });
  it.each([
    {}, { transactionStatus: 'Rollback complete' },
    { transactionStatus: 'Rollback complete', $metadata: { httpStatusCode: 500 } },
    { transactionStatus: 'unknown', $metadata: { httpStatusCode: 200 } },
  ])('refuses readback when rollback has no confirmed service receipt %j', async receipt => {
    observed.send.mockResolvedValueOnce({ transactionId: 'fictional-readonly' }).mockResolvedValueOnce({})
      .mockResolvedValueOnce({ formattedRecords: '[{"n":1}]' }).mockResolvedValueOnce(receipt);
    const ports = await createHostedPorts(target);
    await expect(ports.sql('select 1 n', [])).rejects.toThrow('sql_rollback_unconfirmed');
    expect(observed.send).toHaveBeenCalledTimes(4);
  });
  it('refuses a write-shaped inspection query without beginning a transaction', async () => {
    const ports = await createHostedPorts(target);
    await expect(ports.sql('delete from clinical_core.clinic_record_requests', [])).rejects.toThrow('sql_read_refused');
    expect(observed.send).not.toHaveBeenCalled();
  });
});
