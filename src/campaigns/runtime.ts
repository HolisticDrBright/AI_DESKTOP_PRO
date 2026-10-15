import type { EngineConfig } from './practice-context';

/**
 * The campaign Lambdas' settings, read once. CAMPAIGN_ENGINE_ENABLED is off unless it reads exactly `true`; off, every
 * route answers 503 and the sending job does nothing, and no AWS client is built.
 *
 * On, every other setting is required and checked: a half-configured engine refuses to start rather than send from
 * the wrong place. There are no defaults: the table, the key, the public origin, the two marketing configuration sets,
 * the sending local part and the account are each named explicitly in the template parameters.
 */
export type CampaignRuntime =
  | { enabled: false }
  | { enabled: true; engine: EngineConfig; tableName: string; keySecretArn: string; region: string; accountId: string; eventsTopicArn: string | null };
type Env = Readonly<Record<string, string | undefined>>;

export function campaignRuntime(env: Env): CampaignRuntime {
  if (env.CAMPAIGN_ENGINE_ENABLED?.trim() !== 'true') return { enabled: false };
  const get = (name: string, pattern: RegExp) => {
    const value = env[name]?.trim() ?? '';
    if (!pattern.test(value)) throw new Error(`campaign_configuration_incomplete:${name}`);
    return value;
  };
  const origin = get('CAMPAIGN_SITE_ORIGIN', /^https:\/\/[a-z0-9.-]+$/);
  const topic = env.CAMPAIGN_EVENTS_TOPIC_ARN?.trim() ? get('CAMPAIGN_EVENTS_TOPIC_ARN', /^arn:aws:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,256}$/) : null;
  return {
    enabled: true,
    engine: { enabled: true, siteOrigin: origin, configurationSet: get('CAMPAIGN_CONFIGURATION_SET', /^alp-marketing(?:-[a-z0-9-]{1,40})?$/),
      trackedConfigurationSet: get('CAMPAIGN_TRACKED_CONFIGURATION_SET', /^alp-marketing(?:-[a-z0-9-]{1,40})?$/), fromLocalPart: get('CAMPAIGN_FROM_LOCAL_PART', /^[a-z0-9](?:[a-z0-9._-]{0,30}[a-z0-9])?$/) },
    tableName: get('CAMPAIGN_TABLE_NAME', /^[A-Za-z0-9_.-]{3,255}$/), keySecretArn: get('CAMPAIGN_KEY_SECRET_ARN', /^arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/),
    region: get('AWS_REGION', /^[a-z]{2}-[a-z]+-\d$/), accountId: get('CAMPAIGN_ACCOUNT_ID', /^\d{12}$/), eventsTopicArn: topic,
  };
}
