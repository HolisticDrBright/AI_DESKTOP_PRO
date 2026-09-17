import {NextRequest,NextResponse} from 'next/server';
import {getRequestSession} from '@/server/session';
import {requestPrivacyOperation} from '@/server/clinical-core/privacy-operations-client';
import {PrivacyOperationError} from '@/server/clinical-core/privacy-operations';
import {privacyOperationSchema} from '@/contracts/privacyOperations';
import {liveGuard} from '../route-helpers';
export const dynamic='force-dynamic';
const json=(value:unknown,status=200)=>NextResponse.json(value,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
export async function POST(req:NextRequest){
  const blocked=liveGuard();if(blocked)return blocked;
  // Same-origin only, including reads: field-level correction evidence is private.
  const origin=req.headers.get('origin');
  if(origin!==req.nextUrl.origin||req.headers.get('sec-fetch-site')==='cross-site')return json({error:'privacy_access_refused'},403);
  if(!req.headers.get('content-type')?.toLowerCase().startsWith('application/json'))return json({error:'request_invalid'},400);
  const session=await getRequestSession();
  if(!session.token)return json({error:'reauth_required'},401);
  try{
    const text=await req.text();
    if(Buffer.byteLength(text)>10000)return json({error:'request_invalid'},413);
    let raw:unknown;try{raw=JSON.parse(text);}catch{return json({error:'request_invalid'},400);}
    const parsed=privacyOperationSchema.safeParse(raw);
    if(!parsed.success)return json({error:'request_invalid'},400);
    return json({data:await requestPrivacyOperation(session.token,parsed.data)});
  }catch(error){
    // Never log request bodies, database messages, tokens or field values.
    const code=error instanceof PrivacyOperationError?error.code:'service_unavailable';
    return json({error:code},code==='reauth_required'?401:code==='privacy_access_refused'||code==='legal_hold'?403:
      code==='conflict'?409:code==='request_invalid'?400:503);
  }
}
