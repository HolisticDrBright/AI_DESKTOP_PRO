import { readFileSync } from "node:fs";

const template = JSON.parse(readFileSync("infra/aws-clinical-core/ask-alp-extension.json", "utf8"));
const r = template.Resources;
const fail = (condition, message) => { if (!condition) throw new Error(message); };
fail(template.Metadata.ClinicalCore.PhiAllowed === false, "Ask ALP candidate must remain PHI-disabled");
fail(template.Metadata.ClinicalCore.ProviderStorage === false, "provider storage must remain disabled");
fail(r.AskAlpRoute.Properties.RouteKey === "POST /clinical-core/consumer/ask-alp/generate", "bounded consumer route required");
fail(r.AskAlpRoute.Properties.AuthorizationType === "JWT", "consumer JWT required");
fail(r.AskAlpFunction.Properties.Environment.Variables.PHI_ALLOWED === "false", "PHI must remain disabled");
fail(r.AskAlpFunction.Properties.Environment.Variables.ASK_ALP_APPROVED_PROMPT_SHA256.Ref === "ApprovedPromptSha256", "approved prompt hash required");
fail(r.AskAlpFunction.Properties.Timeout <= 35, "bounded timeout required");
const actions = r.AskAlpRole.Properties.Policies.flatMap((p) => p.PolicyDocument.Statement.flatMap((s) => Array.isArray(s.Action) ? s.Action : [s.Action]));
fail(actions.filter((action) => action === "secretsmanager:GetSecretValue").length === 1, "one exact secret read required");
fail(!actions.some((action) => String(action).endsWith(":*") || action === "*"), "wildcard actions refused");
console.log("AWS Ask ALP gate passed: synthetic-only, JWT-bound, exact-prompt, stored-false OpenAI boundary.");
