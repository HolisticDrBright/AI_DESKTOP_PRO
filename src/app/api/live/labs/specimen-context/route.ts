import {NextRequest} from "next/server";
import {z} from "zod";
import {clinicalLabSpecimenContext} from "@/adapters/aws-clinical-data.server";
import {AdapterError} from "@/adapters/errors";
import {getRequestSession} from "@/server/session";
import {liveGuard,runLive} from "../../route-helpers";

/** Read-only POST bridge: identity and organization come from the server cookie. */
export async function POST(req:NextRequest){
  const blocked=liveGuard();if(blocked)return blocked;
  const result=await runLive(async()=>{
    const session=await getRequestSession();
    if(!session.signedIn||!session.token)throw new AdapterError("unauthenticated");
    const raw=await req.text();
    if(raw.length>2048)throw new AdapterError("invalid");
    let body:unknown;try{body=JSON.parse(raw);}catch{throw new AdapterError("invalid");}
    const parsed=z.object({patientId:z.string().uuid(),observationId:z.string().uuid(),eventId:z.string().uuid()}).strict().safeParse(body);
    if(!parsed.success)throw new AdapterError("invalid");
    return clinicalLabSpecimenContext(parsed.data,session.orgId,session.token);
  });
  result.headers.set("Cache-Control","private, no-store");
  return result;
}
