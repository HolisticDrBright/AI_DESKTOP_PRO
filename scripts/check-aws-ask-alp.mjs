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
function policies(value) {
  if (value?.Ref === 'AWS::NoValue') return [];
  if (value?.PolicyDocument && Array.isArray(value.PolicyDocument.Statement)) return [value];
  const branches=value?.['Fn::If'];
  fail(Array.isArray(branches)&&branches.length===3&&Boolean(template.Conditions?.[branches[0]]), 'unknown conditional IAM policy');
  // Inspect both branches, not just the disabled default.
  return [...policies(branches[1]),...policies(branches[2])];
}
const expanded=r.AskAlpRole.Properties.Policies.flatMap(policies);
const actions = expanded.flatMap((p) => p.PolicyDocument.Statement.flatMap((s) => Array.isArray(s.Action) ? s.Action : [s.Action]));
fail(template.Parameters.KnowledgeReleaseMode.Default==='disabled','knowledge must default disabled');
const knowledge=expanded.find(p=>p.PolicyName==='PinnedReviewedKnowledge')?.PolicyDocument.Statement;
fail(knowledge?.length===1&&knowledge[0].Action==='s3:GetObjectVersion','knowledge access must be version-read-only');
fail(knowledge[0].Resource['Fn::Sub']==='arn:${AWS::Partition}:s3:::${KnowledgeReleaseBucket}/${KnowledgeReleaseKey}','knowledge object must be exact');
fail(knowledge[0].Condition?.StringEquals?.['s3:VersionId']?.Ref==='KnowledgeReleaseObjectVersion','knowledge object version must be pinned');
fail(actions.filter((action) => action === "secretsmanager:GetSecretValue").length === 1, "one exact secret read required");
fail(!actions.some((action) => String(action).endsWith(":*") || action === "*"), "wildcard actions refused");
console.log("AWS Ask ALP gate passed: synthetic-only, JWT-bound, exact-prompt, stored-false OpenAI boundary.");
