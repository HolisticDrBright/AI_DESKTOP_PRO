/**
 * PATIENT-APP SYNCHRONIZATION PROVIDER BOUNDARY (phase 5).
 *
 * The typed contract a future AI Longevity Pro synchronization integration
 * must implement. This repository ships NO implementation:
 * `resolvePatientSyncProvider` always returns null, the database refuses
 * independently (queueing and worker claiming both require a registered,
 * CONNECTED `alp_patient_sync` connector row), and the UI renders
 * "AI Longevity Pro connection not configured".
 *
 * The durable contract an implementation plugs into:
 *   1. `queue_sync_export` builds the minimum-necessary envelope server-side
 *      (unique idempotency key, payload hash) and marks it `queued` — NEVER
 *      delivered.
 *   2. The sync worker claims envelopes via `claim_sync_outbound`
 *      (service_role; refuses without the connector), hands them to the
 *      provider, and reports evidence through `record_sync_delivery`: every
 *      callback carries a provider-unique event id (replays dedupe), the
 *      projection only moves forward (queued → sending → delivered →
 *      acknowledged), retryable failures back off boundedly (2^n minutes,
 *      capped at 24h), and the attempt threshold dead-letters with a real
 *      review task.
 *   3. Inbound patient submissions enter ONLY through `record_sync_inbound`
 *      (service_role) after the worker verifies the provider signature
 *      (constant-time comparison, replay window) — recording the key id used.
 *   4. `delivered`/`acknowledged` are ONLY ever set from that evidence — no
 *      delivery claim exists without provider acknowledgment.
 *
 * No environment flag is treated as approval: wiring a real provider is a
 * reviewed code change PLUS the database-side connector registration.
 * This module is type-level only; importing it never contacts anything.
 */
import type {
  PatientSyncInboundEnvelopeV1,
  PatientSyncOutboundEnvelopeV1,
} from "./live-types";

export interface PatientSyncDeliveryEvidence {
  /** Provider-assigned unique id for THIS evidence event. */
  providerEventId: string;
  kind: "delivered" | "acknowledged" | "failed" | "rejected";
  occurredAt: string;
  errorSafe: string | null;
}

export interface PatientSyncProvider {
  readonly name: string;
  readonly contractVersion: "patient-sync/1";
  /** Hand one claimed envelope to the patient app side. Idempotent per key. */
  deliver(envelope: PatientSyncOutboundEnvelopeV1): Promise<PatientSyncDeliveryEvidence>;
  /**
   * Verify + normalize a signed inbound callback. MUST verify the signature
   * with a constant-time comparison against the key identified by keyId and
   * enforce the replay window BEFORE returning an envelope.
   */
  parseInbound(rawBody: string, signature: string | null, keyId: string | null): PatientSyncInboundEnvelopeV1;
}

/**
 * Provider resolution. There is deliberately no registry to populate and no
 * environment variable that could enable a fixture provider in a deployed
 * clinical build — wiring AI Longevity Pro is a reviewed code change plus an
 * `alp_patient_sync` connector registration in the database.
 */
export function resolvePatientSyncProvider(): PatientSyncProvider | null {
  return null;
}
