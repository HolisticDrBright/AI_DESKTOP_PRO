import {describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {ALLOWED_CALENDAR_SCOPES,REQUIRED_CALENDAR_CONFIGURATION,assertReadOnlyScopes,bookingRefusal,
 calendarReadable,externalCalendarEnabled,mapBusyIntervals,nextStateAfterProviderError,
 type CalendarConnection} from './externalCalendarSync';

const WINDOW={start:'2026-10-01T00:00:00.000Z',end:'2026-10-02T00:00:00.000Z'};
const connection=(over:Partial<CalendarConnection>={}):CalendarConnection=>({state:'connected',
 scopes:['https://www.googleapis.com/auth/calendar.freebusy'],expiresAt:'2026-10-01T12:00:00.000Z',
 hasRefreshToken:true,...over});

describe('the connector never asks for write access',()=>{
 it('accepts only read-only scopes',()=>{
  for(const scope of ALLOWED_CALENDAR_SCOPES)expect(assertReadOnlyScopes([scope]),scope).toBeNull();
  expect(assertReadOnlyScopes([])).toBe('no_scope_requested');
  expect(assertReadOnlyScopes(['  '])).toBe('no_scope_requested');
 });
 it('refuses a write scope, and does not trust one that merely reads like a read',()=>{
  for(const scope of ['https://www.googleapis.com/auth/calendar',
   'https://www.googleapis.com/auth/calendar.events',
   'https://www.googleapis.com/auth/calendar.settings.readonly'])
   expect(assertReadOnlyScopes([scope]),scope).not.toBeNull();
  // calendar.events grants writes despite reading like a read, so it is a write refusal.
  expect(assertReadOnlyScopes(['https://www.googleapis.com/auth/calendar.events'])).toBe('write_scope_requested');
  // An unfamiliar read-looking scope is refused as unknown rather than allowed.
  expect(assertReadOnlyScopes(['https://www.googleapis.com/auth/tasks.readonly'])).toBe('unknown_scope_requested');
  // One bad scope among good ones still refuses.
  expect(assertReadOnlyScopes([ALLOWED_CALENDAR_SCOPES[0],'https://www.googleapis.com/auth/calendar'])).toBe('write_scope_requested');
 });
});

describe('busy time only, never what the appointment was',()=>{
 it('keeps bounded intervals, clamps them to the window and merges overlaps',()=>{
  const outcome=mapBusyIntervals([
   {start:'2026-10-01T09:00:00.000Z',end:'2026-10-01T10:00:00.000Z'},
   {start:'2026-10-01T09:30:00.000Z',end:'2026-10-01T11:00:00.000Z'},
   {start:'2026-09-30T23:00:00.000Z',end:'2026-10-01T01:00:00.000Z'},
  ],WINDOW);
  expect(outcome.busy).toEqual([
   {start:'2026-10-01T00:00:00.000Z',end:'2026-10-01T01:00:00.000Z'},
   {start:'2026-10-01T09:00:00.000Z',end:'2026-10-01T11:00:00.000Z'},
  ]);
  expect(outcome.discarded).toBe(0);
 });
 it('discards anything that is not a block of time, and counts it',()=>{
  const outcome=mapBusyIntervals([
   {start:'2026-10-01T09:00:00.000Z'},
   {end:'2026-10-01T09:00:00.000Z'},
   {start:'2026-10-01T10:00:00.000Z',end:'2026-10-01T09:00:00.000Z'},
   {start:'not-a-date',end:'2026-10-01T09:00:00.000Z'},
   {start:'2026-10-05T09:00:00.000Z',end:'2026-10-05T10:00:00.000Z'},
   null,'nonsense',
  ],WINDOW);
  expect(outcome.busy).toEqual([]);
  expect(outcome.discarded).toBe(7);
 });
 it('carries no event content, whatever the provider sent',()=>{
  const outcome=mapBusyIntervals([{start:'2026-10-01T09:00:00.000Z',end:'2026-10-01T10:00:00.000Z',
   summary:'Oncology follow-up',attendees:['someone@example.test'],description:'private'}as unknown],WINDOW);
  // A calendar title is often the most sensitive line in a person's day.
  const text=JSON.stringify(outcome);
  for(const forbidden of ['Oncology','attendees','summary','description','example.test'])
   expect(text,forbidden).not.toContain(forbidden);
  expect(Object.keys(outcome.busy[0]!)).toEqual(['start','end']);
 });
 it('refuses an unusable window rather than guessing one',()=>{
  for(const window of [{start:'x',end:WINDOW.end},{start:WINDOW.end,end:WINDOW.start},{start:WINDOW.start,end:WINDOW.start}])
   expect(mapBusyIntervals([{start:'2026-10-01T09:00:00.000Z',end:'2026-10-01T10:00:00.000Z'}],window))
    .toEqual({busy:[],discarded:1});
 });
});

describe('when the connection may be read',()=>{
 it('reads a live connection and refuses every other state',()=>{
  expect(calendarReadable(connection(),'2026-10-01T09:00:00.000Z')).toBeNull();
  for(const state of ['disconnected','pending_authorization'] as const)
   expect(calendarReadable(connection({state}),'2026-10-01T09:00:00.000Z'),state).toBe('not_connected');
  expect(calendarReadable(connection({state:'revoked'}),'2026-10-01T09:00:00.000Z')).toBe('revoked');
  expect(calendarReadable(connection({scopes:['https://www.googleapis.com/auth/calendar']}),'2026-10-01T09:00:00.000Z')).toBe('scope_invalid');
 });
 it('treats an expired token as recoverable only when a refresh token exists',()=>{
  const late='2026-10-01T13:00:00.000Z';
  expect(calendarReadable(connection(),late)).toBeNull();
  expect(calendarReadable(connection({hasRefreshToken:false}),late)).toBe('expired_without_refresh');
  expect(calendarReadable(connection({state:'expired',hasRefreshToken:false}),'2026-10-01T09:00:00.000Z')).toBe('expired_without_refresh');
  // Otherwise a revoked refresh silently produces an empty calendar, which reads as free.
  expect(calendarReadable(connection({state:'expired'}),'2026-10-01T09:00:00.000Z')).toBeNull();
 });
 it('stops using an authorisation the provider says is gone',()=>{
  expect(nextStateAfterProviderError(connection(),'invalid_grant')).toBe('revoked');
  expect(nextStateAfterProviderError(connection(),'unauthorized')).toBe('expired');
  // A transient failure is not a reason to drop the connection.
  for(const error of ['rate_limited','unavailable'] as const)
   expect(nextStateAfterProviderError(connection(),error),error).toBe('connected');
 });
});

describe('booking is checked at commit, not against what a screen showed',()=>{
 const busy=[{start:'2026-10-01T09:00:00.000Z',end:'2026-10-01T10:00:00.000Z'}];
 const request={requestId:'req-1',start:'2026-10-01T11:00:00.000Z',end:'2026-10-01T11:30:00.000Z'};
 it('permits a free slot and refuses any overlap',()=>{
  expect(bookingRefusal(request,busy,[])).toBeNull();
  for(const [start,end] of [['2026-10-01T09:15:00.000Z','2026-10-01T09:45:00.000Z'],
   ['2026-10-01T08:30:00.000Z','2026-10-01T09:30:00.000Z'],
   ['2026-10-01T09:30:00.000Z','2026-10-01T10:30:00.000Z'],
   ['2026-10-01T08:00:00.000Z','2026-10-01T11:00:00.000Z']])
   expect(bookingRefusal({...request,start,end},busy,[]),`${start}`).toBe('conflicts_with_busy');
  // Touching at the boundary is not an overlap.
  expect(bookingRefusal({...request,start:'2026-10-01T10:00:00.000Z',end:'2026-10-01T10:30:00.000Z'},busy,[])).toBeNull();
  expect(bookingRefusal({...request,start:'2026-10-01T08:30:00.000Z',end:'2026-10-01T09:00:00.000Z'},busy,[])).toBeNull();
 });
 it('is idempotent on the request id, so a retry cannot double-book',()=>{
  expect(bookingRefusal(request,busy,['req-1'])).toBe('already_booked');
  expect(bookingRefusal(request,busy,['req-2'])).toBeNull();
 });
 it('refuses a window it cannot read',()=>{
  for(const over of [{start:'nope'},{end:'nope'},{end:request.start}])
   expect(bookingRefusal({...request,...over},busy,[])).toBe('window_invalid');
 });
});

describe('configuration and posture',()=>{
 it('is disabled unless explicitly enabled',()=>{
  expect(externalCalendarEnabled({})).toBe(false);
  for(const value of ['','0','true','yes',' '])expect(externalCalendarEnabled({EXTERNAL_CALENDAR_ENABLED:value}),value).toBe(false);
  expect(externalCalendarEnabled({EXTERNAL_CALENDAR_ENABLED:'1'})).toBe(true);
 });
 it('names its configuration and holds no value',()=>{
  expect(REQUIRED_CALENDAR_CONFIGURATION).toContain('EXTERNAL_CALENDAR_CLIENT_SECRET_ARN');
  const source=readFileSync('src/server/calendar/externalCalendarSync.ts','utf8');
  // Credential-free: no client id, no secret, no token, no network call.
  for(const forbidden of ['apps.googleusercontent.com','client_secret=','fetch(','https://oauth2.googleapis.com/token'])
   expect(source,forbidden).not.toContain(forbidden);
 });
});
