import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from "./database";
import { createAwsChatContextAdapter } from "./aws-chat-context";
import type { SyntheticRequestContext } from "./aws-identity-consent";

const context: SyntheticRequestContext = {
  actorPersonId: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
  identityPool: "consumer", identitySubject: "consumer-subject-1234",
  purpose: "clinical_data", environment: "synthetic-staging", dataClassification: "synthetic_only",
  containsPhi: false, realPatientData: false,
};

describe("AWS patient chat context", () => {
  it("sets the request context before retrieving one bounded snapshot", async () => {
    const statements: string[] = [];
    const tx: ClinicalCoreTransaction = { query: async <Row extends Record<string, unknown>>(sql: string) => {
      statements.push(sql);
      return { rows: (sql.includes("get_patient_chat_context") ? [{ data: { labs: [], promotedPatterns: [] } }] : []) as unknown as Row[] };
    } };
    const database: ClinicalCoreDatabase = { transaction: async (work) => work(tx) };
    await expect(createAwsChatContextAdapter(database).getContext(context)).resolves.toMatchObject({ labs: [] });
    expect(statements[0]).toContain("set_request_context");
    expect(statements[1]).toContain("get_patient_chat_context");
  });

  it("omits unconsented domains and never fabricates cycle phase, functional ranges, TCM, or memory", () => {
    const sql = readFileSync(path.join(process.cwd(), "supabase", "migrations", "20260901033256_patient_chat_context.sql"), "utf8");
    for (const scope of ["reproductive_health", "wearables", "lab_summaries", "protocols_supplements"]) {
      expect(sql).toContain(`consent.scope='${scope}'`);
    }
    expect(sql).toContain("_stage='regular_cycle'");
    expect(sql).toContain("'functionalRange',null");
    expect(sql).toContain("'tcm',_tcm");
    expect(sql).toContain("'conversationMemory',null");
    expect(sql).not.toMatch(/coalesce\([^)]*(hrv|restingHr|sleepDurationMinutes)[^)]*,\s*[0-9]/i);
  });
});
