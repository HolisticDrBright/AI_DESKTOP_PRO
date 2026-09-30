import { z } from 'zod';
/**
 * External calendar connection: the practitioner's authorization to have their busy
 * time read, and the operations on it.
 *
 * Two shapes carry secrets and neither is ever a plain string here. A sealed
 * envelope names the connection it was sealed to, so a ciphertext that arrives for
 * the wrong connection fails to open rather than being used. The authorization
 * state travels as a digest, because the value it is compared against should not
 * be recoverable from a stored row or a log line.
 *
 * Nothing in this contract can carry an event title, a guest list or a location.
 * Busy time is an interval, and that is all the product needs.
 */
export const EXTERNAL_CALENDAR_ACK = 'external-calendar/1' as const;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.string().regex(/^[1-9][0-9]{0,18}$/);
const base64 = (length: number) => z.string().regex(new RegExp(`^[A-Za-z0-9+/=]{${length}}$`));
export const sealedEnvelope = z.object({
  ciphertext: z.string().min(1).max(8192),
  iv: base64(16), tag: base64(24),
  connectionId: z.string().uuid(),
}).strict();
export const calendarScopes = z.array(z.string().url().startsWith('https://')).min(1).max(8);
export const calendarIds = z.array(z.string().trim().min(1).max(320)).max(10);
export const calendarConnectionState = z.enum(['disconnected', 'pending_authorization', 'connected', 'revoked', 'expired']);
/** The states a provider outcome may move a connection to. `disconnected` is the owner's act, not the provider's. */
export const recordableCalendarState = z.enum(['connected', 'expired', 'revoked']);

export const externalCalendarRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('read') }).strict(),
  z.object({
    action: z.literal('begin'), stateDigest: digest, scopes: calendarScopes,
    // The verifier is sealed before it reaches the database; it is the proof the
    // exchange needs and is useless to anyone who reads the row.
    verifier: sealedEnvelope.omit({ connectionId: true }).strict(),
  }).strict(),
  z.object({ action: z.literal('pending'), stateDigest: digest }).strict(),
  z.object({
    action: z.literal('complete'), expectedRevision: revision, scopes: calendarScopes,
    refresh: sealedEnvelope.omit({ connectionId: true }).strict().nullable(),
    expiresAt: z.string().datetime({ offset: true }),
  }).strict(),
  z.object({ action: z.literal('material') }).strict(),
  z.object({
    action: z.literal('record_state'), expectedRevision: revision, state: recordableCalendarState,
    refresh: sealedEnvelope.omit({ connectionId: true }).strict().nullish(),
    expiresAt: z.string().datetime({ offset: true }).nullish(),
  }).strict(),
  z.object({ action: z.literal('set_calendars'), expectedRevision: revision, calendarIds }).strict(),
  z.object({ action: z.literal('disconnect'), expectedRevision: revision }).strict(),
]);
export type ExternalCalendarRequest = z.infer<typeof externalCalendarRequest>;

/**
 * What a browser may ask for. Deliberately narrower than the stored contract: a page
 * cannot name an authorization state, supply a verifier, hand over a sealed token or
 * record a provider outcome. `start` asks the server to begin an authorization; the
 * server invents the state and the verifier itself.
 */
export const externalCalendarBrowserRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('read') }).strict(),
  z.object({ action: z.literal('start') }).strict(),
  z.object({ action: z.literal('set_calendars'), expectedRevision: revision, calendarIds }).strict(),
  z.object({ action: z.literal('disconnect'), expectedRevision: revision }).strict(),
]);
export type ExternalCalendarBrowserRequest = z.infer<typeof externalCalendarBrowserRequest>;

const connectionShape = {
  connectionId: z.string().uuid(), state: calendarConnectionState, revision,
};
export const externalCalendarResponse = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('read'), state: calendarConnectionState, connected: z.boolean(),
    connectionId: z.string().uuid().optional(), provider: z.literal('google').optional(),
    scopes: calendarScopes.optional(), calendarIds: calendarIds.optional(),
    hasRefreshToken: z.boolean().optional(), expiresAt: z.string().datetime({ offset: true }).nullish(),
    revision: revision.optional(),
  }).strict(),
  z.object({ action: z.literal('begin'), connectionId: z.string().uuid(), revision }).strict(),
  z.object({
    action: z.literal('pending'), connectionId: z.string().uuid(), revision,
    verifier: sealedEnvelope, scopes: calendarScopes,
  }).strict(),
  z.object({ ...connectionShape, action: z.literal('complete'), expiresAt: z.string().datetime({ offset: true }) }).strict(),
  z.object({
    ...connectionShape, action: z.literal('material'),
    expiresAt: z.string().datetime({ offset: true }).nullable(), refresh: sealedEnvelope,
  }).strict(),
  z.object({ ...connectionShape, action: z.literal('record_state'), hasRefreshToken: z.boolean() }).strict(),
  z.object({ ...connectionShape, action: z.literal('set_calendars'), calendarIds }).strict(),
  z.object({ ...connectionShape, action: z.literal('disconnect'), hasRefreshToken: z.literal(false) }).strict(),
]);
export type ExternalCalendarResponse = z.infer<typeof externalCalendarResponse>;

export function parseExternalCalendarResponse(input: ExternalCalendarRequest, value: unknown): ExternalCalendarResponse {
  const result = externalCalendarResponse.parse(value);
  if (result.action !== input.action) throw new Error('external_calendar_response_mismatch');
  // A sealed envelope that names a different connection than the reply does is not
  // this connection's material, and opening it would be the caller's mistake to make.
  if (result.action === 'pending' && result.verifier.connectionId !== result.connectionId) {
    throw new Error('external_calendar_response_mismatch');
  }
  if (result.action === 'material' && result.refresh.connectionId !== result.connectionId) {
    throw new Error('external_calendar_response_mismatch');
  }
  if (result.action === 'disconnect' && result.state !== 'disconnected') {
    throw new Error('external_calendar_response_mismatch');
  }
  return result;
}

/** What the browser gets back when it asks the server to start an authorization. */
export const externalCalendarStarted = z.object({
  action: z.literal('start'),
  authorizationUrl: z.string().url().startsWith('https://'),
  connectionId: z.string().uuid(),
}).strict();
export type ExternalCalendarStarted = z.infer<typeof externalCalendarStarted>;
