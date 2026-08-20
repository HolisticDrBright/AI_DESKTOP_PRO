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
const AUDIT = "55555555-5555-4555-8555-555555555555";
const MEMBERSHIP = "66666666-6666-4666-8666-666666666666";

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

  it("records only the bounded registered audit payload in the caller tenant", async () => {
    const test = harness({ id: AUDIT });
    const result = await test.adapter.execute(context, {
      kind: "rpc",
      functionName: "record_registered_audit_event",
      args: {
        _organization_id: ORG,
        _event_type: "report.exported",
        _resource_id: "report-001",
        _patient_id: null,
        _metadata: { format: "pdf", report_type: "labs" },
      },
    });
    expect(result).toBe(AUDIT);
    expect(test.calls[1]?.sql).toContain("clinical_core.record_registered_audit_event");
    expect(test.calls[1]?.values).toEqual([
      { kind: "uuid", value: ORG }, "report.exported", "report-001", null,
      JSON.stringify({ format: "pdf", report_type: "labs" }),
    ]);
    expect(test.fallback.execute).not.toHaveBeenCalled();
  });

  it("reads bounded tenant-scoped audit history through the production function", async () => {
    const test = harness({
      id: AUDIT,
      action: "patient.created",
      resource_type: "patient_profile",
      resource_id: PATIENT,
      safe_message: null,
      patient_id: null,
      actor_user_id: PERSON,
      occurred_at: "2026-08-20T00:00:00.000Z",
      metadata: { source: "manual" },
    });
    const result = await test.adapter.execute(context, {
      kind: "rpc",
      functionName: "list_audit_events",
      args: { _organization_id: ORG, _limit: 50 },
    });
    expect(result).toEqual([expect.objectContaining({ id: AUDIT, action: "patient.created" })]);
    expect(test.calls[1]?.sql).toBe("select * from clinical_core.list_audit_events($1,$2)");
    expect(test.calls[1]?.values).toEqual([{ kind: "uuid", value: ORG }, 50]);
  });

  it("refuses cross-tenant and unbounded audit requests after only establishing request context", async () => {
    const test = harness();
    await expect(test.adapter.execute(context, {
      kind: "rpc",
      functionName: "list_audit_events",
      args: { _organization_id: "99999999-9999-4999-8999-999999999999", _limit: 50 },
    })).rejects.toEqual(new ProductionDesktopError("request_invalid"));
    await expect(test.adapter.execute(context, {
      kind: "rpc",
      functionName: "list_audit_events",
      args: { _organization_id: ORG, _limit: 201 },
    })).rejects.toEqual(new ProductionDesktopError("request_invalid"));
    expect(test.calls).toHaveLength(2);
    expect(test.calls.every((call) => call.sql.includes("clinical_private.set_request_context"))).toBe(true);
  });

  it("refuses nested or oversized generic audit metadata without issuing an audit query", async () => {
    const test = harness();
    await expect(test.adapter.execute(context, {
      kind: "rpc",
      functionName: "record_registered_audit_event",
      args: {
        _organization_id: ORG,
        _event_type: "report.exported",
        _resource_id: "report-001",
        _patient_id: null,
        _metadata: { payload: { identifying: "content" } },
      },
    })).rejects.toEqual(new ProductionDesktopError("request_invalid"));
    expect(test.calls).toHaveLength(1);
    expect(test.calls[0]?.sql).toContain("clinical_private.set_request_context");
  });

  it("lists only the production identity's organizations through the governed function", async () => {
    const test = harness({ organization_id: ORG, name: "Clinic", slug: ORG, role: "owner" });
    const result = await test.adapter.execute(context, {
      kind: "rpc", functionName: "list_my_organizations", args: {},
    });
    expect(result).toEqual([expect.objectContaining({ organization_id: ORG, role: "owner" })]);
    expect(test.calls[1]?.sql).toBe("select * from clinical_core.list_my_organizations()");
  });

  it("lists the workforce roster only through the tenant-scoped production function", async () => {
    const test = harness({
      membership_id: MEMBERSHIP,
      user_id: PERSON,
      email: null,
      display_name: null,
      role: "practitioner",
      status: "active",
      joined_at: "2026-08-20T00:00:00.000Z",
    });
    const result = await test.adapter.execute(context, {
      kind: "rpc", functionName: "list_org_members", args: { _organization_id: ORG },
    });
    expect(result).toEqual([expect.objectContaining({ membership_id: MEMBERSHIP, email: null })]);
    expect(test.calls[1]?.sql).toBe("select * from clinical_core.list_org_members($1)");
    expect(test.calls[1]?.values).toEqual([{ kind: "uuid", value: ORG }]);
  });

  it("changes or suspends a membership only through guarded production functions", async () => {
    const roleTest = harness({});
    await expect(roleTest.adapter.execute(context, {
      kind: "rpc",
      functionName: "set_org_member_role",
      args: { _membership_id: MEMBERSHIP, _role: "admin" },
    })).resolves.toBeNull();
    expect(roleTest.calls[1]?.sql).toBe("select clinical_core.set_org_member_role($1,$2)");
    expect(roleTest.calls[1]?.values).toEqual([{ kind: "uuid", value: MEMBERSHIP }, "admin"]);

    const removeTest = harness({});
    await expect(removeTest.adapter.execute(context, {
      kind: "rpc",
      functionName: "remove_org_member",
      args: { _membership_id: MEMBERSHIP },
    })).resolves.toBeNull();
    expect(removeTest.calls[1]?.sql).toBe("select clinical_core.remove_org_member($1)");
  });

  it("keeps legacy email invitation and self-activation outside the production core", async () => {
    const test = harness();
    await expect(test.adapter.execute(context, {
      kind: "rpc",
      functionName: "add_org_member",
      args: { _organization_id: ORG, _email: "person@example.test", _role: "staff" },
    })).resolves.toEqual({ delegated: true });
    await expect(test.adapter.execute(context, {
      kind: "rpc", functionName: "activate_my_memberships", args: {},
    })).resolves.toEqual({ delegated: true });
    expect(test.fallback.execute).toHaveBeenCalledTimes(2);
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
