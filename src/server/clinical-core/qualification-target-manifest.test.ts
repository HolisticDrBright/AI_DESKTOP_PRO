import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { assertQualificationFoundationOutputs, assertQualificationStackOutputs, bindQualificationTarget, loadQualificationTargetManifest, validateQualificationTargetManifest, type QualificationTargetManifest } from "./qualification-target-manifest";

// The reviewed example, and a filled fictional copy of it: every value below is fictional (no real API, bucket or identity).
const example = JSON.parse(readFileSync("infra/aws-clinical-core/qualification-target.example.json", "utf8")) as Record<string, unknown>;
const filled = (): Record<string, unknown> => ({ ...example,
  databaseSecretArn: "arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-qualification-AbCdEf", sourceCommit: "a".repeat(40), migrationReleaseHash: "b".repeat(64),
  identitySubjects: { consumer: "11111111-2222-4333-8444-555555555555", workforce: "66666666-7777-4888-8999-000000000000" } });
const refuse = (patch: Record<string, unknown>, category: string) => expect(() => validateQualificationTargetManifest({ ...filled(), ...patch })).toThrow(category);
const manifest = (): QualificationTargetManifest => validateQualificationTargetManifest(filled());
const observed = { awsAccountId: "588966314750", sourceCommit: "a".repeat(40), migrationReleaseHash: "b".repeat(64) };

describe("qualification target manifest", () => {
  test("the committed example is the reviewed shape but is refused as a run target until its placeholders are filled", () => {
    expect(() => loadQualificationTargetManifest("infra/aws-clinical-core/qualification-target.example.json")).toThrow("target_placeholder");
    expect(example.databaseName).toBe("clinical_core_qualification"); expect(example.awsAccountId).toBe("588966314750");
    expect((example.refused as Record<string, string>).stagingApiOrigin).toBe("https://wxv734oi12.execute-api.us-east-2.amazonaws.com");
    expect((example.refused as Record<string, string>).stagingFoundationStackName).toBe("ai-clinical-core-synthetic-staging");
    const m = manifest();
    expect(m.apiOrigin).toBe("https://6zt8e9qz04.execute-api.us-east-2.amazonaws.com"); expect(m.foundationStackName).toBe("ai-clinical-core-qualification-foundation"); expect(Object.keys(m.stacks)).toHaveLength(7);
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
    refuse({ identitySubjects: { consumer: "same", workforce: "same" } }, "target_manifest_invalid");
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
    expect(() => assertQualificationStackOutputs("personal-storage", good, m)).not.toThrow();
    for (const bad of [{ PhiAllowed: "true" }, { Activation: "approved" }, { QualificationExecution: "disabled" }, { SourceCommit: "c".repeat(40) }, { SourceCommit: undefined }]) {
      expect(() => assertQualificationStackOutputs("personal-storage", { ...good, ...bad }, m)).toThrow("target_stack_refused");
    }
  });
});
