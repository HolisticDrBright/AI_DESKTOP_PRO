import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  AdminCreateUserCommand, AdminGetUserCommand, AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient, InitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  CreateSecretCommand, GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

const region = process.env.AWS_REGION ?? "us-east-2";
const poolId = process.env.CONSUMER_USER_POOL_ID ?? "us-east-2_nYngyyYGE";
const clientId = process.env.CONSUMER_USER_POOL_CLIENT_ID ?? "72aksm2dm4nf03l8d9nrp2dbh0";
const organizationId = process.env.SYNTHETIC_ORGANIZATION_ID ?? "11111111-1111-4111-8111-111111111111";
const credentialsSecretId = process.env.PERSONA_CREDENTIALS_SECRET_ID ?? "ai-longevity-pro/synthetic-staging/testflight-personas";
const clinicalKeyArn = process.env.CLINICAL_CORE_KEY_ARN ?? "arn:aws:kms:us-east-2:588966314750:key/c13ec29d-0e47-4c02-9136-f371bcbb7900";
const apiOrigin = process.env.CLINICAL_API_ORIGIN ?? "https://wxv734oi12.execute-api.us-east-2.amazonaws.com";
const promptFile = process.env.ASK_ALP_PROMPT_FILE
  ?? "../AI_LONGEVITY_PRO_V2_PATIENT_CHAT/expo/supabase/migrations/20260901194432_ask_alp_sign_activate.sql";
const personas = [
  ["regular_cycle", "persona.regular-cycle@brightlongevity.test"],
  ["hormonal_contraception", "persona.hbc@brightlongevity.test"],
  ["irregular_cycle", "persona.irregular-cycle@brightlongevity.test"],
  ["perimenopause", "persona.perimenopause@brightlongevity.test"],
  ["menopause", "persona.menopause@brightlongevity.test"],
];
const cognito = new CognitoIdentityProviderClient({ region });
const secrets = new SecretsManagerClient({ region });

function password() { return `Aa1!${randomBytes(9).toString("base64url")}`; }

async function stored() {
  try {
    const value = await secrets.send(new GetSecretValueCommand({ SecretId: credentialsSecretId }));
    return JSON.parse(value.SecretString ?? "[]");
  } catch (error) {
    if (error?.name !== "ResourceNotFoundException") throw error;
    return [];
  }
}

const existing = await stored();
const records = personas.map(([mode, email]) => existing.find((row) => row.mode === mode) ?? ({ mode, email, password: password(), personId: randomUUID() }));
for (const record of records) {
  try {
    await cognito.send(new AdminGetUserCommand({ UserPoolId: poolId, Username: record.email }));
  } catch (error) {
    if (error?.name !== "UserNotFoundException") throw error;
    await cognito.send(new AdminCreateUserCommand({
      UserPoolId: poolId, Username: record.email, MessageAction: "SUPPRESS",
      UserAttributes: [
        { Name: "email", Value: record.email }, { Name: "email_verified", Value: "true" },
        { Name: "custom:person_id", Value: record.personId }, { Name: "custom:organization_id", Value: organizationId },
        { Name: "custom:synthetic_attested", Value: "true" },
      ],
    }));
  }
  await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: poolId, Username: record.email, Password: record.password, Permanent: true }));
}
const secretString = JSON.stringify(records);
try {
  await secrets.send(new CreateSecretCommand({ Name: credentialsSecretId, KmsKeyId: clinicalKeyArn, SecretString: secretString,
    Description: "Synthetic-only TestFlight Ask ALP persona credentials. Never use for real patient data." }));
} catch (error) {
  if (error?.name !== "ResourceExistsException") throw error;
  await secrets.send(new PutSecretValueCommand({ SecretId: credentialsSecretId, SecretString: secretString }));
}

