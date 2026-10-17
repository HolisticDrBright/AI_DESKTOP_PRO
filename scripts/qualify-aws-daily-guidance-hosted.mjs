/**
 * Hosted SMOKE test of the daily-guidance route; not acceptance evidence. It checks no deployed source, stack or
 * `x-clinical-execution` marker; it creates and deletes a temporary fictional Cognito user; and its model-path check
 * reads `provenance.provider` from the answer body, the API's own claim rather than an observed provider call.
 * Acceptance is the separate path scripts/hosted-program-acceptance.mjs.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminInitiateAuthCommand,
  AdminDeleteUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";

// This deliberately targets only the fictional synthetic staging boundary.
const ACCOUNT = "588966314750";
const REGION = "us-east-2";
const USER_POOL = "us-east-2_nYngyyYGE";
const CLIENT_ID = "72aksm2dm4nf03l8d9nrp2dbh0";
const URL = "https://wxv734oi12.execute-api.us-east-2.amazonaws.com/clinical-core/consumer/daily-guidance";

if (process.argv.length !== 3 || process.argv[2] !== "--confirm-synthetic-only"
  || process.env.AWS_PROFILE !== "ai-synthetic-member") {
  throw new Error("synthetic_qualification_confirmation_required");
}

const sts = new STSClient({ region: REGION });
const identity = await sts.send(new GetCallerIdentityCommand({}));
if (identity.Account !== ACCOUNT) throw new Error("synthetic_account_mismatch");

const cognito = new CognitoIdentityProviderClient({ region: REGION });
const username = `daily-guidance-${randomUUID()}@example.invalid`;
const password = `Syn!${randomBytes(36).toString("base64url")}7a`;
let created = false;

function claimsFromIdToken(token) {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("fictional_token_missing");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

async function call(token, payload) {
  const response = await fetch(URL, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
    redirect: "error",
    signal: AbortSignal.timeout(45_000),
  });
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > 524_288) throw new Error("response_too_large");
  if (!response.body) throw new Error("response_missing");
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      received += next.value.byteLength;
      if (received > 524_288) throw new Error("response_too_large");
      chunks.push(Buffer.from(next.value));
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  return { status: response.status, error: parsed.error ?? null,
    contractVersion: parsed.data?.contractVersion ?? null,
    provider: parsed.data?.provenance?.provider ?? null };
}

try {
  await cognito.send(new AdminCreateUserCommand({
    UserPoolId: USER_POOL, Username: username, MessageAction: "SUPPRESS",
    UserAttributes: [
      { Name: "custom:synthetic_attested", Value: "true" },
      { Name: "custom:organization_id", Value: randomUUID() },
      { Name: "custom:person_id", Value: randomUUID() },
    ],
  }));
  created = true;
  await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: USER_POOL, Username: username, Password: password, Permanent: true }));
  const auth = await cognito.send(new AdminInitiateAuthCommand({
    UserPoolId: USER_POOL, ClientId: CLIENT_ID, AuthFlow: "ADMIN_USER_PASSWORD_AUTH",
    AuthParameters: { USERNAME: username, PASSWORD: password },
  }));
  const token = auth.AuthenticationResult?.IdToken;
  if (!token) throw new Error("fictional_token_missing");
  const claims = claimsFromIdToken(token);
  if (claims.iss !== `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL}`
    || claims.aud !== CLIENT_ID || claims.token_use !== "id"
    || claims["custom:synthetic_attested"] !== "true"
    || claims["custom:production_bound"] === "true") throw new Error("fictional_token_claims_mismatch");

  const now = new Date().toISOString();
  const base = {
    contractVersion: "daily-guidance/1", requestId: randomUUID(), date: now.slice(0, 10),
    measurements: [], baselines: [], symptoms: [], reproductiveContext: null,
  };
  const urgent = await call(token, { ...base, symptoms: ["chest_pain"] });
  if (urgent.status !== 422 || urgent.error !== "urgent_symptom_requires_care") throw new Error(`urgent_path_failed_${urgent.status}_${urgent.error}`);
  console.log("PASS fictional urgent symptom: deterministic refusal before model");

  const insufficient = await call(token, { ...base, requestId: randomUUID(), measurements: [
    { metric: "hrv_ms", value: 52, unit: "ms", observedAt: now, source: "apple_health", quality: "measured" },
    { metric: "energy_score", value: 5, unit: "score_0_10", observedAt: now, source: "manual_checkin", quality: "user_reported" },
  ] });
  if (insufficient.status !== 422 || insufficient.error !== "insufficient_measured_data") throw new Error(`measured_gate_failed_${insufficient.status}_${insufficient.error}`);
  console.log("PASS fictional insufficient measurements: no hidden default");

  const generated = await call(token, { ...base, requestId: randomUUID(), measurements: [
    { metric: "hrv_ms", value: 52, unit: "ms", observedAt: now, source: "apple_health", quality: "measured" },
    { metric: "resting_heart_rate_bpm", value: 61, unit: "bpm", observedAt: now, source: "apple_health", quality: "measured" },
    { metric: "sleep_duration_minutes", value: 438, unit: "min", observedAt: now, source: "apple_health", quality: "measured" },
  ] });
  console.log(JSON.stringify({ test: "fictional_measured_openai", ...generated }));
  if (generated.status !== 200 || generated.contractVersion !== "daily-guidance/1" || generated.provider !== "openai") {
    throw new Error("fictional_model_path_unverified");
  }
} finally {
  if (created) {
    await cognito.send(new AdminDeleteUserCommand({ UserPoolId: USER_POOL, Username: username }));
    console.log("Temporary fictional account removed");
  }
}
