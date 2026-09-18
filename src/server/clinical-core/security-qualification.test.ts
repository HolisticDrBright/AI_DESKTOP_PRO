import { describe, expect, it, vi } from "vitest";
vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/lib-dynamodb", () => ({ DynamoDBDocumentClient: { from: () => ({ send: vi.fn(async () => { throw new Error("storage must not be reached"); }) }) },
  GetCommand: class {}, PutCommand: class {}, QueryCommand: class {}, TransactWriteCommand: class {}, UpdateCommand: class {} }));
vi.mock("@aws-sdk/client-secrets-manager", () => ({ SecretsManagerClient: class { send = vi.fn(async () => { throw new Error("secrets must not be reached"); }); }, GetSecretValueCommand: class {} }));
vi.mock("@aws-sdk/client-sesv2", () => ({ SESv2Client: class { send = vi.fn(); }, SendEmailCommand: class {} }));
vi.mock("@aws-sdk/client-scheduler", () => ({ SchedulerClient: class { send = vi.fn(); }, CreateScheduleCommand: class {}, DeleteScheduleCommand: class {} }));
import { runSecurityQualification } from "./security-qualification";

describe("credential-free security qualification", () => {
  it("passes every adversarial case without reaching storage or leaking identifiers, with a stable evidence hash", async () => {
    const now = Date.parse("2026-09-16T12:00:00Z");
    const report = await runSecurityQualification(now);
    expect(report.failed).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.total).toBeGreaterThanOrEqual(25);
    expect(report.cases.filter(c => c.storageTouched).map(c => c.id)).toEqual(["storage_failure_is_sanitized"]);
    expect(report.cases.every(c => !c.leaked)).toBe(true);
    expect((await runSecurityQualification(now)).evidenceSha256).toBe(report.evidenceSha256);
    expect(report.cases.find(c => c.id === "telehealth_production_without_phi_gate")).toMatchObject({ actualStatus: 503, actualError: "production_not_activated" });
  });
});
