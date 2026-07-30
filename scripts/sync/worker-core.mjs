/**
 * The durable sync worker cycle — pure logic with injected dependencies so
 * every behavior is unit-testable without a network.
 *
 * One cycle:
 *   1. claim a bounded batch through the service-role lease RPC
 *      (SKIP LOCKED + lease expiry/reclaim live in PostgreSQL),
 *   2. per envelope: validate the patient-sync/1 DTO, RE-CHECK consent and
 *      connection state at delivery time, gate on the circuit breaker, hand
 *      the exact DTO to the provider adapter,
 *   3. record ONLY provider evidence through record_sync_delivery — nothing
 *      else can mark work delivered or acknowledged,
 *   4. classify failures (retryable backs off; permanent/contract/security
 *      dead-letter via 'rejected'; consent refusals were already durably
 *      cancelled by the recheck),
 *   5. record a PHI-free worker-cycle telemetry row.
 *
 * State authority stays in PostgreSQL: the worker holds no queue state in
 * memory beyond the current batch, so restarts lose nothing, duplicate
 * nothing, and can never falsely complete work.
 */
import { validateOutboundEnvelope } from "./contract.mjs";
import { SyncError, NON_RETRYABLE_CLASSES } from "./errors.mjs";

export async function runCycle({
  rpc,
  provider,
  circuit,
  logger,
  organizationId,
  batchSize = 10,
  leaseSeconds = 120,
  workerId = null,
  sleep = () => Promise.resolve(),
}) {
  const startedAt = new Date().toISOString();
  const stats = { claimed: 0, succeeded: 0, retried: 0, deadLettered: 0, cancelled: 0, leaseReclaims: 0 };
  let maxQueueAgeSeconds = 0;
  let lastErrorClass = null;

  const claim = await rpc("claim_sync_outbound", {
    _organization_id: organizationId,
    _limit: batchSize,
    _lease_seconds: leaseSeconds,
    _worker_id: workerId,
  });
  const events = claim.events ?? [];
  stats.claimed = events.length;
  stats.leaseReclaims = claim.leaseReclaims ?? 0;
  maxQueueAgeSeconds = claim.maxQueueAgeSeconds ?? 0;

  for (const raw of events) {
    let envelope;
    try {
      envelope = validateOutboundEnvelope(raw);
    } catch (e) {
      // A malformed envelope is a CONTRACT failure: reject to dead-letter.
      await rpc("record_sync_delivery", {
        _event_uid: raw.eventUid,
        _provider_event_id: `worker-contract-${raw.eventUid}`,
        _kind: "rejected",
        _occurred_at: new Date().toISOString(),
        _error_safe: `contract violation: ${e.code ?? "invalid_envelope"}`,
      });
      stats.deadLettered += 1;
      lastErrorClass = "contract";
      logger.log("envelope_rejected", { eventUid: raw.eventUid, errorClass: "contract", errorCode: e.code });
      continue;
    }

    // Consent/connection/supersession re-checked AT DELIVERY TIME. A refusal
    // here is a durable cancellation made by the database, not the worker.
    const recheck = await rpc("recheck_sync_export", { _event_uid: envelope.eventUid });
    if (!recheck.deliverable) {
      stats.cancelled += 1;
      logger.log("delivery_recheck_refused", { eventUid: envelope.eventUid, reason: recheck.reason });
      continue;
    }

    if (!circuit.canAttempt()) {
      // Leave the lease to expire; the claim RPC reclaims it safely later.
      logger.log("circuit_open_skip", { eventUid: envelope.eventUid, circuitState: circuit.state });
      lastErrorClass = lastErrorClass ?? "retryable";
      continue;
    }

    try {
      const result = await provider.deliver(envelope);
      for (const ev of result.evidence ?? []) {
        await rpc("record_sync_delivery", {
          _event_uid: envelope.eventUid,
          _provider_event_id: ev.providerEventId,
          _kind: ev.kind,
          _occurred_at: ev.occurredAt,
        });
      }
      circuit.onSuccess();
      stats.succeeded += 1;
      logger.log("envelope_delivered", { eventUid: envelope.eventUid, attempts: envelope.attempts });
    } catch (e) {
      const errorClass = e instanceof SyncError ? e.errorClass : "retryable";
      const errorCode = e instanceof SyncError ? e.code : "unknown";
      lastErrorClass = errorClass;
      if (NON_RETRYABLE_CLASSES.includes(errorClass)) {
        // Invalid signatures, wrong tenant/connection, contract violations,
        // and permanent rejections are NEVER retried.
        await rpc("record_sync_delivery", {
          _event_uid: envelope.eventUid,
          _provider_event_id: `worker-${errorClass}-${envelope.eventUid}-${envelope.attempts}`,
          _kind: "rejected",
          _occurred_at: new Date().toISOString(),
          _error_safe: `${errorClass}: ${errorCode}`,
        });
        stats.deadLettered += 1;
        circuit.onFailure();
        logger.log("envelope_dead_lettered", { eventUid: envelope.eventUid, errorClass, errorCode });
      } else {
        await rpc("record_sync_delivery", {
          _event_uid: envelope.eventUid,
          _provider_event_id: `worker-retry-${envelope.eventUid}-${envelope.attempts}`,
          _kind: "failed",
          _occurred_at: new Date().toISOString(),
          _error_safe: `retryable: ${errorCode}`,
        });
        stats.retried += 1;
        circuit.onFailure();
        logger.log("envelope_retryable_failure", { eventUid: envelope.eventUid, errorClass, errorCode });
        // Respect provider pacing (Retry-After) inside the cycle.
        if (e.retryAfterMs) await sleep(e.retryAfterMs);
      }
    }
  }

  await rpc("record_sync_worker_cycle", {
    _organization_id: organizationId,
    _provider: provider.name,
    _started_at: startedAt,
    _claimed: stats.claimed,
    _succeeded: stats.succeeded,
    _retried: stats.retried,
    _dead_lettered: stats.deadLettered,
    _cancelled: stats.cancelled,
    _lease_reclaims: stats.leaseReclaims,
    _circuit_state: circuit.state,
    _error_class: lastErrorClass,
    _max_queue_age_seconds: maxQueueAgeSeconds,
    _worker_id: workerId,
  });
  logger.log("cycle_completed", {
    provider: provider.name,
    contractVersion: provider.contractVersion,
    ...stats,
    circuitState: circuit.state,
    errorClass: lastErrorClass,
    maxQueueAgeSeconds,
  });
  return stats;
}
