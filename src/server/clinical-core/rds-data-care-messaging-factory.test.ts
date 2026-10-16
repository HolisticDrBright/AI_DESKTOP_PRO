import { beforeEach, describe, expect, it, vi } from 'vitest';

// The restricted care-messaging database factory, called directly (not through the handler). The documented guarantee is
// that a refused configuration — the cluster-master secret above all — is refused before any database client exists.
// A client's construction and its first request are counted apart: constructing an RDSDataClient sends nothing, so a
// construction is not an AWS request, but it is a client built for a secret the boundary refuses.
const sdk = vi.hoisted(() => ({ constructed: vi.fn(), send: vi.fn() }));
vi.mock('./rds-single-attempt-client', () => ({
  createSingleAttemptRdsClient: (configuration: unknown) => { sdk.constructed(configuration); return { send: sdk.send }; },
}));

import { createRdsDataQualificationCareMessagingDatabase, createRdsDataQualificationProgramDatabase, type RdsDataConfiguration } from './rds-data-database';

const valid: RdsDataConfiguration = {
  region: 'us-east-2', databaseName: 'clinical_core_qualification',
  clusterArn: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional',
  secretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:alp-qualification-care-messaging-api-db-AbCd12',
} as RdsDataConfiguration;

beforeEach(() => { sdk.constructed.mockReset(); sdk.send.mockReset(); });

describe('createRdsDataQualificationCareMessagingDatabase, called directly', () => {
  it.each([
    ['the cluster-master secret', { secretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:rds!cluster-fictional-AbCd12' }],
    ['another service\'s secret', { secretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:alp-qualification-program-api-db-AbCd12' }],
    ['another database', { databaseName: 'clinical_core' }],
    ['another region', { region: 'us-east-1' }],
    ['another account\'s cluster', { clusterArn: 'arn:aws:rds:us-east-2:111111111111:cluster:fictional' }],
  ])('refuses %s before any client is constructed, and sends nothing', (_case, change) => {
    expect(() => createRdsDataQualificationCareMessagingDatabase({ ...valid, ...change } as RdsDataConfiguration)).toThrow('configuration_invalid');
    expect(sdk.constructed).not.toHaveBeenCalled();
    expect(sdk.send).not.toHaveBeenCalled();
  });

  it('an accepted configuration constructs one client for that configuration\'s region and still sends nothing until used', () => {
    createRdsDataQualificationCareMessagingDatabase(valid);
    expect(sdk.constructed).toHaveBeenCalledTimes(1);
    expect(sdk.constructed).toHaveBeenCalledWith({ region: 'us-east-2' });
    expect(sdk.send).not.toHaveBeenCalled();
  });

  it('a supplied client is used as given and no other is constructed', () => {
    const supplied = { send: vi.fn() };
    createRdsDataQualificationCareMessagingDatabase(valid, supplied as never);
    expect(sdk.constructed).not.toHaveBeenCalled();
    expect(() => createRdsDataQualificationCareMessagingDatabase({ ...valid, region: 'us-east-1' } as RdsDataConfiguration, supplied as never))
      .toThrow('configuration_invalid');
    expect(supplied.send).not.toHaveBeenCalled();
  });
});

describe('createRdsDataQualificationProgramDatabase, the sibling restricted factory, has the same ordering', () => {
  const program = { ...valid, secretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:alp-qualification-program-api-db-AbCd12' };
  it.each([
    ['the cluster-master secret', { secretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:rds!cluster-fictional-AbCd12' }],
    ['the care-messaging secret', { secretArn: valid.secretArn }],
    ['another database', { databaseName: 'clinical_core' }],
  ])('refuses %s before any client is constructed', (_case, change) => {
    expect(() => createRdsDataQualificationProgramDatabase({ ...program, ...change } as RdsDataConfiguration)).toThrow('configuration_invalid');
    expect(sdk.constructed).not.toHaveBeenCalled();
    expect(sdk.send).not.toHaveBeenCalled();
  });
  it('an accepted configuration constructs one client and sends nothing', () => {
    createRdsDataQualificationProgramDatabase(program as RdsDataConfiguration);
    expect(sdk.constructed).toHaveBeenCalledTimes(1);
    expect(sdk.send).not.toHaveBeenCalled();
  });
});
