import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { assertQualificationFoundationOutputs, assertQualificationStackOutputs, bindQualificationTarget, loadQualificationTargetManifest, validateQualificationTargetManifest, type QualificationTargetManifest } from "./qualification-target-manifest";

// The reviewed example, and a filled fictional copy of it: every value below is fictional (no real API, bucket or identity).
const example = JSON.parse(readFileSync("infra/aws-clinical-core/qualification-target.example.json", "utf8")) as Record<string, unknown>;
const filled = (): Record<string, unknown> => ({ ...example, exportBucket: "alp-qualification-exports-588966314750-us-east-2", recordingBucket: "alp-qualification-recordings-588966314750-us-east-2",
  databaseSecretArn: "arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-qualification-AbCdEf", sourceCommit: "a".repeat(40), migrationReleaseHash: "b".repeat(64),
  identitySubjects: { consumer: "11111111-2222-4333-8444-555555555555", workforce: "66666666-7777-4888-8999-000000000000", foreignConsumer: "22222222-3333-4444-8555-666666666666" } });
const refuse = (patch: Record<string, unknown>, category: string) => expect(() => validateQualificationTargetManifest({ ...filled(), ...patch })).toThrow(category);
const manifest = (): QualificationTargetManifest => validateQualificationTargetManifest(filled());
const observed = { awsAccountId: "588966314750", sourceCommit: "a".repeat(40), migrationReleaseHash: "b".repeat(64) };
const parameters = (): Record<string, string | undefined> => ({ DatabaseClusterArn: manifest().databaseClusterArn, DatabaseSecretArn: manifest().databaseSecretArn, DatabaseName: "clinical_core_qualification",
  QualificationAccountId: "588966314750", ApiId: "6zt8e9qz04", ExportBucketName: "alp-qualification-exports-588966314750-us-east-2", RecordingBucket: "alp-qualification-recordings-588966314750-us-east-2",
  SourceCommit: "a".repeat(40), QualificationIdentitySubjects: "11111111-2222-4333-8444-555555555555,66666666-7777-4888-8999-000000000000,22222222-3333-4444-8555-666666666666" });

