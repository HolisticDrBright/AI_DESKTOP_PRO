import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { LEAD_PROGRAMS, type LeadProgram } from '@/contracts/leadCampaigns';
import { createBounceHandler, createDittofeedSesRelay } from './bounces';
import { createDittofeedDirectory } from './dittofeed';

/**
 * The SES events function's entry: subscribed to the marketing configuration set's SNS topic with the
 * Lambda protocol, inside the campaign network.
 *
 * Its configuration comes from its own environment, and its two secrets (the lead id key and Dittofeed's
 * API keys) are read from Secrets Manager at start, never placed in the environment where the function's
 * configuration would show them. It refuses to build with anything missing.
 *
 * Nothing in the Desktop imports this file.
 */
type Env = Record<string, string | undefined>;
export type SecretReader = (arn: string) => Promise<string>;
const ARN = /^arn:aws:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$/;

export async function sesEventsHandlerFrom(env: Env, readSecret: SecretReader) {
  const groups = Object.fromEntries(LEAD_PROGRAMS.map(p => [p, env[`DITTOFEED_GROUP_${p.replaceAll('-', '_').toUpperCase()}`] ?? ''])) as Record<LeadProgram, string>;
  const baseUrl = env.DITTOFEED_INTERNAL_URL ?? '';
  if (!ARN.test(env.LEAD_SIGNUP_ID_KEY_SECRET_ARN ?? '') || !ARN.test(env.DITTOFEED_API_KEYS_SECRET_ARN ?? '')
    || !Object.values(groups).every(g => /^[0-9a-f-]{36}$/.test(g)) || !/^[0-9a-f-]{36}$/.test(env.DITTOFEED_WORKSPACE_ID ?? '')) throw new Error('ses_events_configuration_invalid');
  const idKey = Buffer.from(await readSecret(env.LEAD_SIGNUP_ID_KEY_SECRET_ARN!), 'base64');
  let keys: { writeKey?: unknown; adminKey?: unknown };
  try { keys = JSON.parse(await readSecret(env.DITTOFEED_API_KEYS_SECRET_ARN!)); } catch { throw new Error('ses_events_configuration_invalid'); }
  if (idKey.length < 32 || typeof keys.writeKey !== 'string' || keys.writeKey.length < 16 || typeof keys.adminKey !== 'string' || keys.adminKey.length < 16) {
    throw new Error('ses_events_configuration_invalid');
  }
  const directory = createDittofeedDirectory({ baseUrl, workspaceId: env.DITTOFEED_WORKSPACE_ID!, writeKey: keys.writeKey, adminKey: keys.adminKey, groups });
  return createBounceHandler({ topicArn: env.LEAD_SES_EVENTS_TOPIC_ARN ?? '', idKey, directory, relay: createDittofeedSesRelay(baseUrl) });
}

const secrets = new SecretsManagerClient({});
const readFromSecretsManager: SecretReader = async arn => {
  const value = (await secrets.send(new GetSecretValueCommand({ SecretId: arn }))).SecretString;
  if (!value) throw new Error('ses_events_configuration_invalid');
  return value;
};
let built: ReturnType<typeof sesEventsHandlerFrom> | null = null;
export const handler = async (event: Parameters<Awaited<ReturnType<typeof sesEventsHandlerFrom>>>[0]) => {
  // A failed start is retried on the next invocation rather than kept.
  built ??= sesEventsHandlerFrom(process.env, readFromSecretsManager).catch(error => { built = null; throw error; });
  return (await built)(event);
};