let hostedVerification = null;
let telehealthVerification = null;
let catalogVerification = null;
let v2BridgeVerification = null;
if (process.argv.includes("--verify-ask-alp") || process.argv.includes("--verify-telehealth")
  || process.argv.includes("--verify-catalog") || process.argv.includes("--verify-v2-bridge")) {
  const auth = await cognito.send(new InitiateAuthCommand({ ClientId: clientId, AuthFlow: "USER_PASSWORD_AUTH",
    AuthParameters: { USERNAME: records[0].email, PASSWORD: records[0].password } }));
  const token = auth.AuthenticationResult?.IdToken;
  if (!token) throw new Error("synthetic_persona_auth_failed");
  if (process.argv.includes("--verify-ask-alp")) {
  const migration = readFileSync(promptFile, "utf8");
  const start = migration.indexOf("$prompt$") + 8;
  const end = migration.indexOf("$prompt$", start);
  if (start < 8 || end < start) throw new Error("ask_alp_prompt_not_found");
  const response = await fetch(`${apiOrigin}/clinical-core/consumer/ask-alp/generate`, {
    method: "POST", redirect: "manual", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      contractVersion: "patient-chat-generation/1", requestId: randomUUID(), systemPromptVersion: "ask-alp/2",
      signedSystemPrompt: migration.slice(start, end), contextVersion: "patient-chat-context/1",
      context: { profile: { goals: ["synthetic energy"] }, cycle: { mode: "regular_cycle", day: 21, phase: "luteal", confidence: "estimated" }, labs: [], wearables: null, governedOptions: [] },
      userMessage: "Explain what information is present and what is missing without inventing anything.",
    }),
  });
  const body = await response.json();
  if (!response.ok || body?.data?.provider !== "openai" || typeof body?.data?.answer !== "string") throw new Error(`ask_alp_hosted_verification_failed:${response.status}`);
  hostedVerification = { status: response.status, provider: body.data.provider, model: body.data.model, answerLength: body.data.answer.length };
  }
  if (process.argv.includes("--verify-telehealth")) {
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const createdResponse = await fetch(`${apiOrigin}/clinical-core/consumer/appointments/requests`, { method: "POST", headers, body: JSON.stringify({ visitType: "follow_up", preferredSlots: [new Date(Date.now() + 86400000).toISOString()], timeZone: "America/Los_Angeles", note: "Synthetic persona verification only" }) });
    const createdBody = await createdResponse.json();
    const created = createdBody?.data;
    if (!createdResponse.ok || created?.status !== "requested") throw new Error(`telehealth_create_failed:${createdResponse.status}:${createdBody?.error ?? "invalid_response"}`);
    const listedResponse = await fetch(`${apiOrigin}/clinical-core/consumer/appointments/requests`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
    const listed = (await listedResponse.json())?.data;
    if (!listedResponse.ok || !Array.isArray(listed) || !listed.some((row) => row.requestId === created.requestId)) throw new Error("telehealth_list_failed");
    const cancelledResponse = await fetch(`${apiOrigin}/clinical-core/consumer/appointments/actions`, { method: "POST", headers, body: JSON.stringify({ requestId: created.requestId, action: "cancel", expectedVersion: created.version }) });
    const cancelled = (await cancelledResponse.json())?.data;
    if (!cancelledResponse.ok || cancelled?.status !== "cancelled") throw new Error("telehealth_cancel_failed");
    telehealthVerification = { createStatus: createdResponse.status, listStatus: listedResponse.status, cancelStatus: cancelledResponse.status, finalState: cancelled.status, zoomLinkCreated: Boolean(cancelled.joinUrl) };
  }
  if (process.argv.includes("--verify-catalog")) {
    const response = await fetch(`${apiOrigin}/clinical-core/consumer/catalog/products?limit=10`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    const body = await response.json();
    catalogVerification = {
      status: response.status,
      contractVersion: body?.contractVersion ?? null,
      environment: body?.environment ?? null,
      products: Array.isArray(body?.data?.products) ? body.data.products.length : null,
      error: typeof body?.error === "string" ? body.error : null,
    };
  }
  if (process.argv.includes("--verify-v2-bridge")) {
    const v2Origin = process.env.V2_API_ORIGIN ?? "https://expo-sunlit-resonance-4543.fly.dev";
    const input = encodeURIComponent(JSON.stringify({ json: null }));
    const response = await fetch(`${v2Origin}/api/trpc/chat.getAvailability?input=${input}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    const body = await response.json();
    v2BridgeVerification = {
      status: response.status,
      enabled: body?.result?.data?.json?.enabled ?? null,
      reason: body?.result?.data?.json?.reason ?? null,
      errorCode: body?.error?.data?.json?.code ?? null,
      errorMessage: body?.error?.json?.message ?? null,
    };
  }
}

console.log(JSON.stringify({
  personaCount: records.length, modes: records.map((row) => row.mode),
  credentialsSecretId, passwordsPrinted: false, hostedVerification, telehealthVerification,
  catalogVerification, v2BridgeVerification,
}, null, 2));
