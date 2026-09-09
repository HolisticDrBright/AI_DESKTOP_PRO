import { describe,expect,it,vi } from "vitest";
import { createOwnedConsumerRecordsAdapter,type OwnedRecordWrite } from "./owned-consumer-records";
import { ClinicalCoreDatabaseRejection,type ClinicalCoreDatabase } from "./database";
import type { ProductionClinicalRequestContext } from "./aws-identity-consent";

const id = "d1c7f537-79e9-4c69-8c11-b4d5555e1234";
const context: ProductionClinicalRequestContext = { actorPersonId:id,organizationId:id,identityPool:"consumer",identitySubject:"consumer-acceptance",purpose:"clinical_data",environment:"production-clinical",dataClassification:"clinical_phi",containsPhi:true,realPatientData:true,productionBound:true };
const payload = { id,goals:[],onboardingCompleted:false,role:"patient" };
const input: OwnedRecordWrite = { collection:"wellness_profiles",recordId:id,requestId:id,expectedRevision:0,consentRevision:1,payload,deleted:false };
const time = "2026-09-08T12:00:00Z";
function setup(result: unknown = { recordId:id,revision:1,duplicate:false,receivedAt:time }) {
  const query = vi.fn().mockResolvedValue({rows:[{result}]});
  const transaction = vi.fn(async work => work({query}));
  return { adapter:createOwnedConsumerRecordsAdapter({transaction} as ClinicalCoreDatabase),query,transaction };
}
describe("independent consumer storage adapter",() => {
  it("uses authenticated owner context with no connection or recipient parameter",async () => {
    const s = setup();
    expect(await s.adapter.write(context,input)).toMatchObject({recordId:id,revision:1});
    expect(s.query.mock.calls[0][0]).toContain("set_request_context");
    expect(s.query.mock.calls[1][1]).toHaveLength(7);
    expect(s.query.mock.calls[1][1]).not.toContain(context.identitySubject);
  });
  it("rejects owner injection, unsupported collections, missing fields and sensitive nested keys before DB access",async () => {
    const s = setup();
    for (const value of [{...input,ownerId:id},{...input,connectionId:id},{...input,collection:"lab_defaults"},{...input,payload:{}},{...input,payload:{...payload,goals:[{password:"private"}]}}]) {
      await expect(s.adapter.write(context,value as OwnedRecordWrite)).rejects.toThrow("request_invalid");
    }
    expect(s.transaction).not.toHaveBeenCalled();
  });
  it("rejects workforce and boundary mismatches even with valid input",async () => {
    const s = setup();
    for (const change of [{identityPool:"workforce"},{productionBound:false},{purpose:"identity_link"},{identitySubject:""}]) {
      await expect(s.adapter.write({...context,...change} as ProductionClinicalRequestContext,input)).rejects.toThrow("owner_required");
    }
    expect(s.transaction).not.toHaveBeenCalled();
  });
  it("requires explicit empty tombstones, not an old payload marked deleted",async () => {
    const s = setup();
    await expect(s.adapter.write(context,{...input,deleted:true})).rejects.toThrow("request_invalid");
    await expect(s.adapter.write(context,{...input,deleted:true,payload:{}})).resolves.toMatchObject({revision:1});
  });
  it("returns only validated owned records and strips database-only metadata",async () => {
    const s = setup([{recordId:id,revision:1,payload,receivedAt:time,ownerId:"not exposed"}]);
    expect(await s.adapter.list(context,{collection:"wellness_profiles",limit:20})).toEqual([{recordId:id,revision:1,payload,receivedAt:time}]);
  });
  it("rejects malformed pagination and bad server data",async () => {
    const s = setup([{recordId:id,revision:1,payload:{},receivedAt:time}]);
    await expect(s.adapter.list(context,{collection:"wellness_profiles",limit:101})).rejects.toThrow("request_invalid");
    await expect(s.adapter.list(context,{collection:"wellness_profiles",limit:20,after:{receivedAt:"yesterday",recordId:id}})).rejects.toThrow("request_invalid");
    await expect(s.adapter.list(context,{collection:"wellness_profiles",limit:20})).rejects.toThrow("storage_unavailable");
  });
  it("records consent separately from data and rejects caller-supplied approvals",async () => {
    const s = setup({scope:"wearables",status:"granted",revision:1,releaseVersion:"reviewed/1"});
    const consent = {scope:"wearables" as const,status:"granted" as const,releaseVersion:"reviewed/1",expectedRevision:0};
    await expect(s.adapter.setConsent(context,consent)).rejects.toThrow("owner_required");
    await expect(s.adapter.setConsent({...context,purpose:"consent_management"},{...consent,approvedBy:"caller"} as typeof consent)).rejects.toThrow("request_invalid");
    expect(await s.adapter.setConsent({...context,purpose:"consent_management"},consent)).toMatchObject({revision:1});
  });
  it("preserves actionable conflict/consent codes and hides unexpected database detail",async () => {
    const s = setup();
    for (const category of ["conflict","consent_required","request_invalid"] as const) {
      s.transaction.mockRejectedValueOnce(new ClinicalCoreDatabaseRejection(category));
      await expect(s.adapter.write(context,input)).rejects.toThrow(category);
    }
    s.transaction.mockRejectedValueOnce(new Error("raw health payload and credentials must never escape"));
    await expect(s.adapter.write(context,input)).rejects.toThrow(/^storage_unavailable$/);
  });
});
