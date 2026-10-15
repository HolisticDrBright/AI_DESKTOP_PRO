import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The campaign engine's template (written and linted, not applied): everything off by default, its own store and
 * key, sending only from marketing identities through the marketing configuration sets, and no reach into anything
 * clinical.
 */
type Resource = { Type: string; Properties: Record<string, unknown>; DeletionPolicy?: string };
const template = JSON.parse(readFileSync('infra/campaigns/campaign-engine.json', 'utf8')) as { Parameters: Record<string, { Default?: string }>; Resources: Record<string, Resource> };
const of = (type: string) => Object.entries(template.Resources).filter(([, r]) => r.Type === type);

describe('the campaign engine template', () => {
  it('ships switched off: the engine flag is false, the schedule is DISABLED, and no practice setting has a default', () => {
    expect(template.Parameters.CampaignEngineEnabled!.Default).toBe('false');
    expect(template.Parameters.SendScheduleState!.Default).toBe('DISABLED');
    expect(template.Parameters.SiteOrigin!.Default).toBe('');
    expect(template.Parameters.FromLocalPart!.Default).toBe('');
    const [, schedule] = of('AWS::Scheduler::Schedule')[0]!;
    expect(schedule.Properties).toMatchObject({ ScheduleExpression: 'rate(5 minutes)', State: { Ref: 'SendScheduleState' } });
    for (const [, fn] of of('AWS::Lambda::Function')) expect((fn.Properties.Environment as { Variables: Record<string, unknown> }).Variables.CAMPAIGN_ENGINE_ENABLED).toEqual({ Ref: 'CampaignEngineEnabled' });
  });
  it('keeps the store on its own encrypted, point-in-time-recoverable table, retained on delete, with the due index and expiry', () => {
    const [, table] = of('AWS::DynamoDB::Table')[0]!;
    expect(table.DeletionPolicy).toBe('Retain');
    expect(table.Properties).toMatchObject({ TableName: 'alp-campaigns', DeletionProtectionEnabled: true, PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      SSESpecification: { SSEEnabled: true, SSEType: 'KMS' }, TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true } });
    expect(JSON.stringify(table.Properties.GlobalSecondaryIndexes)).toContain('"IndexName":"due"');
  });
  it('sends only from identities tagged as marketing, through the marketing sets, and denies the transactional set outright', () => {
    for (const [, role] of of('AWS::IAM::Role').filter(([name]) => name === 'CampaignApiRole' || name === 'CampaignSenderRole')) {
      const policy = JSON.stringify(role.Properties.Policies);
      expect(policy).toContain('"aws:ResourceTag/alp-purpose":"marketing"');
      expect(policy).toMatch(/"Sid":"NeverTransactional","Effect":"Deny","Action":"ses:\*","Resource":\{"Fn::Sub":"[^"]*configuration-set\/alp-transactional"\}/);
    }
    const sets = of('AWS::SES::ConfigurationSet').map(([, r]) => r.Properties);
    expect(sets.map(s => s.Name)).toEqual(['alp-marketing', 'alp-marketing-tracked']);
    for (const set of sets) expect(set.SuppressionOptions).toEqual({ SuppressedReasons: ['BOUNCE', 'COMPLAINT'] });
  });
  it('takes SES events by SNS straight into a function (no public endpoint), and only the staff route needs a token', () => {
    expect(of('AWS::SNS::Subscription')[0]![1].Properties).toMatchObject({ Protocol: 'lambda' });
    const routes = of('AWS::ApiGatewayV2::Route').map(([, r]) => r.Properties);
    expect(routes.filter(r => r.AuthorizationType === 'JWT').map(r => r.RouteKey)).toEqual(['POST /campaigns/workforce']);
    expect(routes.filter(r => r.AuthorizationType === 'NONE').map(r => r.RouteKey).sort()).toEqual([
      'GET /campaigns/public/join/{practice}/{program}', 'GET /campaigns/public/signup-open/{practice}/{program}',
      'POST /campaigns/public/confirm', 'POST /campaigns/public/join', 'POST /campaigns/public/unsubscribe']);
    expect(of('AWS::ApiGatewayV2::Stage')[0]![1].Properties).toMatchObject({ DefaultRouteSettings: { ThrottlingBurstLimit: 20, ThrottlingRateLimit: 10 } });
  });
  it('names nothing clinical: no clinical table, database, key, role, API or VPC', () => {
    // Descriptions may say what the template never touches; the resources themselves name none of it.
    const resources = JSON.stringify(template.Resources, (key, value) => (key === 'Description' ? undefined : value));
    expect(resources).not.toMatch(/clinical|Clinical|rds-data|RDS|Vpc|SecurityGroup/);
    // Every mention is a Deny: two on the API role (sending and domains), one on the sender role.
    expect(resources.match(/alp-transactional/g)?.length).toBe(3);
    expect(resources.match(/"Sid":"NeverTransactional","Effect":"Deny","Action":"ses:\*"/g)?.length).toBe(3);
  });
});
