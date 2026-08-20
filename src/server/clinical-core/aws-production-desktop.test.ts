import { describe, expect, it, vi } from "vitest";
import type { DesktopCompatibilityAdapter } from "./aws-desktop-compatibility";
import {
  createAwsProductionDesktopAdapter,
  ProductionDesktopError,
  type ProductionRequestContext,
} from "./aws-production-desktop";
import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from "./database";

const PERSON = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const PATIENT = "33333333-3333-4333-8333-333333333333";
const OBSERVATION = "44444444-4444-4444-8444-444444444444";

const context: ProductionRequestContext = {
  actorPersonId: PERSON,
  organizationId: ORG,
  identityPool: "workforce",
  identitySubject: "production-subject-001",
  purpose: "clinical_data",
  environment: "production-clinical",
  dataClassification: "clinical_phi",
  containsPhi: true,
  realPatientData: true,
  productionBound: true,
};

function harness(response: unknown = { id: PATIENT, first_name: "Test", last_name: "Patient" }) {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  const tx: ClinicalCoreTransaction = {
    async query<Row extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []) {
      calls.push({ sql, values });
      if (sql.includes(" as data")) return { rows: [{ data: response }] as unknown as Row[] };
      return { rows: [response] as unknown as Row[] };
    },
  };
  const database: ClinicalCoreDatabase = { transaction: (work) => work(tx) };
  const fallback: DesktopCompatibilityAdapter = { execute: vi.fn(async () => ({ delegated: true })) };
  return { calls, fallback, adapter: createAwsProductionDesktopAdapter(database, fallback) };
}

describe("AWS production Desktop adapter", () => {
  it("creates a patient through the exact production function and request context", async () => {
    const test = harness();
    const data = await test.adapter.execute(context, {
      kind: "rpc",
      functionName: "create_patient_profile",
      args: {
        _organization_id: ORG,
        _first_name: "Test",
        _last_name: "Patient",
        _date_of_birth: "1980-01-01",
        _sex: "unknown",
        _mrn: "TEST-001",
        _email: null,
        _phone: null,
      },
    });
    expect(data).toMatchObject({ id: PATIENT });
    expect(test.calls[0]?.sql).toContain("clinical_private.set_request_context");
    expect(test.calls[0]?.values).toEqual(expect.arrayContaining(["production-clinical", "clinical_phi"]));
    expect(test.calls[1]?.sql).toContain("clinical_core.create_patient_profile");
    expect(test.fallback.execute).not.toHaveBeenCalled();
  });

  it("reviews an observation without sending note content to a separate channel", async () => {
    const test = harness({ review_status: "accepted", previous_status: "unreviewed" });
    const data = await test.adapter.execute(context, {
      kind: "rpc",
      functionName: "review_biomarker",
      args: { _observation_id: OBSERVATION, _decision: "accepted", _note: "reviewed in chart" },
    });
    expect(data).toMatchObject({ review_status: "accepted" });
    expect(test.calls[1]?.sql).toBe("select clinical_core.review_biomarker($1,$2,$3) as data");
  });

  it("reads the production patient directory with a fixed query", async () => {
    const test = harness({ id: PATIENT, organization_id: ORG, first_name: "Test", last_name: "Patient" });
    const result = await test.adapter.execute(context, {
      kind: "select",
      table: "patient_profiles",
      query: `select=id,first_name&organization_id=eq.${ORG}&deleted_at=is.null`,
    });
    expect(result).toEqual([expect.objectContaining({ id: PATIENT })]);
    expect(test.calls[1]?.sql).toContain("from clinical_core.patient_records");
  });

  it("refuses a cross-tenant request before touching Aurora", async () => {
    const test = harness();
    await expect(test.adapter.execute(context, {
      kind: "rpc",
      functionName: "create_patient_profile",
      args: {
        _organization_id: "99999999-9999-4999-8999-999999999999",
        _first_name: "Test", _last_name: "Patient", _date_of_birth: null,
        _sex: "unknown", _mrn: null, _email: null, _phone: null,
      },
    })).rejects.toEqual(new ProductionDesktopError("request_invalid"));
  });

  it("delegates every non-core operation to the disabled reviewed registry", async () => {
    const test = harness();
    await expect(test.adapter.execute(context, {
      kind: "rpc", functionName: "list_plans", args: { _organization_id: ORG },
    })).resolves.toEqual({ delegated: true });
    expect(test.fallback.execute).toHaveBeenCalledOnce();
  });
});
