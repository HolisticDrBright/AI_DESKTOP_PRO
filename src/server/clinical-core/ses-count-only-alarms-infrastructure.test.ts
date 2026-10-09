import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const template = JSON.parse(readFileSync('infra/aws-clinical-core/ses-count-only-alarms-candidate.json', 'utf8'));
const json = (value: unknown) => JSON.stringify(value);
function evaluate(value: unknown, parameters: Record<string, string>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => evaluate(item, parameters));
  const node = value as Record<string, unknown>;
  if (typeof node.Ref === 'string') return parameters[node.Ref] ?? '';
  if (node['Fn::Equals']) {
    const [left, right] = evaluate(node['Fn::Equals'], parameters) as unknown[];
    return left === right;
  }
  if (node['Fn::Not']) return !(evaluate(node['Fn::Not'], parameters) as boolean[])[0];
  if (node['Fn::And']) return (evaluate(node['Fn::And'], parameters) as boolean[]).every(Boolean);
  throw new Error('unsupported_condition');
}

describe('count-only production SES alarm candidate', () => {
  it('is disabled until alert review and responder confirmation are supplied', () => {
    expect(template.Parameters.SourceCommit.AllowedPattern).toBe('^[a-f0-9]{40}$');
    expect(template.Outputs.SourceCommit.Value).toEqual({ Ref: 'SourceCommit' });
    expect(template.Parameters.EnableAlarmActions.Default).toBe('false');
    expect(template.Parameters.AlertReviewSha256.Default).toBe('');
    expect(template.Parameters.ResponderConfirmationSha256.Default).toBe('');
    const condition = json(template.Conditions.ActionsReviewed);
    expect(condition).toContain('EnableAlarmActions');
    expect(condition).toContain('AlertReviewSha256');
    expect(condition).toContain('ResponderConfirmationSha256');
    const defaults = { EnableAlarmActions: 'false', AlertReviewSha256: '', ResponderConfirmationSha256: '' };
    const reviewed = { EnableAlarmActions: 'true', AlertReviewSha256: 'a'.repeat(64), ResponderConfirmationSha256: 'b'.repeat(64) };
    expect(evaluate(template.Conditions.ActionsReviewed, defaults)).toBe(false);
    expect(evaluate(template.Conditions.ActionsReviewed, reviewed)).toBe(true);
    for (const key of Object.keys(reviewed)) {
      expect(evaluate(template.Conditions.ActionsReviewed, { ...reviewed, [key]: defaults[key as keyof typeof defaults] })).toBe(false);
    }
    for (const name of ['BounceCountAlarm', 'ComplaintCountAlarm', 'RejectCountAlarm']) {
      expect(template.Resources[name].Properties.ActionsEnabled).toEqual({ 'Fn::If': ['ActionsReviewed', true, false] });
    }
    expect(json(template.Rules.AlarmActivationRequiresReview)).toContain('ResponderConfirmationSha256');
  });

  it('uses only count metrics and never subscribes a mailbox to raw SES events', () => {
    expect(template.Parameters.ConfigurationSetName.AllowedValues).toEqual(['alp-transactional']);
    expect(Object.values(template.Resources).map(resource => (resource as { Type: string }).Type)).not.toContain('AWS::SNS::Subscription');
    for (const [name, metric] of Object.entries({ BounceCountAlarm: 'Bounce', ComplaintCountAlarm: 'Complaint', RejectCountAlarm: 'Reject' })) {
      const properties = template.Resources[name].Properties;
      expect(properties.Namespace).toBe('AWS/SES');
      expect(properties.MetricName).toBe(metric);
      expect(properties.Dimensions).toEqual([{ Name: 'ses:configuration-set', Value: { Ref: 'ConfigurationSetName' } }]);
      expect(properties.TreatMissingData).toBe('notBreaching');
      expect(properties.AlarmActions).toEqual([{ Ref: 'CountOnlyAlarmTopic' }]);
    }
    expect(json(template)).not.toMatch(/alp-ses-deliverability-alerts|recipientAddress|emailAddress|sns:Subscribe/i);
  });

  it('permits CloudWatch publication only from the three named alarms in this account', () => {
    const policy = template.Resources.CountOnlyAlarmTopicPolicy.Properties.PolicyDocument.Statement;
    const publish = policy.find((statement: { Sid: string }) => statement.Sid === 'ExactCountAlarmsPublishOnly');
    expect(publish.Principal).toEqual({ Service: 'cloudwatch.amazonaws.com' });
    expect(publish.Action).toBe('sns:Publish');
    expect(publish.Condition.StringEquals['aws:SourceAccount']).toEqual({ Ref: 'AWS::AccountId' });
    const arns = publish.Condition.ArnEquals['aws:SourceArn'].map((value: { 'Fn::Sub': string }) => value['Fn::Sub']);
    expect(arns).toHaveLength(3);
    expect(arns).toEqual(expect.arrayContaining([
      expect.stringContaining('alp-ses-transactional-bounce-count'),
      expect.stringContaining('alp-ses-transactional-complaint-count'),
      expect.stringContaining('alp-ses-transactional-reject-count'),
    ]));
  });
});
