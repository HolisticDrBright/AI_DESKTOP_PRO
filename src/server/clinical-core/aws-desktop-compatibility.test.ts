import { describe, expect, test, vi } from "vitest";
import {
  createAwsDesktopCompatibilityAdapter,
  DesktopCompatibilityError,
  validateDesktopCompatibilityRequest,
} from "./aws-desktop-compatibility";
import type { SyntheticRequestContext } from "./aws-identity-consent";
import type { ClinicalCoreDatabase } from "./database";

const ORG = "22222222-2222-4222-8222-222222222222";
const context: SyntheticRequestContext = {
  actorPersonId: "11111111-1111-4111-8111-111111111111",
  organizationId: ORG,
  identityPool: "workforce",
  identitySubject: "synthetic-subject-001",
  purpose: "clinical_data",
  environment: "synthetic-staging",
  dataClassification: "synthetic_only",
  containsPhi: false,
  realPatientData: false,
};

describe("AWS Desktop compatibility boundary", () => {
  test("accepts only reviewed RPCs bound to the token organization", () => {
    expect(validateDesktopCompatibilityRequest(context, {
      kind: "rpc", functionName: "get_patient_overview", args: { _organization_id: ORG, _patient_id: "patient-1" },
    })).toMatchObject({ kind: "rpc", functionName: "get_patient_overview" });
    expect(() => validateDesktopCompatibilityRequest(context, {
      kind: "rpc", functionName: "unreviewed_function", args: { _organization_id: ORG },
    })).toThrow(DesktopCompatibilityError);
    expect(() => validateDesktopCompatibilityRequest(context, {
      kind: "rpc", functionName: "get_patient_overview", args: { _organization_id: "33333333-3333-4333-8333-333333333333" },
    })).toThrow(DesktopCompatibilityError);
  });

  test("requires every bounded read to include the token organization", () => {
    expect(validateDesktopCompatibilityRequest(context, {
      kind: "select", table: "patient_profiles", query: `select=id&organization_id=eq.${ORG}&limit=1`,
    })).toMatchObject({ kind: "select", table: "patient_profiles" });
    expect(() => validateDesktopCompatibilityRequest(context, {
      kind: "select", table: "patient_profiles", query: "select=id&limit=1",
    })).toThrow(DesktopCompatibilityError);
    expect(() => validateDesktopCompatibilityRequest(context, {
      kind: "select", table: "organizations", query: `select=id&organization_id=eq.${ORG}`,
    })).toThrow(DesktopCompatibilityError);
  });

  test("sets immutable request context and invokes one database dispatcher", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ data: JSON.stringify([{ id: "synthetic-patient" }]) }] });
    const database: ClinicalCoreDatabase = { transaction: (work) => work({ query }) };
    const adapter = createAwsDesktopCompatibilityAdapter(database);
    await expect(adapter.execute(context, {
      kind: "rpc", functionName: "get_patient_overview", args: { _organization_id: ORG },
    })).resolves.toEqual([{ id: "synthetic-patient" }]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0]).toContain("set_request_context");
    expect(query.mock.calls[1]?.[0]).toContain("invoke_desktop_compatibility");
    expect(query.mock.calls[1]?.[1]?.[0]).toBe("rpc");
  });

  test("collapses database failures into a bounded unavailable category", async () => {
    const database: ClinicalCoreDatabase = {
      transaction: vi.fn(async () => { throw new Error("provider detail"); }),
    };
    await expect(createAwsDesktopCompatibilityAdapter(database).execute(context, {
      kind: "rpc", functionName: "get_patient_overview", args: { _organization_id: ORG },
    })).rejects.toMatchObject({ category: "database_unavailable" });
  });
});
