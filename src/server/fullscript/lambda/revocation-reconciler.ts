import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { readFullscriptRevocationConfiguration, revokeFullscriptToken } from "../client";
import { createAwsFullscriptRevocationOutbox } from "../membership-generation";
import { FULLSCRIPT_REVOCATION_RECONCILER_RELEASE, runFullscriptRevocationReconciler, type FullscriptReconcilerSummary } from "../revocation-reconciler";

/**
 * The scheduled revocation reconciler Lambda (BLOCKED). Both locks must open before anything is built: the source
 * release constant, and FULLSCRIPT_REVOCATION_RECONCILER_RELEASE in its environment. Closed, it reads nothing, holds
 * no client and answers `{ released: false }`.
 *
 * Open, it reads this OAuth client from Secrets Manager (the two secrets its role may read), runs one bounded pass,
 * and logs the summary: counts and fingerprints, never a token. A pass with a stuck item fails after logging, so the
 * function's error alarm is the failure report.
 */
type Env = NodeJS.ProcessEnv;
let ready: Promise<() => Promise<FullscriptReconcilerSummary | { released: false }>> | null = null;

export async function build(env: Env = process.env, secrets: Pick<SecretsManagerClient, "send"> = new SecretsManagerClient({ region: env.AWS_REGION }),
  send?: Parameters<typeof createAwsFullscriptRevocationOutbox>[1]) {
  const read = async (arn: string | undefined) => {
    if (!arn || !/^arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/.test(arn)) throw new Error("fullscript_reconciler_configuration_incomplete");
    const value = (await secrets.send(new GetSecretValueCommand({ SecretId: arn }))).SecretString?.trim();
    if (!value) throw new Error("fullscript_reconciler_configuration_incomplete");
    return value;
  };
  const configuration = readFullscriptRevocationConfiguration({ ...env,
    FULLSCRIPT_CLIENT_ID: await read(env.FULLSCRIPT_CLIENT_ID_SECRET_ARN), FULLSCRIPT_CLIENT_SECRET: await read(env.FULLSCRIPT_CLIENT_SECRET_SECRET_ARN) });
  const outbox = createAwsFullscriptRevocationOutbox(env, send, { reconciler: true });
  if (!outbox) throw new Error("fullscript_reconciler_configuration_incomplete");
  // The source release governs here too: building the worker never opens it.
  return () => runFullscriptRevocationReconciler({ outbox, environment: configuration.environment,
    revoke: (accessToken) => revokeFullscriptToken({ configuration, token: accessToken }) });
}

export async function handler(): Promise<FullscriptReconcilerSummary | { released: false }> {
  if (FULLSCRIPT_REVOCATION_RECONCILER_RELEASE !== "qualification" || process.env.FULLSCRIPT_REVOCATION_RECONCILER_RELEASE !== "qualification") {
    return { released: false };
  }
  ready ??= build();
  const summary = await (await ready)();
  console.log(JSON.stringify({ event: "fullscript.revocation.reconcile", ...summary }));
  if (summary.released && summary.stuck > 0) throw new Error(`fullscript_revocations_stuck:${summary.stuck}`);
  return summary;
}
