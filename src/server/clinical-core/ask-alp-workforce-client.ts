if (typeof window !== "undefined") throw new Error("ask-alp-workforce-client is server-only");

import { AdapterError, codeFromHttpStatus } from "@/adapters/errors";

const API_HOST = /^[a-z0-9]{10}\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/;
const MAX_RESPONSE_BYTES = 128 * 1024;
const VERSION = /^[a-z0-9][a-z0-9./_-]{2,80}$/i;
const RULE_CODE = /^[a-z][a-z0-9_]{2,80}$/;

export interface AskAlpPromptCandidate {
  version: string;
  content: string;
  refusal_text: string;
  disclosure_text: string;
  consent_text: string;
  care_team_fallback: string;
  active: boolean;
  signed_by: string | null;
  signed_date: string | null;
  content_sha256: string | null;
  configuration_sha256: string | null;
}

export interface AskAlpRedFlagCandidate {
  code: string;
  matcher_type: string;
  pattern: string;
  fixed_response: string;
  severity: string;
  configuration_version: string;
  active: boolean;
  signed_by: string | null;
  signed_date: string | null;
}

export interface AskAlpConfigurationStatus {
  active: AskAlpPromptCandidate | null;
  candidate: {
    prompt: AskAlpPromptCandidate;
    redflagRules: AskAlpRedFlagCandidate[];
    confirmation: string;
  } | null;
}

export interface AskAlpActivationReceipt {
  version: string;
  signedBy: string;
  signedAt: string;
  contentSha256: string;
  configurationSha256: string;
  redflagRuleCount: number;
  active: true;
}

function origin(): string {
  if (process.env.CLINICAL_AWS_RUNTIME_MODE !== "synthetic") throw new AdapterError("unavailable");
  let url: URL;
  try {
    url = new URL(String(process.env.CLINICAL_AWS_API_ORIGIN ?? ""));
  } catch {
    throw new AdapterError("unavailable");
  }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || !API_HOST.test(url.hostname)) {
    throw new AdapterError("unavailable");
  }
  return url.origin;
}

function token(value: string | null): string {
  const normalized = String(value ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!/^[A-Za-z0-9._-]{100,8192}$/.test(normalized)) throw new AdapterError("unauthenticated");
  return normalized;
}

async function request<T>(authorization: string | null, body: Record<string, unknown>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${origin()}/clinical-core/workforce/chat`, {
      method: "POST",
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
      headers: {
        authorization: `Bearer ${token(authorization)}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    throw new AdapterError("unavailable");
  }

  const raw = await response.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_RESPONSE_BYTES) throw new AdapterError("unavailable");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AdapterError("unavailable");
  }
  if (!response.ok || !parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("data" in parsed)) {
    throw new AdapterError(codeFromHttpStatus(response.status));
  }
  return (parsed as { data: T }).data;
}

export function getAskAlpConfiguration(authorization: string | null) {
  return request<AskAlpConfigurationStatus>(authorization, { action: "configuration_status" });
}

export function activateAskAlpConfiguration(
  authorization: string | null,
  input: { version: string; ruleCodes: string[]; confirmation: string },
) {
  if (!VERSION.test(input.version) || input.confirmation !== `SIGN ASK ALP ${input.version}`
    || input.ruleCodes.length < 1 || input.ruleCodes.length > 100
    || input.ruleCodes.some((code) => !RULE_CODE.test(code))) {
    throw new AdapterError("invalid");
  }
  return request<AskAlpActivationReceipt>(authorization, {
    action: "activate_configuration",
    version: input.version,
    ruleCodes: [...new Set(input.ruleCodes)].sort(),
    confirmation: input.confirmation,
  });
}
