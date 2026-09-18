import {beforeEach,describe,it,expect,vi} from "vitest";
import {NextRequest} from "next/server";
const session=vi.hoisted(()=>vi.fn());
const reader=vi.hoisted(()=>vi.fn());
vi.mock("@/server/session",()=>({getRequestSession:session}));
vi.mock("@/adapters/aws-clinical-data.server",()=>({clinicalLabSpecimenContext:reader}));
vi.mock("@/adapters/mode",()=>({USE_LIVE_API:true}));
import {POST} from "./route";
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const selection={patientId:id(1),observationId:id(2),eventId:id(3)};
const req=(body:unknown)=>new NextRequest("https://desktop.example/api/live/labs/specimen-context",{
  method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),
});
beforeEach(()=>{session.mockReset();reader.mockReset();session.mockResolvedValue({signedIn:true,token:"fixture-token",orgId:id(4)});reader.mockResolvedValue(null);});
describe("read-only specimen route identity boundary",()=>{
  it("takes authority from the session, not request-supplied organization or credentials",async()=>{
    const response=await POST(req(selection));
    expect(response.status).toBe(200);expect(await response.json()).toEqual({data:null});
    expect(reader).toHaveBeenCalledWith(selection,id(4),"fixture-token");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("does not call the clinical reader while signed out",async()=>{
    session.mockResolvedValue({signedIn:false,token:null,orgId:null});
    const response=await POST(req(selection));
    expect(response.status).toBe(401);expect(reader).not.toHaveBeenCalled();
  });
  it.each([{...selection,eventId:"invalid"},{...selection,orgId:id(9)},{...selection,token:"other"},{...selection,approve:true}])("refuses unexpected or malformed input %j",async body=>{
    expect((await POST(req(body))).status).toBe(400);expect(reader).not.toHaveBeenCalled();
  });
});