describe("qualification target manifest", () => {
  test("the committed example is the reviewed shape but is refused as a run target until its placeholders are filled", () => {
    expect(() => loadQualificationTargetManifest("infra/aws-clinical-core/qualification-target.example.json")).toThrow("target_placeholder");
    expect(example.databaseName).toBe("clinical_core_qualification"); expect(example.awsAccountId).toBe("588966314750");
    expect((example.refused as Record<string, string>).stagingApiOrigin).toBe("https://wxv734oi12.execute-api.us-east-2.amazonaws.com");
    expect((example.refused as Record<string, string>).stagingFoundationStackName).toBe("ai-clinical-core-synthetic-staging");
    const m = manifest();
    expect(m.apiOrigin).toBe("https://6zt8e9qz04.execute-api.us-east-2.amazonaws.com"); expect(m.foundationStackName).toBe("ai-clinical-core-qualification-foundation"); expect(Object.keys(m.stacks)).toHaveLength(10);
  });
  test("the staging API, the staging database, the staging foundation stack, the production account and a foreign cluster are refused", () => {
    refuse({ apiId: "wxv734oi12", apiOrigin: "https://wxv734oi12.execute-api.us-east-2.amazonaws.com" }, "target_staging_refused");
    refuse({ databaseName: "clinical_core" }, "target_database_refused");
    refuse({ databaseName: "postgres" }, "target_database_refused");
    refuse({ databaseName: "clinical_core_v2" }, "target_database_refused");
    refuse({ stacks: { ...(example.stacks as Record<string, string>), "personal-storage": "ai-clinical-core-synthetic-staging" } }, "target_staging_refused");
    refuse({ foundationStackName: "ai-clinical-core-synthetic-staging" }, "target_staging_refused");
    refuse({ stacks: { ...(example.stacks as Record<string, string>), "personal-storage": "ai-clinical-core-qualification-foundation" } }, "target_manifest_invalid");
    refuse({ awsAccountId: "173535830222", databaseClusterArn: "arn:aws:rds:us-east-2:173535830222:cluster:x", databaseSecretArn: "arn:aws:secretsmanager:us-east-2:173535830222:secret:fictional-x" }, "target_account_refused");
    refuse({ databaseClusterArn: "arn:aws:rds:us-east-2:111111111111:cluster:other" }, "target_account_refused");
    refuse({ databaseClusterArn: "arn:aws:rds:us-west-2:588966314750:cluster:other" }, "target_account_refused");
    refuse({ apiOrigin: "https://6zt8e9qz04.execute-api.us-west-2.amazonaws.com" }, "target_manifest_invalid");
    refuse({ apiOrigin: "http://6zt8e9qz04.execute-api.us-east-2.amazonaws.com" }, "target_manifest_invalid");
    refuse({ containsPhi: true }, "target_manifest_invalid");
    refuse({ identitySubjects: { consumer: "same", workforce: "same", foreignConsumer: "other" } }, "target_manifest_invalid");
    // The second consumer is designated too: an identity the outer qualification gate refuses proves nothing about owner isolation.
    refuse({ identitySubjects: { consumer: "a", workforce: "b" } }, "target_manifest_invalid");
    refuse({ identitySubjects: { consumer: "a", workforce: "b", foreignConsumer: "c", extra: "d" } }, "target_manifest_invalid");
    refuse({ recordingBucket: "alp-qualification-exports-588966314750-us-east-2" }, "target_manifest_invalid");
    refuse({ recordingBucket: "replace-with-recordings" }, "target_placeholder");
    refuse({ stacks: { "personal-storage": "only-one" } }, "target_manifest_invalid");
    refuse({ extra: 1 }, "target_manifest_invalid");
    refuse({ sourceCommit: "0".repeat(40) }, "target_placeholder");
    refuse({ migrationReleaseHash: "0".repeat(64) }, "target_placeholder");
    refuse({ exportBucket: "replace-with-bucket" }, "target_placeholder");
  });
  test("binding refuses another account, the production account, a stale checkout, another built artifact and any disagreeing ambient override", () => {
    const m = manifest();
    const bound = bindQualificationTarget(m, observed, { CLINICAL_API_ORIGIN: m.apiOrigin, OTHER: "x" });
    expect(bound).toMatchObject({ apiOrigin: m.apiOrigin, expectedAwsAccountId: "588966314750", observedAwsAccountId: "588966314750", expectedExportBucket: "alp-qualification-exports-588966314750-us-east-2",
      database: { databaseName: "clinical_core_qualification", stagingDatabaseName: "clinical_core" } });
    expect(() => bindQualificationTarget(m, { ...observed, awsAccountId: "173535830222" }, {})).toThrow("target_account_refused");
    expect(() => bindQualificationTarget(m, { ...observed, awsAccountId: "111111111111" }, {})).toThrow("target_account_refused");
    expect(() => bindQualificationTarget(m, { ...observed, sourceCommit: "c".repeat(40) }, {})).toThrow("target_source_mismatch");
    expect(() => bindQualificationTarget(m, { ...observed, migrationReleaseHash: "d".repeat(64) }, {})).toThrow("target_ledger_mismatch");
    // The old wrappers exported the staging foundation's ApiOrigin and DatabaseName; those values are now refused, not obeyed.
    expect(() => bindQualificationTarget(m, observed, { CLINICAL_API_ORIGIN: "https://wxv734oi12.execute-api.us-east-2.amazonaws.com" })).toThrow("target_override_refused");
    expect(() => bindQualificationTarget(m, observed, { CLINICAL_DATABASE_NAME: "clinical_core" })).toThrow("target_override_refused");
    expect(() => bindQualificationTarget(m, observed, { EXPECTED_AWS_ACCOUNT_ID: "111111111111" })).toThrow("target_override_refused");
  });
  test("the prepared foundation must state PHI false and agree with the manifest where it names the API or database; its disabled execution output is not candidate evidence", () => {
    const m = manifest();
    expect(() => assertQualificationFoundationOutputs({ PhiAllowed: "false", Activation: "blocked", QualificationExecution: "disabled", QualificationInfrastructure: "prepared_no_candidates", ApiId: "6zt8e9qz04" }, m)).not.toThrow();
    expect(() => assertQualificationFoundationOutputs({ PhiAllowed: "true" }, m)).toThrow("target_stack_refused");
    expect(() => assertQualificationFoundationOutputs({ PhiAllowed: "false", ApiId: "wxv734oi12" }, m)).toThrow("target_stack_refused");
    expect(() => assertQualificationFoundationOutputs({ PhiAllowed: "false", DatabaseName: "clinical_core" }, m)).toThrow("target_stack_refused");
  });
  test("a candidate stack must report PHI false, activation blocked, qualification enabled and the manifest's source commit", () => {
    const m = manifest();
    const good = { PhiAllowed: "false", Activation: "blocked", QualificationExecution: "enabled", SourceCommit: "a".repeat(40) };
    expect(() => assertQualificationStackOutputs("personal-storage", good, m, parameters(), "CREATE_COMPLETE")).not.toThrow();
    for (const bad of [{ PhiAllowed: "true" }, { Activation: "approved" }, { QualificationExecution: "disabled" }, { SourceCommit: "c".repeat(40) }, { SourceCommit: undefined }]) {
      expect(() => assertQualificationStackOutputs("personal-storage", { ...good, ...bad }, m, parameters(), "CREATE_COMPLETE")).toThrow("target_stack_refused");
    }
  });
  test("a candidate stack must also name the manifest's cluster, secret, database, API, buckets and designated subjects, and have finished", () => {
    const m = manifest();
    const outputs = { PhiAllowed: "false", Activation: "blocked", QualificationExecution: "enabled", SourceCommit: "a".repeat(40) };
    const check = (candidate: string, patch: Record<string, string | undefined>, status = "CREATE_COMPLETE") =>
      expect(() => assertQualificationStackOutputs(candidate, outputs, m, { ...parameters(), ...patch }, status)).toThrow("target_stack_refused");
    expect(() => assertQualificationStackOutputs("personal-storage", outputs, m, parameters(), "UPDATE_COMPLETE")).not.toThrow();
    // A database or API name does not identify one database or API: the cluster, the secret and the buckets do.
    check("personal-storage", { DatabaseClusterArn: "arn:aws:rds:us-east-2:588966314750:cluster:other-cluster" });
    check("personal-storage", { DatabaseSecretArn: "arn:aws:secretsmanager:us-east-2:588966314750:secret:other-secret" });
    check("personal-storage", { DatabaseName: "clinical_core" });
    check("personal-storage", { ApiId: "wxv734oi12" });
    check("personal-storage", { ExportBucketName: "some-other-bucket" });
    check("personal-storage", { QualificationAccountId: "111111111111" });
    check("recording-capture", { RecordingBucket: "some-other-bucket" });
    // A parameter the candidate uses but does not carry is a refusal, not a pass.
    for (const missing of ["DatabaseClusterArn", "DatabaseSecretArn", "DatabaseName", "QualificationAccountId", "ApiId", "ExportBucketName", "QualificationIdentitySubjects"]) check("personal-storage", { [missing]: undefined });
    check("recording-capture", { RecordingBucket: undefined });
    // Every designated subject must be served, and no undesignated one.
    check("personal-storage", { QualificationIdentitySubjects: "11111111-2222-4333-8444-555555555555,66666666-7777-4888-8999-000000000000" });
    check("personal-storage", { QualificationIdentitySubjects: parameters().QualificationIdentitySubjects + ",99999999-9999-4999-8999-999999999999" });
    // A stack that did not finish, and a candidate the manifest does not know, are refused.
    check("personal-storage", {}, "ROLLBACK_COMPLETE");
    check("personal-storage", {}, "UPDATE_IN_PROGRESS");
    check("unknown-candidate", {});
    // owned-lab and owned-voice attach to the shared API as ClinicalApiId and export no SourceCommit, so they are asked
    // for what they actually carry, not for the other candidates' parameter names.
    const shared = { ...parameters(), ApiId: undefined, ExportBucketName: undefined, RecordingBucket: undefined, SourceCommit: undefined, ClinicalApiId: "6zt8e9qz04" };
    const sharedOutputs = { PhiAllowed: "false", Activation: "blocked", QualificationExecution: "enabled" };
    expect(() => assertQualificationStackOutputs("owned-lab", sharedOutputs, m, shared, "CREATE_COMPLETE")).not.toThrow();
    expect(() => assertQualificationStackOutputs("owned-voice", sharedOutputs, m, shared, "CREATE_COMPLETE")).not.toThrow();
    expect(() => assertQualificationStackOutputs("owned-voice", sharedOutputs, m, { ...shared, ClinicalApiId: "wxv734oi12" }, "CREATE_COMPLETE")).toThrow("target_stack_refused");
    expect(() => assertQualificationStackOutputs("owned-voice", { ...sharedOutputs, SourceCommit: "c".repeat(40) }, m, shared, "CREATE_COMPLETE")).toThrow("target_stack_refused");
    // The drain posture is the voice shutdown's: draining, qualification execution disabled, and no identity served.
    const draining = { PhiAllowed: "false", Activation: "draining", QualificationExecution: "disabled" };
    expect(() => assertQualificationStackOutputs("owned-voice", draining, m, { ...shared, QualificationIdentitySubjects: undefined }, "CREATE_COMPLETE", "drain")).not.toThrow();
    expect(() => assertQualificationStackOutputs("owned-voice", sharedOutputs, m, shared, "CREATE_COMPLETE", "drain")).toThrow("target_stack_refused");
    expect(() => assertQualificationStackOutputs("owned-voice", { ...draining, QualificationExecution: "enabled" }, m, shared, "CREATE_COMPLETE", "drain")).toThrow("target_stack_refused");
    expect(() => assertQualificationStackOutputs("personal-storage", outputs, m, parameters(), "CREATE_COMPLETE", "drain")).toThrow("target_stack_refused");
    // A retention service subject, when the manifest names one, must be served too.
    const withService = validateQualificationTargetManifest({ ...filled(), identitySubjects: { ...(filled().identitySubjects as Record<string, string>), retentionService: "77777777-8888-4999-8aaa-bbbbbbbbbbbb" } });
    expect(() => assertQualificationStackOutputs("personal-storage", outputs, withService, parameters(), "CREATE_COMPLETE")).toThrow("target_stack_refused");
  });
});
