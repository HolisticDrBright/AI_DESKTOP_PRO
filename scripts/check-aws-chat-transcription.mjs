import { readFileSync } from "node:fs";

const template = JSON.parse(readFileSync("infra/aws-clinical-core/chat-transcription-extension.json", "utf8"));
const r = template.Resources;
const fail = (condition, message) => { if (!condition) throw new Error(message); };
fail(template.Metadata.ClinicalCore.ContainsPhi === false, "transcription candidate must remain non-PHI");
fail(r.TranscriptionRoute.Properties.RouteKey === "POST /clinical-core/consumer/chat-transcription", "bounded route required");
fail(r.TranscriptionRoute.Properties.AuthorizationType === "JWT", "consumer JWT required");
fail(r.TranscriptionFunction.Properties.Environment.Variables.PHI_ALLOWED === "false", "PHI must remain disabled");
fail(r.TranscriptionFunction.Properties.Timeout <= 30, "bounded timeout required");
fail(r.TranscriptionBucket.Properties.PublicAccessBlockConfiguration.RestrictPublicBuckets === true, "public access block required");
fail(r.TranscriptionBucket.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0].ServerSideEncryptionByDefault.SSEAlgorithm === "aws:kms", "KMS encryption required");
fail(r.TranscriptionBucket.Properties.LifecycleConfiguration.Rules[0].ExpirationInDays === 1, "one-day cleanup backstop required");
const actions = r.TranscriptionRole.Properties.Policies.flatMap((p) => p.PolicyDocument.Statement.flatMap((s) => Array.isArray(s.Action) ? s.Action : [s.Action]));
fail(actions.includes("s3:DeleteObject") && actions.includes("transcribe:DeleteTranscriptionJob"), "ephemeral deletion permissions required");
fail(!actions.some((action) => action === "s3:*" || action === "transcribe:*"), "wildcard data actions refused");
console.log("AWS chat transcription gate passed: synthetic-only, JWT-bound, encrypted, ephemeral, and PHI-disabled.");
