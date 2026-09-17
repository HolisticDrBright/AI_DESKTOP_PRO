import {afterEach,beforeEach,describe,it,expect,vi} from "vitest";
import {clinicalLabSpecimenContext} from "./aws-clinical-data.server";
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const selection={patientId:id(1),observationId:id(2),eventId:id(3)},org=id(4);
const record=()=>({version:"lab-specimen-record/1",contextId:id(5),labEventId:id(3),revision:1,payloadSha256:"a".repeat(64),
  labPayloadSha256:"b".repeat(64),receivedAt:"2026-09-16T12:00:00Z",context:{
    source:"patient_reported",verification:"unverified",recordedAt:"2026-09-16T11:00:00Z",observedOn:"2026-09-15",
    ageAtDraw:{value:40,unit:"years"},sex:null,assayId:null,pregnancyStatus:null,pregnancyTrimester:null,cyclePhase:null,reproductiveStage:null,contraception:null,
  }});
const response=(data:unknown,status=200)=>new Response(JSON.stringify({data}),{status});
let fetcher:ReturnType<typeof vi.fn>;
beforeEach(()=>{
  vi.stubEnv("CLINICAL_AWS_WORKFORCE_API_ORIGIN","https://abcdefghij.execute-api.us-east-2.amazonaws.com");
  fetcher=vi.fn().mockResolvedValueOnce(response([{id:id(2),import_event_id:id(3),observed_at:"2026-09-15T00:00:00Z"}]));
  vi.stubGlobal("fetch",fetcher);
});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
describe("patient/observation-bound shared specimen reader",()=>{
  it("verifies the chart binding then reads the separately governed no-store endpoint",async()=>{
    fetcher.mockResolvedValueOnce(response(record()));
    expect(await clinicalLabSpecimenContext(selection,org,"fixture-token")).toEqual(record());
    const [url,init]=fetcher.mock.calls[1];
    expect(url).toBe(`https://abcdefghij.execute-api.us-east-2.amazonaws.com/clinical-core/workforce/labs/specimen-context?eventId=${id(3)}`);
    expect(init).toMatchObject({method:"GET",cache:"no-store",redirect:"error",headers:{Authorization:"Bearer fixture-token"}});
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({args:{_patient_id:id(1),_organization_id:org}});
  });
  it("distinguishes an absent context from an unavailable service",async()=>{
    fetcher.mockResolvedValueOnce(response(null));
    expect(await clinicalLabSpecimenContext(selection,org,"token")).toBeNull();
  });
  it.each([401,403,503])("preserves refusal %s without interpreting it as no shared context",async status=>{
    fetcher.mockResolvedValueOnce(response({private:"must not escape"},status));
    await expect(clinicalLabSpecimenContext(selection,org,"token")).rejects.toMatchObject({
      code:status===401?"unauthenticated":status===403?"forbidden":"unavailable",
    });
  });
  it.each(["chart","observation","duplicate"] as const)("refuses mismatched %s binding before context read",async kind=>{
    fetcher.mockReset().mockResolvedValue(response(kind==="duplicate"
      ?[{id:id(2),import_event_id:id(3)},{id:id(2),import_event_id:id(3)}]
      :[{id:kind==="observation"?id(9):id(2),import_event_id:kind==="chart"?id(9):id(3)}]));
    await expect(clinicalLabSpecimenContext(selection,org,"token")).rejects.toMatchObject({code:"not_found"});
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each(["event","date","verified","birthDate","missing"] as const)("refuses invalid %s context",async kind=>{
    const r=record();
    if(kind==="event")r.labEventId=id(9);
    if(kind==="date")r.context.observedOn="2026-09-14";
    if(kind==="verified")r.context.verification="verified";
    if(kind==="birthDate")Object.assign(r.context,{dateOfBirth:"1986-01-01"});
    fetcher.mockResolvedValueOnce(response(kind==="missing"?{}:r));
    await expect(clinicalLabSpecimenContext(selection,org,"token")).rejects.toMatchObject({code:"unavailable"});
  });
  it("refuses missing auth, invalid IDs and unapproved origins before any fetch",async()=>{
    await expect(clinicalLabSpecimenContext(selection,org,null)).rejects.toMatchObject({code:"unauthenticated"});
    await expect(clinicalLabSpecimenContext({...selection,eventId:"not-uuid"},org,"token")).rejects.toMatchObject({code:"invalid"});
    vi.stubEnv("CLINICAL_AWS_WORKFORCE_API_ORIGIN","https://unapproved.example");
    await expect(clinicalLabSpecimenContext(selection,org,"token")).rejects.toMatchObject({code:"unavailable"});
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not relay malformed or overlarge responses",async()=>{
    fetcher.mockResolvedValueOnce(new Response("x".repeat(65537)));
    await expect(clinicalLabSpecimenContext(selection,org,"token")).rejects.toMatchObject({code:"unavailable"});
  });
});
