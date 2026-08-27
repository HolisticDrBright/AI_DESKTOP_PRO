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
const QUEUE_ITEM = "77777777-7777-4777-8777-777777777777";
const APPOINTMENT = "88888888-8888-4888-8888-888888888888";
const ENCOUNTER = "99999999-9999-4999-8999-999999999999";
const NOTE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONNECTION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROTOCOL = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PROTOCOL_VERSION = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SYNC_EVENT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const SYNC_CONFLICT = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const CATALOG_VERSION = "12121212-1212-4212-8212-121212121212";
const TEMPLATE_VERSION = "13131313-1313-4313-8313-131313131313";
const OTHER_TEMPLATE_VERSION = "14141414-1414-4414-8414-141414141414";
const TEMPLATE = "15151515-1515-4515-8515-151515151515";
const PROTOCOL_ITEM = "16161616-1616-4616-8616-161616161616";
const HYPOTHESIS = "17171717-1717-4717-8717-171717171717";
const QUESTION = "18181818-1818-4818-8818-181818181818";
const SAFETY_BLOCK = "19191919-1919-4919-8919-191919191919";
const PATHWAY = "20202020-2020-4020-8020-202020202020";
const PATHWAY_VERSION = "21212121-2121-4121-8121-212121212121";
const IMPORT_BATCH = "22222222-3333-4333-8333-222222222222";
const IMPORT_ITEM = "23232323-2323-4323-8323-232323232323";

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

  it("reads the empty-or-reviewed pathway registry through a bounded AWS function", async () => {
    const test = harness([{ id: PATHWAY, clinical_pathway_versions: [] }]);
    const result = await test.adapter.execute(context, {
      kind: "select",
      table: "clinical_pathways",
      query: `select=id,name&organization_id=eq.${ORG}&retired_at=is.null&order=name.asc`,
    });
    expect(result).toEqual([{ id: PATHWAY, clinical_pathway_versions: [] }]);
    expect(test.calls[1]?.sql).toBe("select clinical_core.list_clinical_pathways($1) as data");
    expect(test.fallback.execute).not.toHaveBeenCalled();
  });

  it("routes pathway drafts and human approval without accepting commercial fields", async () => {
    const content = {
      differentiatingQuestions: ["Which source finding needs review?"],
      labStrategy: [{ panel: "Synthetic panel", vendor: "Not selected", purpose: "Review evidence" }],
      productCandidates: [{ name: "Candidate", brand: "Not selected", role: "Requires review" }],
      nutrition: ["Review before use"], lifestyle: ["Review before use"], safetyStops: ["Stop for adverse effects"],
    };
    const create = harness({ versionId: PATHWAY_VERSION, version: 2 });
    await expect(create.adapter.execute(context, { kind: "rpc", functionName: "create_clinical_pathway_draft",
      args: { _pathway_id: PATHWAY, _content: content, _source_refs: [{ label: "Reviewed source" }],
        _change_summary: "Practitioner-authored revision" },
    })).resolves.toMatchObject({ version: 2 });
    expect(create.calls[1]?.sql).toBe(
      "select clinical_core.create_clinical_pathway_draft($1,$2::jsonb,$3::jsonb,$4) as data",
    );

    const update = harness();
    await expect(update.adapter.execute(context, { kind: "rpc", functionName: "update_clinical_pathway_draft",
      args: { _version_id: PATHWAY_VERSION, _content: content, _source_refs: [{ label: "Reviewed source" }],
        _change_summary: null },
    })).resolves.toBeNull();
    expect(update.calls[1]?.sql).toBe(
      "select clinical_core.update_clinical_pathway_draft($1,$2::jsonb,$3::jsonb,$4)",
    );

    const approve = harness();
    await expect(approve.adapter.execute(context, { kind: "rpc", functionName: "approve_clinical_pathway_version",
      args: { _version_id: PATHWAY_VERSION },
    })).resolves.toBeNull();
    expect(approve.calls[1]?.sql).toBe("select clinical_core.approve_clinical_pathway_version($1)");

    const commercial = harness();
    await expect(commercial.adapter.execute(context, { kind: "rpc", functionName: "create_clinical_pathway_draft",
      args: { _pathway_id: PATHWAY, _content: { ...content, affiliateUrl: "https://example.invalid" },
        _source_refs: [{ label: "Reviewed source" }], _change_summary: null },
    })).rejects.toEqual(new ProductionDesktopError("request_invalid"));
    expect(commercial.calls).toHaveLength(1);
  });

  it("stages and reviews bounded no-PHI knowledge without approving it", async () => {
    const items = [{
      entityType: "pathway", externalKey: "pathway_test", displayName: "Test pathway",
      sourceSheet: "Reviewed source", warnings: ["Practitioner review required"],
      payload: {
        code: "pathway_test", name: "Test pathway", domainCode: "testing",
        sourceRefs: [{ label: "Reviewed source" }],
        content: {
          differentiatingQuestions: [], labStrategy: [], productCandidates: [],
          nutrition: [], lifestyle: [], safetyStops: ["Stop pending review"],
        },
      },
    }];
    const stage = harness({ batchId: IMPORT_BATCH, itemCount: 1, duplicate: false });
    await expect(stage.adapter.execute(context, {
      kind: "rpc", functionName: "stage_clinical_knowledge_import",
      args: {
        _organization_id: ORG, _source_name: "Reviewed authoring package", _source_revision: "v1",
        _schema_version: "clinical-knowledge-import-v1", _items: items, _attests_no_phi: true,
      },
    })).resolves.toMatchObject({ batchId: IMPORT_BATCH, duplicate: false });
    expect(stage.calls[1]?.sql).toBe(
      "select clinical_core.stage_clinical_knowledge_import($1,$2,$3,$4,$5::jsonb,$6) as data",
    );

    const review = harness({
      status: "applied", appliedRefType: "clinical_pathway_version", appliedRefId: PATHWAY_VERSION,
    });
    await expect(review.adapter.execute(context, {
      kind: "rpc", functionName: "review_clinical_knowledge_import_item",
      args: { _item_id: IMPORT_ITEM, _decision: "accept", _review_note: "Reviewed against source evidence" },
    })).resolves.toMatchObject({ status: "applied", appliedRefType: "clinical_pathway_version" });
    expect(review.calls[1]?.sql).toBe(
      "select clinical_core.review_clinical_knowledge_import_item($1,$2,$3) as data",
    );
  });

  it("reads bounded tenant knowledge-import batches and items through AWS functions", async () => {
    const batches = harness([{ id: IMPORT_BATCH, organization_id: ORG, status: "in_review" }]);
    await expect(batches.adapter.execute(context, {
      kind: "select", table: "clinical_knowledge_import_batches",
      query: `select=id&organization_id=eq.${ORG}&order=created_at.desc&limit=20`,
    })).resolves.toEqual([expect.objectContaining({ id: IMPORT_BATCH })]);
    expect(batches.calls[1]?.sql).toBe(
      "select clinical_core.list_clinical_knowledge_import_batches($1,$2) as data",
    );

    const items = harness([{ id: IMPORT_ITEM, batch_id: IMPORT_BATCH, status: "needs_review" }]);
    await expect(items.adapter.execute(context, {
      kind: "select", table: "clinical_knowledge_import_items",
      query: `select=id&organization_id=eq.${ORG}&batch_id=in.(${IMPORT_BATCH})&order=created_at.asc`,
    })).resolves.toEqual([expect.objectContaining({ id: IMPORT_ITEM })]);
    expect(items.calls[1]?.sql).toBe(
      "select clinical_core.list_clinical_knowledge_import_items($1,string_to_array($2,',')::uuid[]) as data",
    );
  });

  it("refuses missing attestation, commercial payloads, and weak review claims before Aurora", async () => {
    const test = harness();
    const base = {
      _organization_id: ORG, _source_name: "Source", _source_revision: null,
      _schema_version: "clinical-knowledge-import-v1", _attests_no_phi: true,
      _items: [{ entityType: "product_label", externalKey: "product_test", displayName: "Test",
        warnings: [], payload: { productCode: "product_test", affiliateUrl: "https://example.invalid" } }],
    };
    await expect(test.adapter.execute(context, { kind: "rpc", functionName: "stage_clinical_knowledge_import",
      args: { ...base, _attests_no_phi: false },
    })).rejects.toEqual(new ProductionDesktopError("request_invalid"));
    await expect(test.adapter.execute(context, { kind: "rpc", functionName: "stage_clinical_knowledge_import",
      args: base,
    })).rejects.toEqual(new ProductionDesktopError("request_invalid"));
    await expect(test.adapter.execute(context, { kind: "rpc", functionName: "review_clinical_knowledge_import_item",
      args: { _item_id: IMPORT_ITEM, _decision: "accept", _review_note: "yes" },
    })).rejects.toEqual(new ProductionDesktopError("request_invalid"));
    expect(test.calls).toHaveLength(3);
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

  it("invites only an existing AWS workforce identity and claims pending memberships", async () => {
    const invite = harness({ membership_id: MEMBERSHIP });
    await expect(invite.adapter.execute(context, {
      kind: "rpc",
      functionName: "add_org_member",
      args: { _organization_id: ORG, _email: "person@example.test", _role: "staff" },
    })).resolves.toBe(MEMBERSHIP);
    expect(invite.calls[1]?.sql).toBe(
      "select clinical_core.add_org_member($1,$2,$3) as membership_id",
    );
    expect(invite.fallback.execute).not.toHaveBeenCalled();

    const claim = harness({ activated: 1 });
    await expect(claim.adapter.execute(context, {
      kind: "rpc", functionName: "activate_my_memberships", args: {},
    })).resolves.toBe(1);
    expect(claim.calls[1]?.sql).toBe(
      "select clinical_core.activate_my_memberships() as activated",
    );
    expect(claim.fallback.execute).not.toHaveBeenCalled();
  });

  it("refuses invalid or cross-tenant workforce invitations before Aurora", async () => {
    const test = harness();
    await expect(test.adapter.execute(context, {
      kind: "rpc", functionName: "add_org_member",
      args: { _organization_id: ORG, _email: "not-an-email", _role: "staff" },
    })).rejects.toEqual(new ProductionDesktopError("request_invalid"));
    await expect(test.adapter.execute(context, {
      kind: "rpc", functionName: "add_org_member",
      args: {
        _organization_id: "99999999-9999-4999-8999-999999999999",
        _email: "person@example.test", _role: "staff",
      },
    })).rejects.toEqual(new ProductionDesktopError("request_invalid"));
    expect(test.calls).toHaveLength(2);
  });

  it("creates a review task with a bounded production payload", async () => {
    const test = harness({ id: QUEUE_ITEM, status: "open", audit_event_id: AUDIT });
    const result = await test.adapter.execute(context, {
      kind: "rpc",
      functionName: "create_review_task",
      args: {
        _patient_id: PATIENT,
        _title: "Review abnormal hs-CRP",
        _item_type: "abnormal_result",
        _priority: "high",
        _ref_id: OBSERVATION,
      },
    });
    expect(result).toMatchObject({ id: QUEUE_ITEM, status: "open" });
    expect(test.calls[1]?.sql).toContain("clinical_core.create_review_task");
    expect(test.calls[1]?.values).toEqual([
      { kind: "uuid", value: PATIENT }, "Review abnormal hs-CRP",
      "abnormal_result", "high", { kind: "uuid", value: OBSERVATION },
    ]);
  });

  it("lists the tenant review queue and resolves an item idempotently through AWS", async () => {
    const listTest = harness({
      id: QUEUE_ITEM,
      item_type: "abnormal_result",
      title: "Review marker",
      priority: "high",
      status: "open",
      patient_id: PATIENT,
      patient_name: "Test Patient",
      assignee_name: null,
      due_at: null,
      created_at: "2026-08-20T00:00:00.000Z",
    });
    await expect(listTest.adapter.execute(context, {
      kind: "rpc", functionName: "list_review_queue", args: { _organization_id: ORG },
    })).resolves.toEqual([expect.objectContaining({ id: QUEUE_ITEM, patient_id: PATIENT })]);
    expect(listTest.calls[1]?.sql).toBe("select * from clinical_core.list_review_queue($1)");

    const resolveTest = harness({
      id: QUEUE_ITEM,
      status: "resolved",
      previous_status: "open",
      already_resolved: false,
      audit_event_id: AUDIT,
    });
    await expect(resolveTest.adapter.execute(context, {
      kind: "rpc",
      functionName: "resolve_review_queue_item",
      args: { _item_id: QUEUE_ITEM, _note: "Reviewed in chart" },
    })).resolves.toMatchObject({ id: QUEUE_ITEM, status: "resolved", already_resolved: false });
    expect(resolveTest.calls[1]?.sql).toContain("clinical_core.resolve_review_queue_item");
  });

  it("refuses cross-tenant queue reads and oversized task notes", async () => {
    const test = harness();
    await expect(test.adapter.execute(context, {
      kind: "rpc",
      functionName: "list_review_queue",
      args: { _organization_id: "99999999-9999-4999-8999-999999999999" },
    })).rejects.toEqual(new ProductionDesktopError("request_invalid"));
    await expect(test.adapter.execute(context, {
      kind: "rpc",
      functionName: "resolve_review_queue_item",
      args: { _item_id: QUEUE_ITEM, _note: "x".repeat(501) },
    })).rejects.toEqual(new ProductionDesktopError("request_invalid"));
    expect(test.calls.every((call) => call.sql.includes("clinical_private.set_request_context"))).toBe(true);
  });

  it("reads only a bounded tenant calendar through the production function", async () => {
    const test = harness({ appointments: [], practitioners: [], patients: [] });
    await expect(test.adapter.execute(context, {
      kind: "rpc",
      functionName: "get_desktop_calendar",
      args: {
        _organization_id: ORG,
        _from: "2026-08-20T00:00:00.000Z",
        _to: "2026-08-27T00:00:00.000Z",
      },
    })).resolves.toMatchObject({ appointments: [], practitioners: [], patients: [] });
    expect(test.calls[1]?.sql).toBe("select clinical_core.get_desktop_calendar($1,$2,$3) as data");
    expect(test.calls[1]?.values).toEqual([
      { kind: "uuid", value: ORG }, "2026-08-20T00:00:00.000Z", "2026-08-27T00:00:00.000Z",
    ]);
  });

  it("books an appointment with exact bounded fields and nullable patient handling", async () => {
    const test = harness({ id: APPOINTMENT, status: "scheduled" });
    await expect(test.adapter.execute(context, {
      kind: "rpc",
      functionName: "book_appointment",
      args: {
        _organization_id: ORG,
        _practitioner_user_id: PERSON,
        _appointment_type: "lab-review",
        _starts_at: "2026-08-21T17:00:00.000Z",
        _ends_at: "2026-08-21T17:30:00.000Z",
        _patient_id: PATIENT,
        _location: null,
        _telehealth_url: "https://meet.example.test/session",
        _title: "Lab review",
      },
    })).resolves.toMatchObject({ id: APPOINTMENT, status: "scheduled" });
    expect(test.calls[1]?.sql).toContain("clinical_core.book_appointment");
    expect(test.calls[1]?.values).toEqual([
      { kind: "uuid", value: ORG }, { kind: "uuid", value: PERSON }, "lab-review",
      "2026-08-21T17:00:00.000Z", "2026-08-21T17:30:00.000Z",
      { kind: "uuid", value: PATIENT }, null, "https://meet.example.test/session", "Lab review",
    ]);
  });

  it("uses the governed transition, compatibility update, and reschedule functions", async () => {
    const transition = harness({ id: APPOINTMENT, status: "confirmed", version: 2, already_applied: false });
    await transition.adapter.execute(context, {
      kind: "rpc",
      functionName: "transition_appointment",
      args: {
        _appointment_id: APPOINTMENT,
        _to_status: "confirmed",
        _expected_version: 1,
        _idempotency_key: "frontdesk-confirm-001",
        _reason: null,
      },
    });
    expect(transition.calls[1]?.sql).toContain("clinical_core.transition_appointment");
    expect(transition.calls[1]?.values).toEqual([
      { kind: "uuid", value: APPOINTMENT }, "confirmed", 1, "frontdesk-confirm-001", null,
    ]);

    const update = harness({ id: APPOINTMENT, status: "arrived", already_set: false });
    await update.adapter.execute(context, {
      kind: "rpc",
      functionName: "update_appointment_status",
      args: { _appointment_id: APPOINTMENT, _status: "arrived" },
    });
    expect(update.calls[1]?.sql).toContain("clinical_core.update_appointment_status");

    const reschedule = harness({ id: APPOINTMENT, status: "confirmed" });
    await reschedule.adapter.execute(context, {
      kind: "rpc",
      functionName: "reschedule_appointment",
      args: {
        _appointment_id: APPOINTMENT,
        _starts_at: "2026-08-22T17:00:00.000Z",
        _ends_at: "2026-08-22T17:30:00.000Z",
      },
    });
    expect(reschedule.calls[1]?.sql).toContain("clinical_core.reschedule_appointment");
  });

  it("requires a bounded reason for terminal appointment correction", async () => {
    const correction = harness({ id: APPOINTMENT, status: "confirmed", version: 3 });
    await expect(correction.adapter.execute(context, {
      kind: "rpc",
      functionName: "correct_appointment_status",
      args: {
        _appointment_id: APPOINTMENT,
        _to_status: "confirmed",
        _reason: "Front desk selected the wrong terminal status.",
        _expected_version: 2,
      },
    })).resolves.toMatchObject({ id: APPOINTMENT, status: "confirmed" });
    expect(correction.calls[1]?.values).toEqual([
      { kind: "uuid", value: APPOINTMENT }, "confirmed",
      "Front desk selected the wrong terminal status.", 2,
    ]);

    const invalidCorrection = harness();
    await expect(invalidCorrection.adapter.execute(context, {
      kind: "rpc",
      functionName: "correct_appointment_status",
      args: {
        _appointment_id: APPOINTMENT,
        _to_status: "scheduled",
        _reason: "",
        _expected_version: 1,
      },
    })).rejects.toEqual(new ProductionDesktopError("request_invalid"));
    expect(invalidCorrection.calls).toHaveLength(1);
  });

  it("refuses cross-tenant, malformed-time, and invalid-version scheduling requests", async () => {
    const test = harness();
    await expect(test.adapter.execute(context, {
      kind: "rpc",
      functionName: "get_desktop_calendar",
      args: {
        _organization_id: "99999999-9999-4999-8999-999999999999",
        _from: "2026-08-20T00:00:00.000Z",
        _to: "2026-08-27T00:00:00.000Z",
      },
    })).rejects.toEqual(new ProductionDesktopError("request_invalid"));
    await expect(test.adapter.execute(context, {
      kind: "rpc",
      functionName: "reschedule_appointment",
      args: { _appointment_id: APPOINTMENT, _starts_at: "tomorrow", _ends_at: "later" },
    })).rejects.toEqual(new ProductionDesktopError("request_invalid"));
    await expect(test.adapter.execute(context, {
      kind: "rpc",
      functionName: "transition_appointment",
      args: {
        _appointment_id: APPOINTMENT,
        _to_status: "confirmed",
        _expected_version: 0,
        _idempotency_key: null,
        _reason: null,
      },
    })).rejects.toEqual(new ProductionDesktopError("request_invalid"));
    expect(test.calls).toHaveLength(3);
  });

  it("starts and completes a governed encounter using bounded references", async () => {
    const start = harness({ id: ENCOUNTER });
    await expect(start.adapter.execute(context, {
      kind: "rpc",
      functionName: "start_encounter",
      args: {
        _organization_id: ORG, _patient_id: PATIENT, _visit_type: "lab-review",
        _appointment_id: APPOINTMENT,
      },
    })).resolves.toBe(ENCOUNTER);
    expect(start.calls[1]?.sql).toContain("clinical_core.start_encounter");
    expect(start.calls[1]?.values).toEqual([
      { kind: "uuid", value: ORG }, { kind: "uuid", value: PATIENT }, "lab-review",
      { kind: "uuid", value: APPOINTMENT },
    ]);

    const complete = harness({});
    await expect(complete.adapter.execute(context, {
      kind: "rpc",
      functionName: "set_encounter_status",
      args: { _encounter_id: ENCOUNTER, _status: "completed", _reason: null },
    })).resolves.toBeNull();
    expect(complete.calls[1]?.sql).toContain("clinical_core.set_encounter_status");
  });

  it("saves a versioned note with structured content and governed provenance", async () => {
    const test = harness({ note_id: NOTE, version: 1, saved_at: "2026-08-20T20:00:00.000Z" });
    await expect(test.adapter.execute(context, {
      kind: "rpc",
      functionName: "save_note_draft",
      args: {
        _organization_id: ORG,
        _encounter_id: ENCOUNTER,
        _note_type: "soap",
        _content: { subjective: "Synthetic symptom history", assessment: "Synthetic assessment" },
        _expected_version: 0,
        _note_id: null,
        _save_kind: "manual",
        _provenance: [{
          sectionKey: "assessment", refType: "lab_observation", refId: OBSERVATION,
          label: "Synthetic hs-CRP observation",
        }],
      },
    })).resolves.toMatchObject({ note_id: NOTE, version: 1 });
    expect(test.calls[1]?.sql).toContain("clinical_core.save_note_draft");
    expect(test.calls[1]?.values[3]).toBe(JSON.stringify({
      subjective: "Synthetic symptom history", assessment: "Synthetic assessment",
    }));
    expect(test.calls[1]?.values[7]).toBe(JSON.stringify([{
      sectionKey: "assessment", refType: "lab_observation", refId: OBSERVATION,
      label: "Synthetic hs-CRP observation",
    }]));
  });

  it("moves a note through review, idempotent signing, addendum, and error functions", async () => {
    const ready = harness({});
    await expect(ready.adapter.execute(context, {
      kind: "rpc", functionName: "mark_note_ready", args: { _note_id: NOTE },
    })).resolves.toBeNull();

    const sign = harness({ signature_id: AUDIT, already_signed: false, version: 2 });
    await expect(sign.adapter.execute(context, {
      kind: "rpc", functionName: "sign_note", args: { _note_id: NOTE, _expected_version: 2 },
    })).resolves.toMatchObject({ signature_id: AUDIT, version: 2 });
    expect(sign.calls[1]?.values).toEqual([{ kind: "uuid", value: NOTE }, 2]);

    const addendum = harness({ id: QUEUE_ITEM });
    await expect(addendum.adapter.execute(context, {
      kind: "rpc",
      functionName: "add_note_addendum",
      args: { _note_id: NOTE, _reason: "Correction", _content: "Synthetic corrected context" },
    })).resolves.toBe(QUEUE_ITEM);

    const error = harness({});
    await expect(error.adapter.execute(context, {
      kind: "rpc", functionName: "mark_note_error",
      args: { _note_id: NOTE, _reason: "Wrong synthetic patient selected" },
    })).resolves.toBeNull();
  });

  it("reads bounded encounter, note, patient encounter, and timeline DTOs", async () => {
    const encounter = harness({ encounter: { encounter_id: ENCOUNTER }, notes: [] });
    await expect(encounter.adapter.execute(context, {
      kind: "rpc", functionName: "get_desktop_encounter", args: { _encounter_id: ENCOUNTER },
    })).resolves.toMatchObject({ encounter: { encounter_id: ENCOUNTER } });

    const note = harness({ note: { note_id: NOTE }, content: {}, addenda: [], provenance: [] });
    await expect(note.adapter.execute(context, {
      kind: "rpc", functionName: "get_desktop_note", args: { _note_id: NOTE },
    })).resolves.toMatchObject({ note: { note_id: NOTE } });

    const list = harness([{ encounter_id: ENCOUNTER }]);
    await expect(list.adapter.execute(context, {
      kind: "rpc", functionName: "list_desktop_patient_encounters",
      args: { _patient_id: PATIENT, _limit: 100 },
    })).resolves.toEqual([{ encounter_id: ENCOUNTER }]);

    const timeline = harness({ event_at: "2026-08-20T20:00:00.000Z", event_type: "note.signed" });
    await expect(timeline.adapter.execute(context, {
      kind: "rpc", functionName: "get_desktop_patient_timeline",
      args: { _patient_id: PATIENT, _limit: 200 },
    })).resolves.toEqual([expect.objectContaining({ event_type: "note.signed" })]);
  });

  it("reads the bounded production patient overview without contact values", async () => {
    const test = harness({
      patientId: PATIENT,
      demographics: {
        fullName: "Synthetic Patient", dateOfBirth: null, sex: "unknown",
        hasEmail: false, hasPhone: false,
      },
      careTeam: [], allergies: [], medications: [], conditions: [],
      recentAppointments: [], recentEncounters: [],
      labs: { latestCollectedAt: null, markerCount: 0, awaitingReview: 0, abnormal: 0, recent: [] },
      openTasks: [], carePlan: null, wearableSources: [],
      missingInformation: ["No allergy list recorded"],
      changesSinceLastVisit: { anchorEncounterAt: null, items: [] },
    });
    await expect(test.adapter.execute(context, {
      kind: "rpc", functionName: "get_patient_overview",
      args: { _organization_id: ORG, _patient_id: PATIENT },
    })).resolves.toMatchObject({ patientId: PATIENT, demographics: { hasEmail: false, hasPhone: false } });
    expect(test.calls[1]?.sql).toBe("select clinical_core.get_patient_overview($1,$2) as data");
  });

  it("reads consent-scoped patient-reported V2 intake through the exact patient boundary", async () => {
    const test = harness({
      patientId: PATIENT, connectionState: "verified", sharingStatus: "granted",
      wellnessProfile: { payload: { goals: ["synthetic longevity"] }, receivedAt: "2026-08-25T10:00:00Z" },
      lifestyleProfile: null, contraindications: null, clinicalIntake: null,
      questionnaireResponses: [], generatedAt: "2026-08-25T10:00:01Z",
    });
    await expect(test.adapter.execute(context, {
      kind: "rpc", functionName: "get_patient_app_intake",
      args: { _organization_id: ORG, _patient_id: PATIENT },
    })).resolves.toMatchObject({ patientId: PATIENT, sharingStatus: "granted" });
    expect(test.calls[1]?.sql).toBe("select clinical_core.get_patient_app_intake($1,$2) as data");
    expect(test.fallback.execute).not.toHaveBeenCalled();
  });

  it("routes the governed patient-sync control plane without provider-specific fallback", async () => {
    const operations: Array<{ functionName: string; args: Record<string, unknown>; sql: string }> = [
      {
        functionName: "get_patient_sync_overview", args: { _patient_id: PATIENT },
        sql: "select clinical_core.get_patient_sync_overview($1) as data",
      },
      {
        functionName: "get_org_sync_operations", args: { _organization_id: ORG },
        sql: "select clinical_core.get_org_sync_operations($1) as data",
      },
      {
        functionName: "create_sync_invitation", args: { _organization_id: ORG, _patient_id: PATIENT },
        sql: "select clinical_core.create_sync_invitation($1,$2) as data",
      },
      {
        functionName: "pause_sync_connection", args: { _connection_id: CONNECTION, _expected_version: 1 },
        sql: "select clinical_core.pause_sync_connection($1,$2) as data",
      },
      {
        functionName: "resume_sync_connection", args: { _connection_id: CONNECTION, _expected_version: 2 },
        sql: "select clinical_core.resume_sync_connection($1,$2) as data",
      },
      {
        functionName: "revoke_sync_connection",
        args: { _connection_id: CONNECTION, _expected_version: 3, _reason: "patient request" },
        sql: "select clinical_core.revoke_sync_connection($1,$2,$3) as data",
      },
      {
        functionName: "set_sync_consent_scope",
        args: {
          _connection_id: CONNECTION, _scope: "lab_results_import", _grant: true,
          _artifact_title: "Laboratory data import", _artifact_version: "1.0",
          _jurisdiction: "US", _method: "in_person", _authority: "self",
        },
        sql: "select clinical_core.set_sync_consent_scope($1,$2,$3,$4,$5,$6,$7,$8) as data",
      },
    ];
    for (const operation of operations) {
      const test = harness({ ok: true });
      await expect(test.adapter.execute(context, {
        kind: "rpc", functionName: operation.functionName, args: operation.args,
      })).resolves.toEqual({ ok: true });
      expect(test.calls[1]?.sql).toBe(operation.sql);
      expect(test.fallback.execute).not.toHaveBeenCalled();
    }
  });

  it("rejects cross-tenant sync operations and unreasoned revocation before Aurora", async () => {
    const test = harness();
    await expect(test.adapter.execute(context, {
      kind: "rpc", functionName: "get_org_sync_operations",
      args: { _organization_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
    })).rejects.toEqual(new ProductionDesktopError("request_invalid"));
    await expect(test.adapter.execute(context, {
      kind: "rpc", functionName: "revoke_sync_connection",
      args: { _connection_id: CONNECTION, _expected_version: 1, _reason: "" },
    })).rejects.toEqual(new ProductionDesktopError("request_invalid"));
    expect(test.calls).toHaveLength(2);
    expect(test.calls.every((call) => call.sql.includes("clinical_private.set_request_context"))).toBe(true);
  });

  it("routes patient protocol reads and explicit lifecycle actions through AWS-native functions", async () => {
    const operations: Array<{ functionName: string; args: Record<string, unknown>; sql: string }> = [
      {
        functionName: "get_patient_protocol",
        args: { _organization_id: ORG, _patient_id: PATIENT },
        sql: "select clinical_core.get_patient_protocol($1,$2) as data",
      },
      {
        functionName: "create_protocol_draft",
        args: { _organization_id: ORG, _patient_id: PATIENT, _title: "Synthetic care plan", _from_template_id: null },
        sql: "select clinical_core.create_protocol_draft($1,$2,$3,$4) as data",
      },
      {
        functionName: "approve_protocol_version",
        args: { _version_id: PROTOCOL_VERSION, _review_note: "Reviewed synthetic plan" },
        sql: "select clinical_core.approve_protocol_version($1,$2) as data",
      },
      {
        functionName: "activate_protocol_version",
        args: { _version_id: PROTOCOL_VERSION },
        sql: "select clinical_core.activate_protocol_version($1) as data",
      },
      {
        functionName: "set_protocol_lifecycle",
        args: { _protocol_id: PROTOCOL, _status: "paused", _reason: "Synthetic pause" },
        sql: "select clinical_core.set_protocol_lifecycle($1,$2,$3) as data",
      },
      {
        functionName: "revise_protocol_version",
        args: { _version_id: PROTOCOL_VERSION },
        sql: "select clinical_core.revise_protocol_version($1) as data",
      },
    ];
    for (const operation of operations) {
      const test = harness({ ok: true });
      await expect(test.adapter.execute(context, {
        kind: "rpc", functionName: operation.functionName, args: operation.args,
      })).resolves.toEqual({ ok: true });
      expect(test.calls[1]?.sql).toBe(operation.sql);
      expect(test.fallback.execute).not.toHaveBeenCalled();
    }
  });

  it("routes the seven governed catalog operations through AWS-native functions", async () => {
    const operations: Array<{ functionName: string; args: Record<string, unknown>; sql: string }> = [
      {
        functionName: "get_product_catalog",
        args: { _organization_id: ORG, _query: null, _status: null, _limit: 100 },
        sql: "select clinical_core.get_product_catalog($1,$2,$3,$4) as data",
      },
      {
        functionName: "get_product_label_detail",
        args: { _label_version_id: CATALOG_VERSION },
        sql: "select clinical_core.get_product_label_detail($1) as data",
      },
      {
        functionName: "get_protocol_template_detail",
        args: { _template_id: "tpl_foundation_protocol" },
        sql: "select clinical_core.get_protocol_template_detail($1) as data",
      },
      {
        functionName: "compare_protocol_template_versions",
        args: { _left_version_id: TEMPLATE_VERSION, _right_version_id: OTHER_TEMPLATE_VERSION },
        sql: "select clinical_core.compare_protocol_template_versions($1,$2) as data",
      },
      {
        functionName: "record_protocol_template_safety_review",
        args: { _version_id: TEMPLATE_VERSION, _outcome: "concerns", _note: "Requires practitioner review" },
        sql: "select clinical_core.record_protocol_template_safety_review($1,$2,$3) as data",
      },
      {
        functionName: "supersede_protocol_template",
        args: { _template_id: "tpl_foundation_protocol", _successor_template_id: "tpl_foundation_protocol_v2", _reason: "Reviewed replacement" },
        sql: "select clinical_core.supersede_protocol_template($1,$2,$3) as data",
      },
    ];
    for (const operation of operations) {
      const test = harness({ ok: true });
      await expect(test.adapter.execute(context, {
        kind: "rpc", functionName: operation.functionName, args: operation.args,
      })).resolves.toEqual({ ok: true });
      expect(test.calls[1]?.sql).toBe(operation.sql);
      expect(test.fallback.execute).not.toHaveBeenCalled();
    }

    const verify = harness();
    await expect(verify.adapter.execute(context, {
      kind: "rpc", functionName: "verify_product_label_version",
      args: { _label_version_id: CATALOG_VERSION, _verification_note: "Exact label reviewed" },
    })).resolves.toBeNull();
    expect(verify.calls[1]?.sql).toBe("select clinical_core.verify_product_label_version($1,$2)");
  });

  it("routes the organization-template and interaction contracts through AWS rather than fallback", async () => {
    const operations: Array<{ functionName: string; args: Record<string, unknown>; sql: string }> = [
      { functionName: "list_protocol_templates", args: { _organization_id: ORG, _include_archived: false },
        sql: "select clinical_core.list_protocol_templates($1,$2) as data" },
      { functionName: "create_protocol_template", args: { _organization_id: ORG, _name: "Foundation", _description: null, _from_version_id: null },
        sql: "select clinical_core.create_protocol_template($1,$2,$3,$4) as data" },
      { functionName: "approve_protocol_template_version", args: { _version_id: TEMPLATE_VERSION },
        sql: "select clinical_core.approve_protocol_template_version($1) as data" },
      { functionName: "archive_protocol_template", args: { _template_id: TEMPLATE, _archived: true },
        sql: "select clinical_core.archive_protocol_template($1,$2) as data" },
      { functionName: "search_protocol_catalog", args: { _organization_id: ORG, _query: "magnesium", _limit: 20 },
        sql: "select clinical_core.search_protocol_catalog($1,$2,$3) as data" },
      { functionName: "check_protocol_interactions", args: { _version_id: PROTOCOL_VERSION },
        sql: "select clinical_core.check_protocol_interactions($1) as data" },
      { functionName: "review_protocol_item_interactions", args: { _item_id: PROTOCOL_ITEM, _note: null },
        sql: "select clinical_core.review_protocol_item_interactions($1,$2) as data" },
    ];
    for (const operation of operations) {
      const test = harness({ ok: true });
      await expect(test.adapter.execute(context, { kind: "rpc", ...operation })).resolves.toEqual({ ok: true });
      expect(test.calls[1]?.sql).toBe(operation.sql);
      expect(test.fallback.execute).not.toHaveBeenCalled();
    }
  });

  it("routes bounded reasoning and Lens reads through the AWS clinical core", async () => {
    const operations: Array<{ functionName: string; args: Record<string, unknown>; sql: string }> = [
      { functionName: "get_reasoning_workspace", args: { _organization_id: ORG, _patient_id: PATIENT },
        sql: "select clinical_core.get_reasoning_workspace($1,$2) as data" },
      { functionName: "list_desktop_lens_paradigms", args: {}, sql: "select clinical_core.list_desktop_lens_paradigms() as data" },
      { functionName: "list_desktop_lens_domains", args: {}, sql: "select clinical_core.list_desktop_lens_domains() as data" },
      { functionName: "list_desktop_lens_knowledge_sources", args: {}, sql: "select clinical_core.list_desktop_lens_knowledge_sources() as data" },
      { functionName: "get_desktop_lens_evaluation", args: { _encounter_id: ENCOUNTER, _paradigm: "functional" },
        sql: "select clinical_core.get_desktop_lens_evaluation($1,$2) as data" },
      { functionName: "list_desktop_question_answers", args: { _question_id: QUESTION },
        sql: "select clinical_core.list_desktop_question_answers($1) as data" },
    ];
    for (const operation of operations) {
      const test = harness([]);
      await expect(test.adapter.execute(context, { kind: "rpc", ...operation })).resolves.toEqual([]);
      expect(test.calls[1]?.sql).toBe(operation.sql);
      expect(test.fallback.execute).not.toHaveBeenCalled();
    }
  });

  it("routes attributable reasoning and Lens review actions and rejects fabricated states", async () => {
    const review = harness({ ok: true, state: "needs_data" });
    await expect(review.adapter.execute(context, { kind: "rpc", functionName: "review_hypothesis",
      args: { _hypothesis_id: HYPOTHESIS, _action: "needs_data", _note: "Repeat source measurement" },
    })).resolves.toMatchObject({ state: "needs_data" });
    expect(review.calls[1]?.sql).toBe("select clinical_core.review_hypothesis($1,$2,$3) as data");

    for (const [functionName, args, sql] of [
      ["set_question_status", { _question_id: QUESTION, _to: "asked", _reason: null }, "select clinical_core.set_question_status($1,$2,$3)"],
      ["dismiss_question", { _question_id: QUESTION, _feedback_kind: "not_relevant", _comment: "Already reviewed" }, "select clinical_core.dismiss_question($1,$2,$3)"],
      ["record_question_note_use", { _question_id: QUESTION, _note_id: NOTE }, "select clinical_core.record_question_note_use($1,$2)"],
      ["submit_question_feedback", { _question_id: QUESTION, _kind: "helpful", _comment: null }, "select clinical_core.submit_question_feedback($1,$2,$3)"],
      ["review_safety_block", { _block_id: SAFETY_BLOCK, _resolution: "Reviewed with source data" }, "select clinical_core.review_safety_block($1,$2)"],
    ] as const) {
      const test = harness();
      await expect(test.adapter.execute(context, { kind: "rpc", functionName, args })).resolves.toBeNull();
      expect(test.calls[1]?.sql).toBe(sql);
    }
    const answer = harness(1);
    await expect(answer.adapter.execute(context, { kind: "rpc", functionName: "answer_question",
      args: { _question_id: QUESTION, _answer: { text: "Reviewed answer" } },
    })).resolves.toBe(1);
    const correction = harness(2);
    await expect(correction.adapter.execute(context, { kind: "rpc", functionName: "correct_question_answer",
      args: { _question_id: QUESTION, _answer: { text: "Corrected answer" }, _reason: "Source corrected" },
    })).resolves.toBe(2);

    const refused = harness();
    await expect(refused.adapter.execute(context, { kind: "rpc", functionName: "review_hypothesis",
      args: { _hypothesis_id: HYPOTHESIS, _action: "auto_approve", _note: null },
    })).rejects.toEqual(new ProductionDesktopError("request_invalid"));
    expect(refused.calls).toHaveLength(1);
  });

  it("refuses malformed catalog identifiers and ungoverned review assertions before Aurora", async () => {
    const test = harness();
    await expect(test.adapter.execute(context, {
      kind: "rpc", functionName: "get_protocol_template_detail", args: { _template_id: "not-governed" },
    })).rejects.toEqual(new ProductionDesktopError("request_invalid"));
    await expect(test.adapter.execute(context, {
      kind: "rpc", functionName: "record_protocol_template_safety_review",
      args: { _version_id: TEMPLATE_VERSION, _outcome: "auto_approved", _note: "No" },
    })).rejects.toEqual(new ProductionDesktopError("request_invalid"));
    await expect(test.adapter.execute(context, {
      kind: "rpc", functionName: "verify_product_label_version",
      args: { _label_version_id: CATALOG_VERSION, _verification_note: "" },
    })).rejects.toEqual(new ProductionDesktopError("request_invalid"));
    expect(test.calls).toHaveLength(3);
  });

  it("sanitizes protocol drafts and never trusts commercial or product-review assertions", async () => {
    const test = harness({ ok: true, versionId: PROTOCOL_VERSION });
    await expect(test.adapter.execute(context, {
      kind: "rpc",
      functionName: "save_protocol_draft",
      args: {
        _version_id: PROTOCOL_VERSION,
        _expected_updated_at: "2026-08-24T20:00:00.000Z",
        _payload: {
          title: "Synthetic plan",
          phases: [{ name: "Foundation", relativeStartDay: 0, relativeDurationDays: 30 }],
          items: [{
            kind: "monitoring", label: "Review synthetic laboratory trend", phaseIndex: 0,
            instructions: "Review before any clinical change.", verificationStatus: "unverified",
            affiliateUrl: null,
          }],
        },
      },
    })).resolves.toMatchObject({ ok: true });
    expect(test.calls[1]?.sql).toBe("select clinical_core.save_protocol_draft($1,$2::jsonb,$3) as data");
    expect(JSON.parse(test.calls[1]?.values[1] as string)).toMatchObject({
      items: [expect.objectContaining({
        kind: "monitoring", verificationStatus: "unverified", affiliateUrl: null,
      })],
    });

    const commercial = harness();
    await expect(commercial.adapter.execute(context, {
      kind: "rpc", functionName: "save_protocol_draft",
      args: {
        _version_id: PROTOCOL_VERSION, _expected_updated_at: null,
        _payload: {
          phases: [], items: [{
            kind: "product", label: "Synthetic product", phaseIndex: null,
            catalogProductId: "prd_synthetic_product", catalogProductVersionId: "1",
            verificationStatus: "structured_verified", affiliateUrl: "https://example.test/buy",
          }],
        },
      },
    })).rejects.toEqual(new ProductionDesktopError("request_invalid"));
    expect(commercial.calls).toHaveLength(1);
  });

  it("rejects cross-tenant protocol access, invalid lifecycle states, and unbounded drafts before Aurora", async () => {
    const test = harness();
    await expect(test.adapter.execute(context, {
      kind: "rpc", functionName: "get_patient_protocol",
      args: { _organization_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", _patient_id: PATIENT },
    })).rejects.toEqual(new ProductionDesktopError("request_invalid"));
    await expect(test.adapter.execute(context, {
      kind: "rpc", functionName: "set_protocol_lifecycle",
      args: { _protocol_id: PROTOCOL, _status: "auto_activated", _reason: null },
    })).rejects.toEqual(new ProductionDesktopError("request_invalid"));
    await expect(test.adapter.execute(context, {
      kind: "rpc", functionName: "save_protocol_draft",
      args: {
        _version_id: PROTOCOL_VERSION, _expected_updated_at: null,
        _payload: { phases: [], items: Array.from({ length: 201 }, (_, index) => ({
          kind: "monitoring", label: `Item ${index}`,
        })) },
      },
    })).rejects.toEqual(new ProductionDesktopError("request_invalid"));
    expect(test.calls).toHaveLength(3);
  });

  it("routes the seven durable sync controls through exact production functions", async () => {
    const queue = harness({ ok: true, eventId: SYNC_EVENT, state: "queued", deliveryEnabled: false });
    await expect(queue.adapter.execute(context, { kind: "rpc", functionName: "queue_sync_export", args: {
      _connection_id: CONNECTION, _resource_type: "lab_summary", _resource_id: PATIENT,
    } })).resolves.toMatchObject({ state: "queued", deliveryEnabled: false });
    expect(queue.calls[1]?.sql).toBe("select clinical_core.queue_sync_export($1,$2,$3) as data");

    const withdraw = harness({ ok: true, eventId: SYNC_EVENT, acknowledged: false });
    await withdraw.adapter.execute(context, { kind: "rpc", functionName: "withdraw_sync_resource", args: {
      _connection_id: CONNECTION, _resource_type: "lab_summary", _resource_id: PATIENT,
      _reason: "Patient requested withdrawal",
    } });
    expect(withdraw.calls[1]?.values).toEqual([
      { kind: "uuid", value: CONNECTION }, "lab_summary", { kind: "uuid", value: PATIENT },
      "Patient requested withdrawal",
    ]);

    for (const functionName of ["retry_sync_event", "cancel_sync_event"] as const) {
      const test = harness({ ok: true, eventId: SYNC_EVENT });
      await test.adapter.execute(context, { kind: "rpc", functionName, args: {
        _event_id: SYNC_EVENT, _reason: "Operator reviewed the event",
      } });
      expect(test.calls[1]?.sql).toBe(`select clinical_core.${functionName}($1,$2) as data`);
    }

    const conflict = harness({ ok: true, conflictId: SYNC_CONFLICT, version: 2 });
    await conflict.adapter.execute(context, { kind: "rpc", functionName: "resolve_sync_conflict", args: {
      _conflict_id: SYNC_CONFLICT, _resolution: "resolved_keep_desktop",
      _note: "Desktop record retained after clinical review", _expected_version: 1,
    } });
    expect(conflict.calls[1]?.values[3]).toBe(1);

    const review = harness({ ok: true, eventId: SYNC_EVENT, state: "accepted", chartMaterialized: false });
    await expect(review.adapter.execute(context, { kind: "rpc", functionName: "review_sync_inbound", args: {
      _event_id: SYNC_EVENT, _action: "accept", _note: null,
    } })).resolves.toMatchObject({ chartMaterialized: false });

    const correction = harness({ ok: true, correctionId: QUEUE_ITEM, version: 1 });
    await correction.adapter.execute(context, { kind: "rpc", functionName: "record_sync_inbound_correction", args: {
      _inbound_event_id: SYNC_EVENT, _overlay: { markerName: "Corrected marker", value: 42 },
      _reason: "Corrected transcription after source review",
    } });
    expect(JSON.parse(correction.calls[1]?.values[1] as string)).toEqual({ markerName: "Corrected marker", value: 42 });
  });

  it("refuses unsupported exports, incomplete reviews, and unsafe correction overlays before Aurora", async () => {
    const test = harness();
    await expect(test.adapter.execute(context, { kind: "rpc", functionName: "queue_sync_export", args: {
      _connection_id: CONNECTION, _resource_type: "supplement_order", _resource_id: PATIENT,
    } })).rejects.toEqual(new ProductionDesktopError("request_invalid"));
    await expect(test.adapter.execute(context, { kind: "rpc", functionName: "review_sync_inbound", args: {
      _event_id: SYNC_EVENT, _action: "reject", _note: null,
    } })).rejects.toEqual(new ProductionDesktopError("request_invalid"));
    await expect(test.adapter.execute(context, { kind: "rpc", functionName: "record_sync_inbound_correction", args: {
      _inbound_event_id: SYNC_EVENT, _overlay: { access_token: "must-not-pass" }, _reason: "Unsafe",
    } })).rejects.toEqual(new ProductionDesktopError("request_invalid"));
    expect(test.calls).toHaveLength(3);
  });

  it("rejects cross-tenant notes, nested content, invalid provenance, and oversized corrections", async () => {
    const test = harness();
    await expect(test.adapter.execute(context, {
      kind: "rpc", functionName: "start_encounter",
      args: {
        _organization_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        _patient_id: PATIENT, _visit_type: "initial", _appointment_id: null,
      },
    })).rejects.toEqual(new ProductionDesktopError("request_invalid"));
    await expect(test.adapter.execute(context, {
      kind: "rpc", functionName: "save_note_draft",
      args: {
        _organization_id: ORG, _encounter_id: ENCOUNTER, _note_type: "soap",
        _content: { assessment: { nested: "refused" } }, _expected_version: 0,
        _note_id: null, _save_kind: "manual", _provenance: [],
      },
    })).rejects.toEqual(new ProductionDesktopError("request_invalid"));
    await expect(test.adapter.execute(context, {
      kind: "rpc", functionName: "save_note_draft",
      args: {
        _organization_id: ORG, _encounter_id: ENCOUNTER, _note_type: "soap",
        _content: { assessment: "Synthetic" }, _expected_version: 0,
        _note_id: null, _save_kind: "manual",
        _provenance: [{ sectionKey: "assessment", refType: "unknown", refId: null, label: "No" }],
      },
    })).rejects.toEqual(new ProductionDesktopError("request_invalid"));
    await expect(test.adapter.execute(context, {
      kind: "rpc", functionName: "add_note_addendum",
      args: { _note_id: NOTE, _reason: "x".repeat(501), _content: "Synthetic" },
    })).rejects.toEqual(new ProductionDesktopError("request_invalid"));
    expect(test.calls).toHaveLength(4);
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
