import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CAMPAIGN_SEND_SETTINGS } from '@/contracts/leadCampaigns';

/**
 * The campaign service's AWS template (infra/lead-campaigns/campaigns-stack.json), as written and NOT
 * applied. It is checked here for what matters most, beside cfn-lint in CI:
 *
 * - **Its own network.** Nothing in it can route to, peer with or name the clinical plane.
 * - **Pinned software.** Dittofeed is pinned to v0.23.0, and the other images to a version or digest.
 * - **No defaults for Brandon's decisions.** The sending settings start empty, so the service refuses to send.
 * - **Only what must be public is public.** The SES webhook and the dashboard are not on the internet.
 * - **The data is backed up.**
 * - **Nothing runs until someone raises the task count.**
 */
type Resource = { Type: string; Properties: Record<string, unknown>; Condition?: string; DeletionPolicy?: string; UpdateReplacePolicy?: string };
const template = JSON.parse(readFileSync('infra/lead-campaigns/campaigns-stack.json', 'utf8')) as {
  Description: string; Metadata: { alp: { status: string; dittofeedRelease: string; publicPaths: string[] } };
  Parameters: Record<string, { Default?: unknown; AllowedValues?: unknown[]; AllowedPattern?: string }>; Resources: Record<string, Resource>;
};
const resources = Object.entries(template.Resources);
const ofType = (type: string) => resources.filter(([, r]) => r.Type === type);
/** Every value in the template except the human-readable descriptions. */
function values(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) node.forEach(n => values(n, out));
  else if (node && typeof node === 'object') for (const [key, value] of Object.entries(node)) if (key !== 'Description') { out.push(key); values(value, out); }
  return out;
}

