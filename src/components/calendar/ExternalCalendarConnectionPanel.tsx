'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {externalCalendarBusySynced,externalCalendarStarted,parseExternalCalendarResponse,type ExternalCalendarBrowserRequest,type ExternalCalendarBusySynced,type ExternalCalendarResponse,type ExternalCalendarStarted} from '@/contracts/externalCalendar';
import {onWorkforceSessionChange} from '@/lib/workforce-session-change';

type Read=Extract<ExternalCalendarResponse,{action:'read'}>;

/**
 * Connecting a practitioner's own external calendar so their busy time is respected
 * when appointments are booked.
 *
 * What this panel promises is what the connector actually enforces: read-only access,
 * busy intervals only, and no event titles, guests or locations stored anywhere. It
 * says so on the screen because a practitioner consenting to a calendar read deserves
 * to know the shape of what is read, not just that something is.
 *
 * Loading, empty, failed and "needs re-authorisation" are four different states here.
 * Collapsing any of them would tell someone their calendar is being respected when it
 * is not — which is worse than saying nothing, because they would stop checking.
 */
const OUTCOMES:Record<string,string>={
 connected:'Calendar connected. Only busy times are read.',
 declined:'You declined the calendar permission. Nothing was connected.',
 scope_refused:'That authorization granted more than read-only access, so it was refused. Nothing was connected.',
 not_configured:'No calendar provider is configured for this environment yet.',
 reauth_required:'Your session had expired, so nothing was connected. Sign in and try again.',
 failed:'The calendar connection could not be completed. Nothing was connected.',
};

