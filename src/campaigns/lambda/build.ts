import { createHash } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createDynamoCampaignStore } from '../dynamo-store';
import type { EngineDeps } from '../practice-context';
import type { CampaignRuntime } from '../runtime';
import { createAwsCampaignSes } from '../ses';
import { deriveCampaignKeys } from '../tokens';

/**
 * The engine's AWS parts, built once per cold start and only when the engine is on. The master key is derived from a
 * Secrets Manager value that Secrets Manager itself generated (64 random characters, see the template): SHA-256 of it
 * is the 32-byte master. It never appears in an environment variable or a log.
 */
export async function buildEngineDeps(runtime: Extract<CampaignRuntime, { enabled: true }>): Promise<EngineDeps> {
  const secret = await new SecretsManagerClient({ region: runtime.region }).send(new GetSecretValueCommand({ SecretId: runtime.keySecretArn }));
  if (!secret.SecretString || secret.SecretString.length < 48) throw new Error('campaign_key_secret_invalid');
  const master = createHash('sha256').update(secret.SecretString, 'utf8').digest();
  return {
    store: createDynamoCampaignStore({ client: DynamoDBDocumentClient.from(new DynamoDBClient({ region: runtime.region }), { marshallOptions: { removeUndefinedValues: true } }), tableName: runtime.tableName }),
    ses: createAwsCampaignSes({ client: new SESv2Client({ region: runtime.region }), region: runtime.region, accountId: runtime.accountId }),
    keys: deriveCampaignKeys(master), config: runtime.engine,
  };
}