describe('the campaign service template', () => {
  it('is marked as not applied, and its services start with no running task', () => {
    expect(template.Metadata.alp.status).toBe('not-applied');
    expect(template.Description).toContain('NOT applied');
    expect(template.Parameters.DesiredTaskCount).toMatchObject({ Default: 0, AllowedValues: [0, 1] });
    for (const [name, service] of ofType('AWS::ECS::Service')) expect(service.Properties.DesiredCount, name).toEqual({ Ref: 'DesiredTaskCount' });
  });
  it('lives in a network of its own: no peering, transit, VPN, endpoint or route to anything but the internet', () => {
    for (const type of ['AWS::EC2::VPCPeeringConnection', 'AWS::EC2::TransitGatewayAttachment', 'AWS::EC2::TransitGatewayVpcAttachment', 'AWS::EC2::VPNConnection',
      'AWS::EC2::VPCEndpoint', 'AWS::EC2::VPCEndpointService', 'AWS::EC2::ClientVpnEndpoint', 'AWS::RAM::ResourceShare']) {
      expect(ofType(type), type).toEqual([]);
    }
    expect(ofType('AWS::EC2::VPC')).toHaveLength(1);
    for (const [name, route] of ofType('AWS::EC2::Route')) {
      expect(route.Properties.DestinationCidrBlock, name).toBe('0.0.0.0/0');
      expect(Object.keys(route.Properties).filter(k => /GatewayId|NatGatewayId/.test(k)), name).toHaveLength(1);
    }
  });
  it('names nothing clinical: no clinical endpoint, credential, table, role or the clinical SES configuration set', () => {
    const text = values(template).join('\n');
    expect(text).not.toMatch(/clinical|alp-transactional|telehealth|patient|identity-api|cognito|consult|chart|dynamodb|ClinicalCore/i);
    expect(text).not.toMatch(/arn:aws:[a-z0-9-]+:[a-z0-9-]*:[0-9]{12}:/);
  });
  it('pins Dittofeed to v0.23.0 and every image to a version or a digest, and the sign-up service to a digest', () => {
    expect(template.Metadata.alp.dittofeedRelease).toBe('v0.23.0');
    expect(template.Parameters.DittofeedLiteImage!.Default).toBe('dittofeed/dittofeed-lite:v0.23.0');
    for (const name of ['DittofeedLiteImage', 'TemporalImage', 'ClickHouseImage', 'LeadSignupImage']) {
      const pattern = new RegExp(template.Parameters[name]!.AllowedPattern!);
      expect(pattern.test('dittofeed/dittofeed-lite:latest'), name).toBe(false);
      expect(pattern.test('dittofeed/dittofeed-lite'), name).toBe(false);
      expect(pattern.test(`111122223333.dkr.ecr.us-east-2.amazonaws.com/mirror@sha256:${'a'.repeat(64)}`), name).toBe(true);
    }
    expect(new RegExp(template.Parameters.LeadSignupImage!.AllowedPattern!).test('111122223333.dkr.ecr.us-east-2.amazonaws.com/lead-signup:v1')).toBe(false);
  });
  it('gives none of Brandon\'s sending decisions a value: each starts empty, so the service refuses to send', () => {
    for (const name of ['SendingSubdomain', 'CampaignTracking', 'CampaignFromName', 'CampaignMailingAddress', 'CampaignApprovedTextVersion']) {
      expect(template.Parameters[name]!.Default, name).toBe('');
    }
    expect(template.Parameters.CampaignTracking!.AllowedValues).toEqual(['', 'on', 'off']);
    const signup = template.Resources.SignupTask!.Properties.ContainerDefinitions as Array<{ Environment: Array<{ Name: string; Value: unknown }> }>;
    const environment = Object.fromEntries(signup[0]!.Environment.map(e => [e.Name, e.Value]));
    for (const name of CAMPAIGN_SEND_SETTINGS) expect(environment[name], name).toBeDefined();
    expect(environment.CAMPAIGN_SENDING_SUBDOMAIN).toEqual({ Ref: 'SendingSubdomain' });
    expect(environment.CAMPAIGN_TRACKING).toEqual({ Ref: 'CampaignTracking' });
    // No sending identity exists until the subdomain is chosen.
    expect(template.Resources.MarketingIdentity!.Condition).toBe('HasSendingSubdomain');
    expect(template.Resources.DittofeedSesSender!.Condition).toBe('HasSendingSubdomain');
  });
  it('sends marketing mail through its own configuration set with bounce and complaint suppression, opens and clicks only when tracking is on', () => {
    const set = template.Resources.MarketingConfigurationSet!.Properties;
    expect(JSON.stringify(set.Name)).not.toContain('alp-transactional');
    expect(set.SuppressionOptions).toEqual({ SuppressedReasons: ['BOUNCE', 'COMPLAINT'] });
    const destination = (template.Resources.MarketingEventsDestination!.Properties.EventDestination as { MatchingEventTypes: { 'Fn::If': [string, string[], string[]] } }).MatchingEventTypes['Fn::If'];
    expect(destination[0]).toBe('TrackingOn');
    expect(destination[1]).toEqual(expect.arrayContaining(['open', 'click', 'bounce', 'complaint', 'delivery']));
    expect(destination[2]).not.toContain('open');
    expect(destination[2]).not.toContain('click');
  });
  it('lets each sender send only from the marketing subdomain, through the marketing configuration set', () => {
    for (const name of ['DittofeedSesSender', 'SignupTaskRole']) {
      const statements = (template.Resources[name]!.Properties.Policies as Array<{ PolicyDocument: { Statement: Array<{ Action: string[]; Resource: unknown[]; Condition: unknown }> } }>)
        .flatMap(p => p.PolicyDocument.Statement);
      expect(statements, name).toHaveLength(1);
      expect(statements[0]!.Action, name).toEqual(['ses:SendEmail', 'ses:SendRawEmail']);
      expect(JSON.stringify(statements[0]!.Resource), name).toMatch(/identity\/\$\{SendingSubdomain\}.*configuration-set\/\$\{MarketingConfigurationSet\}/);
      expect(JSON.stringify(statements[0]!.Condition), name).toContain('ses:FromAddress');
    }
    // No IAM action anywhere is a wildcard, and no access key is created by the template.
    expect(values(template).filter(v => /^[a-z0-9]+:\*$|^\*$/.test(v))).toEqual([]);
    expect(ofType('AWS::IAM::AccessKey')).toEqual([]);
  });
  it('publishes only the sign-up, confirmation and unsubscribe pages, with the counts reachable only from a named reader range', () => {
    const rules = ofType('AWS::ElasticLoadBalancingV2::ListenerRule').map(([name, rule]) => ({ name, condition: rule.Condition,
      paths: ((rule.Properties.Conditions as Array<{ Field: string; PathPatternConfig?: { Values: string[] } }>).find(c => c.Field === 'path-pattern')!.PathPatternConfig!.Values) }));
    const always = rules.filter(r => !r.condition).flatMap(r => r.paths).sort();
    expect(always).toEqual([...template.Metadata.alp.publicPaths].sort());
    for (const path of always) expect(path, path).not.toMatch(/webhooks|single-tenant|\/apps\/|admin|^\/dashboard\/?$|^\/dashboard\/\*|internal/);
    const counts = rules.filter(r => r.condition);
    expect(counts).toEqual([{ name: 'CountsRule', condition: 'HasCountsReader', paths: ['/internal/counts'] }]);
    expect(template.Parameters.CountsReaderCidr!.Default).toBe('');
    const listener = template.Resources.HttpsListener!.Properties;
    expect(listener.Protocol).toBe('HTTPS');
    expect(JSON.stringify(listener.DefaultActions)).toContain('"StatusCode":"404"');
    expect(ofType('AWS::ElasticLoadBalancingV2::Listener')).toHaveLength(1);
  });
  it('never puts Dittofeed\'s SES webhook on the internet: SES events reach the function by the Lambda protocol only', () => {
    const subscriptions = ofType('AWS::SNS::Subscription');
    expect(subscriptions.map(([, s]) => s.Properties.Protocol)).toEqual(['lambda']);
    expect(JSON.stringify(template.Resources.SesEventsFunction!.Properties)).toContain('http://dittofeed.campaigns.internal:3000');
    expect(values(template).some(v => v.includes('webhooks/amazon-ses'))).toBe(false);
  });
  it('keeps the function\'s secrets out of its configuration: it is given secret names and reads them itself', () => {
    const variables = (template.Resources.SesEventsFunction!.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(JSON.stringify(variables)).not.toMatch(/resolve:secretsmanager|WRITE_KEY|ADMIN_KEY|"LEAD_SIGNUP_ID_KEY"/);
    expect(Object.keys(variables)).toEqual(expect.arrayContaining(['LEAD_SIGNUP_ID_KEY_SECRET_ARN', 'DITTOFEED_API_KEYS_SECRET_ARN']));
  });
  it('accepts no inbound traffic from the internet except HTTPS to the load balancer', () => {
    for (const [name, group] of ofType('AWS::EC2::SecurityGroup')) {
      for (const rule of group.Properties.SecurityGroupIngress as Array<{ CidrIp?: string; FromPort: number }>) {
        if (rule.CidrIp) expect([name, rule.FromPort], name).toEqual(['LoadBalancerSecurityGroup', 443]);
      }
    }
  });
  it('encrypts, protects and backs up its data: Postgres and the ClickHouse volume daily, for the retention chosen', () => {
    const database = template.Resources.Database!;
    expect(database.Properties).toMatchObject({ StorageEncrypted: true, PubliclyAccessible: false, DeletionProtection: true, BackupRetentionPeriod: { Ref: 'BackupRetentionDays' } });
    expect([database.DeletionPolicy, database.UpdateReplacePolicy]).toEqual(['Snapshot', 'Snapshot']);
    const volume = template.Resources.ClickHouseStorage!;
    expect(volume.Properties).toMatchObject({ Encrypted: true, BackupPolicy: { Status: 'ENABLED' } });
    expect(volume.DeletionPolicy).toBe('Retain');
    const plan = template.Resources.BackupPlan!.Properties.BackupPlan as { BackupPlanRule: Array<{ ScheduleExpression: string; Lifecycle: unknown }> };
    expect(plan.BackupPlanRule[0]).toMatchObject({ ScheduleExpression: 'cron(0 7 * * ? *)', Lifecycle: { DeleteAfterDays: { Ref: 'BackupRetentionDays' } } });
    const selected = JSON.stringify(template.Resources.BackupSelection!.Properties);
    expect(selected).toContain('${Database}');
    expect(selected).toContain('ClickHouseStorage');
    for (const [name, secret] of ofType('AWS::SecretsManager::Secret')) expect(secret.DeletionPolicy, name).toBe('Retain');
  });
  it('runs the open-source dashboard in its one safe sign-in mode, with a generated password', () => {
    const dittofeed = (template.Resources.DittofeedTask!.Properties.ContainerDefinitions as Array<{ Environment: Array<{ Name: string; Value: unknown }>; Secrets: Array<{ Name: string }> }>)[0]!;
    expect(dittofeed.Environment.find(e => e.Name === 'AUTH_MODE')!.Value).toBe('single-tenant');
    expect(dittofeed.Secrets.map(s => s.Name)).toEqual(expect.arrayContaining(['PASSWORD', 'SECRET_KEY']));
  });
});