export function ExternalCalendarConnectionPanel(){
 const [connection,setConnection]=useState<Read|null>(null);
 const [loading,setLoading]=useState(true);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const [notice,setNotice]=useState('');
 const [calendars,setCalendars]=useState('');
 const working=useRef(false),epoch=useRef(0),alive=useRef(true);

 const clear=useCallback(()=>{epoch.current++;working.current=false;setBusy(false);setConnection(null);setNotice('');},[]);

 const run=useCallback(async(input:ExternalCalendarBrowserRequest):Promise<ExternalCalendarResponse|ExternalCalendarStarted|ExternalCalendarBusySynced|null>=>{
  if(working.current)return null;
  working.current=true;setBusy(true);setError('');setNotice('');
  const generation=epoch.current;
  try{
   const response=await fetch('/api/live/calendar-connection',{method:'POST',credentials:'same-origin',cache:'no-store',
    headers:{'content-type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(25000)});
   if(!alive.current||epoch.current!==generation)return null;
   if(!response.ok){
    if(response.status===401||response.status===403){clear();setError('Access changed. Sign in and check your clinic access before trying again.');return null;}
    // 409 is the server refusing on purpose: not configured, or an attempt that is no
    // longer the current one. Neither is a failure to retry blindly.
    if(response.status===409){setError('Refused. Either no calendar provider is configured here, or that authorization is no longer current. Nothing changed.');return null;}
    throw new Error('refused');
   }
   const payload=(await response.json()).data;
   if(!alive.current||epoch.current!==generation)return null;
   // `start` is this route's own answer, not one of the stored contract's replies.
   if(input.action==='start')return externalCalendarStarted.parse(payload);
   if(input.action==='sync_busy')return externalCalendarBusySynced.parse(payload);
   return parseExternalCalendarResponse(input,payload);
  }catch{
   if(alive.current&&epoch.current===generation)setError('The calendar service could not be reached. Nothing changed.');
   return null;
  }finally{
   if(alive.current&&epoch.current===generation){working.current=false;setBusy(false);}
   else working.current=false;
  }
 },[clear]);

 const refresh=useCallback(async()=>{
  const data=await run({action:'read'});
  if(data&&data.action==='read'){setConnection(data);setCalendars((data.calendarIds??[]).join(', '));}
  setLoading(false);
 },[run]);

 useEffect(()=>{
  alive.current=true;const lifecycleEpoch=epoch;
  const outcome=new URLSearchParams(window.location.search).get('calendar');
  if(outcome&&OUTCOMES[outcome])setNotice(OUTCOMES[outcome]);
  void refresh();
  const stop=onWorkforceSessionChange(()=>{clear();setError('Session changed. Refresh the calendar connection.');});
  return()=>{alive.current=false;lifecycleEpoch.current++;stop();};
 },[clear,refresh]);

 async function connect(){
  const data=await run({action:'start'});
  if(data&&data.action==='start')window.location.assign(data.authorizationUrl);
  else if(!error)setError('No authorization address came back, so nothing was started.');
 }

 async function disconnect(){
  if(!connection?.revision)return;
  const data=await run({action:'disconnect',expectedRevision:connection.revision});
  if(data&&data.action==='disconnect'){setNotice('Calendar disconnected. The stored authorization was erased.');void refresh();}
 }

 async function refreshBusy(){
  // The window the booking screen works in. Busy time only answers for a window it was
  // read for, so the same bounds are used here and in the refusal.
  const from=new Date();from.setHours(0,0,0,0);
  const to=new Date(from.getTime()+14*86_400_000);
  const data=await run({action:'sync_busy',windowFrom:from.toISOString(),windowTo:to.toISOString()});
  if(data&&data.action==='sync_busy'){
   setNotice(data.complete
    ? `Busy time refreshed for the next two weeks: ${data.stored} busy period${data.stored===1?'':'s'}.`
    : `Refreshed, but ${data.unavailableCalendars} calendar${data.unavailableCalendars===1?'':'s'} could not be read. `
      +'Until every chosen calendar answers, bookings will not be confirmed against this one.');
   void refresh();
  }
 }

 async function saveCalendars(){
  if(!connection?.revision)return;
  const ids=calendars.split(',').map(value=>value.trim()).filter(value=>value.length>0).slice(0,10);
  const data=await run({action:'set_calendars',expectedRevision:connection.revision,calendarIds:ids});
  if(data&&data.action==='set_calendars'){setNotice('Saved which calendars are read for busy time.');void refresh();}
 }

 const state=connection?.state??'disconnected';
 const needsAuthorization=state==='revoked'||(state==='expired'&&connection?.hasRefreshToken===false);

 return (
  <section data-testid="external-calendar-connection" className="rounded-lg border border-slate-200 bg-white p-4">
   <h2 className="text-sm font-semibold text-slate-900">Your external calendar</h2>
   <p className="mt-1 text-xs text-slate-600">
    Read-only. Only the times you are busy are read — never event titles, guests or locations, and
    nothing is ever written to your calendar.
   </p>

   {loading&&<p data-testid="external-calendar-loading" className="mt-3 text-xs text-slate-500">Checking your calendar connection…</p>}

   {!loading&&error&&(
    <p data-testid="external-calendar-error" role="alert" className="mt-3 text-xs text-rose-700">{error}</p>
   )}

   {!loading&&!error&&state==='disconnected'&&(
    <div data-testid="external-calendar-empty" className="mt-3">
     <p className="text-xs text-slate-600">No calendar is connected, so bookings are checked against this clinic&apos;s appointments only.</p>
     <button type="button" onClick={connect} disabled={busy}
      className="mt-2 rounded border border-slate-300 px-3 py-1 text-xs font-medium disabled:opacity-50">
      Connect a calendar
     </button>
    </div>
   )}

   {!loading&&!error&&state==='pending_authorization'&&(
    <p data-testid="external-calendar-pending" className="mt-3 text-xs text-amber-700">
     An authorization is in progress. If you did not finish it, start again — the previous attempt expires on its own.
    </p>
   )}

   {!loading&&!error&&needsAuthorization&&(
    <div data-testid="external-calendar-reauthorize" className="mt-3">
     <p className="text-xs text-amber-700">
      This calendar needs authorizing again, so its busy time is <strong>not</strong> being read right now.
     </p>
     <button type="button" onClick={connect} disabled={busy}
      className="mt-2 rounded border border-slate-300 px-3 py-1 text-xs font-medium disabled:opacity-50">
      Authorize again
     </button>
    </div>
   )}

   {!loading&&!error&&state==='connected'&&(
    <div data-testid="external-calendar-connected" className="mt-3 space-y-2">
     <p className="text-xs text-emerald-700">Connected. Busy times are read when a booking is committed.</p>
     <label className="block text-xs text-slate-600">
      Calendars to read (comma separated, up to ten)
      <input value={calendars} onChange={event=>setCalendars(event.target.value)}
       className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs" />
     </label>
     <p className="text-xs text-slate-600">
      A booking is confirmed against busy time that has been read recently for the time in
      question. If it has not been, the booking is refused rather than guessed at.
     </p>
     <div className="flex gap-2">
      <button type="button" onClick={()=>{void refreshBusy();}} disabled={busy}
       className="rounded border border-slate-300 px-3 py-1 text-xs font-medium disabled:opacity-50"
       data-testid="external-calendar-refresh-busy">Refresh busy time</button>
      <button type="button" onClick={saveCalendars} disabled={busy}
       className="rounded border border-slate-300 px-3 py-1 text-xs font-medium disabled:opacity-50">Save calendars</button>
      <button type="button" onClick={disconnect} disabled={busy}
       className="rounded border border-rose-300 px-3 py-1 text-xs font-medium text-rose-700 disabled:opacity-50">Disconnect</button>
     </div>
    </div>
   )}

   {notice&&<p data-testid="external-calendar-notice" className="mt-3 text-xs text-slate-700">{notice}</p>}

   <button type="button" onClick={()=>{setLoading(true);void refresh();}} disabled={busy}
    className="mt-3 text-xs underline disabled:opacity-50">Refresh connection</button>
  </section>
 );
}
